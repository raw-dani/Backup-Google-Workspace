const express = require('express');
const { query } = require('../services/database/databaseService');
const { pstExportService } = require('../services/pst/pstExportService');
const { authenticateToken } = require('./auth');
const winston = require('winston');

const router = express.Router();
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/exports.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// All routes require authentication
router.use(authenticateToken);

// Create new export
router.post('/', async (req, res) => {
  try {
    const { userId, startDate, endDate, format = 'eml' } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Validate user exists
    const users = await query('SELECT id, email FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Validate date range
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ error: 'startDate must be before endDate' });
    }

    // Validate format
    if (!['eml', 'pst'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format. Use "eml" or "pst"' });
    }

    // Get email count for user (to estimate processing time)
    let emailCountQuery = 'SELECT COUNT(*) as count FROM emails WHERE user_id = ?';
    let emailCountParams = [userId];

    if (startDate && endDate) {
      emailCountQuery += ' AND date BETWEEN ? AND ?';
      emailCountParams.push(startDate, endDate);
    }

    const emailCountResult = await query(emailCountQuery, emailCountParams);
    const emailCount = emailCountResult[0].count;

    logger.info('Creating export', {
      userId,
      emailCount,
      startDate,
      endDate,
      format,
      admin: req.user.username
    });

    // Check if there are emails to export
    if (emailCount === 0) {
      let message = 'No emails found for this user';
      if (startDate && endDate) {
        message = `No emails found for the date range ${startDate} to ${endDate}. Total emails for this user: 0`;
      } else {
        // Get total emails for this user
        const totalEmailsResult = await query('SELECT COUNT(*) as count FROM emails WHERE user_id = ?', [userId]);
        const totalEmails = totalEmailsResult[0].count;
        if (totalEmails > 0) {
          // Get date range of existing emails
          const dateRangeResult = await query(
            'SELECT MIN(date) as minDate, MAX(date) as maxDate FROM emails WHERE user_id = ?',
            [userId]
          );
          const minDate = dateRangeResult[0].minDate;
          const maxDate = dateRangeResult[0].maxDate;
          message = `No emails found for the selected date range. This user has ${totalEmails} emails in total, spanning from ${minDate ? new Date(minDate).toISOString().split('T')[0] : 'unknown'} to ${maxDate ? new Date(maxDate).toISOString().split('T')[0] : 'unknown'}. Please adjust your date range.`;
        } else {
          message = 'This user has no emails in the system. Please run a backup for this user first.';
        }
      }
      return res.status(400).json({ error: message });
    }

    // Create export (uses new format-aware method)
    const exportId = await pstExportService.createExport(userId, startDate, endDate, format);

    // Log audit
    await logAuditAction(req.user.id, 'create_export', 'pst_exports', exportId, req.ip);

    logger.info('Export queued successfully', {
      exportId,
      userId,
      emailCount,
      format,
      admin: req.user.username
    });

    // Return success response with estimated processing info
    const estimatedTime = Math.ceil(emailCount / 50);
    const message = emailCount > 100
      ? `Export queued successfully. Processing ${emailCount} emails may take ~${estimatedTime} minutes.`
      : `Export queued successfully. Processing ${emailCount} emails.`;

    res.status(201).json({
      exportId,
      message,
      estimatedEmails: emailCount,
      estimatedTimeMinutes: estimatedTime,
      format,
      status: 'queued'
    });
  } catch (error) {
    logger.error('Failed to create export', { 
      error: error.message,
      stack: error.stack,
      name: error.name
    });
    // Return more detailed error in development
    if (process.env.NODE_ENV === 'development') {
      res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message,
        stack: error.stack 
      });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Get all exports
router.get('/', async (req, res) => {
  try {
    const { userId, status, page = 1, limit = 20 } = req.query;

    let queryStr = 'SELECT * FROM pst_exports WHERE 1=1';
    const params = [];

    if (userId) {
      queryStr += ' AND user_id = ?';
      params.push(userId);
    }

    if (status) {
      queryStr += ' AND status = ?';
      params.push(status);
    }

    queryStr += ' ORDER BY created_at DESC';
    const limitValue = parseInt(limit);
    const offsetValue = (parseInt(page) - 1) * limitValue;

    // MySQL doesn't support parameterized LIMIT/OFFSET, so we use template literals for these values
    queryStr += ` LIMIT ${limitValue} OFFSET ${offsetValue}`;

    const exports = await query(queryStr, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM pst_exports WHERE 1=1';
    const countParams = [];
    if (userId) {
      countQuery += ' AND user_id = ?';
      countParams.push(userId);
    }
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    const totalResult = await query(countQuery, countParams);
    const total = totalResult[0].total;

    res.json({
      exports,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to get exports', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get export by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const exportData = await pstExportService.getExportStatus(id);
    if (!exportData) {
      return res.status(404).json({ error: 'Export not found' });
    }

    res.json({ export: exportData });
  } catch (error) {
    logger.error('Failed to get export', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download PST file
router.get('/:id/download', async (req, res) => {
  try {
    const { id } = req.params;

    const exportData = await pstExportService.getExportStatus(id);
    if (!exportData) {
      return res.status(404).json({ error: 'Export not found' });
    }

    if (exportData.status !== 'completed') {
      return res.status(400).json({ error: 'Export is not ready for download' });
    }

    if (!exportData.file_path) {
      return res.status(404).json({ error: 'PST file not found' });
    }

    // Check if file exists
    const fs = require('fs').promises;
    try {
      await fs.access(exportData.file_path);
    } catch (error) {
      return res.status(404).json({ error: 'PST file not found on disk' });
    }

    // Log audit
    await logAuditAction(req.user.id, 'download_pst', 'pst_exports', id, req.ip);

    logger.info('PST download', {
      exportId: id,
      filename: exportData.filename,
      admin: req.user.username
    });

    // Stream file
    res.setHeader('Content-Type', 'application/vnd.ms-outlook');
    res.setHeader('Content-Disposition', `attachment; filename="${exportData.filename}"`);

    const fileStream = require('fs').createReadStream(exportData.file_path);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      logger.error('Error streaming PST file', { exportId: id, error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error downloading file' });
      }
    });
  } catch (error) {
    logger.error('Failed to download PST', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete export
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pstExportService.deleteExport(id);

    // Log audit
    await logAuditAction(req.user.id, 'delete_pst_export', 'pst_exports', id, req.ip);

    logger.info('PST export deleted', { exportId: id, admin: req.user.username });

    res.json({ message: 'Export deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete export', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get export statistics
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await query(`
      SELECT
        COUNT(*) as total_exports,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_exports,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_exports,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_exports,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_exports,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
        AVG(CASE WHEN status = 'completed' THEN TIMESTAMPDIFF(MINUTE, created_at, completed_at) END) as avg_processing_time
      FROM pst_exports
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);

    // Get queue status with timeout
    let queueStatus;
    try {
      queueStatus = await Promise.race([
        pstExportService.getQueueStatus(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Queue status timeout')), 5000)
        )
      ]);
    } catch (queueError) {
      logger.warn('Queue status unavailable', { error: queueError.message });
      queueStatus = {
        available: false,
        message: 'Queue unavailable',
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        totalPending: 0,
      };
    }

    // Get failed exports with timeout
    let failedExports = [];
    try {
      failedExports = await Promise.race([
        pstExportService.getFailedExports(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Failed exports timeout')), 5000)
        )
      ]);
    } catch (failedError) {
      logger.warn('Failed exports unavailable', { error: failedError.message });
      failedExports = [];
    }

    res.json({
      stats: stats[0],
      queue: queueStatus,
      recentFailed: failedExports.slice(0, 5),
    });
  } catch (error) {
    logger.error('Failed to get export stats', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Retry failed export
router.post('/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;

    const exportData = await pstExportService.getExportStatus(id);
    if (!exportData) {
      return res.status(404).json({ error: 'Export not found' });
    }

    if (exportData.status !== 'failed') {
      return res.status(400).json({ error: 'Only failed exports can be retried' });
    }

    // Reset status and create new export
    await query(
      'UPDATE pst_exports SET status = ?, completed_at = NULL, file_path = NULL WHERE id = ?',
      ['pending', id]
    );

    // Re-queue the export with original format
    const newExportId = await pstExportService.createExport(
      exportData.user_id,
      exportData.start_date,
      exportData.end_date,
      exportData.export_format || 'eml'
    );

    // Log audit
    await logAuditAction(req.user.id, 'retry_pst_export', 'pst_exports', id, req.ip);

    logger.info('PST export retried', {
      oldExportId: id,
      newExportId,
      admin: req.user.username
    });

    res.json({
      message: 'Export retry queued',
      newExportId,
    });
  } catch (error) {
    logger.error('Failed to retry export', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Audit logging helper
async function logAuditAction(adminUserId, action, resource, resourceId, ipAddress) {
  try {
    await query(
      'INSERT INTO audit_logs (admin_user_id, action, resource, resource_id, ip_address) VALUES (?, ?, ?, ?, ?)',
      [adminUserId, action, resource, resourceId, ipAddress]
    );
  } catch (error) {
    logger.error('Failed to log audit action', { error: error.message });
  }
}

module.exports = router;
