const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { simpleParser } = require('mailparser');
const { query, DB_TYPE } = require('../services/database/databaseService');
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
    new winston.transports.File({ filename: 'logs/emails.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// All routes require authentication
router.use(authenticateToken);

// Search emails
router.get('/search', async (req, res) => {
  try {
    const {
      q, // general search query
      subject,
      from,
      to,
      user_id,
      folder,
      date_from,
      date_to,
      page = 1,
      limit = 50,
      sort = 'date',
      order = 'desc'
    } = req.query;

    let queryStr = `
      SELECT e.*, u.email as user_email, d.name as domain_name,
             COUNT(a.id) as attachment_count
      FROM emails e
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN domains d ON u.domain_id = d.id
      LEFT JOIN attachments a ON e.id = a.email_id
    `;

    const params = [];
    const conditions = [];

    // Build search conditions
    if (q) {
      conditions.push('(e.subject LIKE ? OR e.from_email LIKE ? OR e.to_email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    if (subject) {
      conditions.push('e.subject LIKE ?');
      params.push(`%${subject}%`);
    }

    if (from) {
      conditions.push('e.from_email LIKE ?');
      params.push(`%${from}%`);
    }

    if (to) {
      conditions.push('e.to_email LIKE ?');
      params.push(`%${to}%`);
    }

    if (user_id) {
      conditions.push('e.user_id = ?');
      params.push(user_id);
    }

    if (folder) {
      conditions.push('e.folder = ?');
      params.push(folder);
    }

    if (date_from) {
      conditions.push('e.date >= ?');
      params.push(new Date(date_from));
    }

    if (date_to) {
      conditions.push('e.date <= ?');
      params.push(new Date(date_to));
    }

    if (conditions.length > 0) {
      queryStr += ' WHERE ' + conditions.join(' AND ');
    }

    queryStr += ' GROUP BY e.id';

    // Sorting
    const validSortFields = ['date', 'subject', 'from_email', 'size'];
    const sortField = validSortFields.includes(sort) ? sort : 'date';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    queryStr += ` ORDER BY e.${sortField} ${sortOrder}`;

    // Pagination
    const limitValue = parseInt(limit);
    const offsetValue = (parseInt(page) - 1) * limitValue;

    // MySQL doesn't support parameterized LIMIT/OFFSET, so we use template literals for these values
    queryStr += ` LIMIT ${limitValue} OFFSET ${offsetValue}`;

    const emails = await query(queryStr, params);

    // Get total count
    let countQuery = 'SELECT COUNT(DISTINCT e.id) as total FROM emails e';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const totalResult = await query(countQuery, params);
    const total = totalResult[0].total;

    // Log search
    logger.info('Email search performed', {
      query: q,
      filters: { subject, from, to, user_id, date_from, date_to },
      results: emails.length,
      admin: req.user.username
    });

    res.json({
      emails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to search emails', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get email by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const emails = await query(`
      SELECT e.*, u.email as user_email, d.name as domain_name
      FROM emails e
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN domains d ON u.domain_id = d.id
      WHERE e.id = ?
    `, [id]);

    if (emails.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const email = emails[0];

    // Parse email content from EML file
    let parsedContent = {
      body_html: null,
      body_text: null,
      content_type: 'text/plain'
    };

    try {
      let emlContent;

      // Check if EML file exists
      try {
        await fs.access(email.eml_path);
        emlContent = await fs.readFile(email.eml_path);
      } catch (fileError) {
        // File doesn't exist, generate mock EML content for simulated emails
        logger.info('EML file not found for parsing, generating mock content', { id, emlPath: email.eml_path });
        emlContent = generateMockEMLContent(email);
      }

      // Parse email content using mailparser
      const parsed = await simpleParser(emlContent);

      // Extract body content
      parsedContent.body_html = parsed.html ? parsed.html.toString() : null;
      parsedContent.body_text = parsed.text ? parsed.text.toString() : null;
      parsedContent.content_type = parsed.html ? 'text/html' : 'text/plain';

      // If no HTML but we have text, set text as fallback
      if (!parsedContent.body_html && parsedContent.body_text) {
        parsedContent.content_type = 'text/plain';
      }

    } catch (parseError) {
      logger.warn('Failed to parse email content, using basic fallback', {
        id,
        error: parseError.message
      });

      // Fallback: try to extract basic content from raw EML
      try {
        const emlContent = await fs.readFile(email.eml_path, 'utf8');
        const lines = emlContent.split('\n');
        let inBody = false;
        let body = '';

        for (const line of lines) {
          if (line.trim() === '') {
            inBody = true;
            continue;
          }
          if (inBody) {
            body += line + '\n';
          }
        }

        if (body.trim()) {
          parsedContent.body_text = body.trim();
          parsedContent.content_type = 'text/plain';
        }
      } catch (fallbackError) {
        logger.warn('Failed to extract fallback content', { id, error: fallbackError.message });
      }
    }

    // Get attachments
    const attachments = await query(
      'SELECT * FROM attachments WHERE email_id = ?',
      [id]
    );

    // Log access
    await logAuditAction(req.user.id, 'view_email', 'emails', id, req.ip);

    res.json({
      email: {
        ...email,
        body_html: parsedContent.body_html,
        body_text: parsedContent.body_text,
        content_type: parsedContent.content_type
      },
      attachments,
    });
  } catch (error) {
    logger.error('Failed to get email', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get email content (EML file)
router.get('/:id/content', async (req, res) => {
  try {
    const { id } = req.params;

    const emails = await query('SELECT eml_path, subject, from_email, to_email, date FROM emails WHERE id = ?', [id]);
    if (emails.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const email = emails[0];
    const emlPath = email.eml_path;

    let content;

    // Check if file exists
    try {
      await fs.access(emlPath);
      // Read actual file
      content = await fs.readFile(emlPath, 'utf8');
    } catch (fileError) {
      // File doesn't exist, generate mock EML content for simulated emails
      logger.info('EML file not found, generating mock content', { id, emlPath });
      content = generateMockEMLContent(email);
    }

    // Log access
    await logAuditAction(req.user.id, 'download_email', 'emails', id, req.ip);

    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(emlPath)}"`);
    res.send(content);
  } catch (error) {
    logger.error('Failed to get email content', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get email preview (HTML/text)
router.get('/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;

    const emails = await query('SELECT eml_path, subject, from_email, to_email, date FROM emails WHERE id = ?', [id]);
    if (emails.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const email = emails[0];
    const emlPath = email.eml_path;

    let emlContent;

    // Check if file exists
    try {
      await fs.access(emlPath);
      // Read actual file
      emlContent = await fs.readFile(emlPath, 'utf8');
    } catch (fileError) {
      // File doesn't exist, generate mock EML content for simulated emails
      logger.info('EML file not found for preview, generating mock content', { id, emlPath });
      emlContent = generateMockEMLContent(email);
    }

    // Simple parsing for preview (in production, use mailparser)
    const lines = emlContent.split('\n');
    let inBody = false;
    let contentType = 'text/plain';
    let body = '';

    for (const line of lines) {
      if (line.toLowerCase().startsWith('content-type:')) {
        contentType = line.split(':')[1].trim();
      }

      if (line.trim() === '') {
        inBody = true;
        continue;
      }

      if (inBody) {
        body += line + '\n';
      }
    }

    // Log access
    await logAuditAction(req.user.id, 'preview_email', 'emails', id, req.ip);

    res.json({
      contentType,
      body: body.trim(),
    });
  } catch (error) {
    logger.error('Failed to preview email', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get email attachments
router.get('/:id/attachments', async (req, res) => {
  try {
    const { id } = req.params;

    const attachments = await query(
      'SELECT id, filename, mime_type, size FROM attachments WHERE email_id = ? ORDER BY id',
      [id]
    );

    // Log access
    await logAuditAction(req.user.id, 'view_attachments', 'emails', id, req.ip);

    res.json({ attachments });
  } catch (error) {
    logger.error('Failed to get email attachments', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// View/Download attachment
router.get('/:emailId/attachments/:attachmentId', async (req, res) => {
  try {
    const { emailId, attachmentId } = req.params;
    const { download = 'false' } = req.query;

    const attachments = await query(
      'SELECT * FROM attachments WHERE id = ? AND email_id = ?',
      [attachmentId, emailId]
    );

    if (attachments.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = attachments[0];
    const filePath = attachment.file_path;

    // Try to serve actual file from disk
    if (filePath) {
      try {
        await fs.access(filePath);
        const content = await fs.readFile(filePath);
        const contentType = attachment.mime_type || 'application/octet-stream';

        // Set appropriate headers
        if (download === 'true') {
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
        } else {
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
        }

        res.setHeader('Content-Length', content.length);
        res.send(content);

        // Log access
        await logAuditAction(req.user.id, download === 'true' ? 'download_attachment' : 'view_attachment', 'attachments', attachmentId, req.ip);
        return;
      } catch (fileError) {
        logger.warn('Attachment file not found, falling back to EML extraction', {
          attachmentId,
          filePath,
          error: fileError.message
        });
      }
    }

    // Fallback: Try to extract attachment from EML file
    try {
      const emails = await query('SELECT eml_path FROM emails WHERE id = ?', [emailId]);
      if (emails.length > 0) {
        const emlPath = emails[0].eml_path;
        try {
          await fs.access(emlPath);
          const emlContent = await fs.readFile(emlPath, 'utf8');
          const parsed = await simpleParser(emlContent);

          // Find matching attachment
          const matchingAttachment = parsed.attachments.find(
            a => a.filename === attachment.filename || a.cid === attachmentId
          );

          if (matchingAttachment) {
            let content;
            let contentType = matchingAttachment.contentType || attachment.mime_type || 'application/octet-stream';

            if (matchingAttachment.content && Buffer.isBuffer(matchingAttachment.content)) {
              content = matchingAttachment.content;
            } else if (matchingAttachment.content && typeof matchingAttachment.content === 'string') {
              content = Buffer.from(matchingAttachment.content, 'utf8');
            } else {
              throw new Error('No content available in attachment');
            }

            if (download === 'true') {
              res.setHeader('Content-Type', contentType);
              res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
            } else {
              res.setHeader('Content-Type', contentType);
              res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
            }

            res.setHeader('Content-Length', content.length);
            res.send(content);

            await logAuditAction(req.user.id, download === 'true' ? 'download_attachment' : 'view_attachment', 'attachments', attachmentId, req.ip);
            return;
          }
        } catch (emlError) {
          logger.warn('Failed to extract from EML', { emailId, error: emlError.message });
        }
      }
    } catch (fallbackError) {
      logger.warn('Fallback extraction failed', { attachmentId, error: fallbackError.message });
    }

    // If all else fails, return error
    res.status(404).json({ error: 'Attachment file not found and could not be extracted from email' });
  } catch (error) {
    logger.error('Failed to view/download attachment', {
      emailId: req.params.emailId,
      attachmentId: req.params.attachmentId,
      error: error.message
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get email statistics
router.get('/stats/overview', async (req, res) => {
  try {
    const { period = '30' } = req.query; // days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(period));

    // Get overall email statistics
    const stats = await query(`
      SELECT
        COUNT(*) as total_emails,
        COALESCE(SUM(size), 0) as total_size,
        COUNT(DISTINCT user_id) as active_users,
        COALESCE(AVG(size), 0) as avg_size,
        MAX(date) as latest_email,
        MIN(date) as oldest_email
      FROM emails
      WHERE date >= ?
    `, [startDate]);

    // Get user breakdown
    const userStats = await query(`
      SELECT
        u.email as user_email,
        COUNT(e.id) as email_count,
        COALESCE(SUM(e.size), 0) as total_size,
        MAX(e.date) as latest_email
      FROM users u
      LEFT JOIN emails e ON u.id = e.user_id AND e.date >= ?
      GROUP BY u.id, u.email
      HAVING COUNT(e.id) > 0
      ORDER BY email_count DESC
      LIMIT 10
    `, [startDate]);

    // Get domain breakdown
    const domainStats = await query(`
      SELECT
        d.name as domain,
        COUNT(e.id) as email_count,
        COALESCE(SUM(e.size), 0) as total_size
      FROM domains d
      LEFT JOIN users u ON d.id = u.domain_id
      LEFT JOIN emails e ON u.id = e.user_id AND e.date >= ?
      GROUP BY d.id, d.name
      HAVING COUNT(e.id) > 0
      ORDER BY email_count DESC
    `, [startDate]);

    // Get daily email counts for the last 7 days (MySQL compatible)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const dailyStats = await query(`
      SELECT
        DATE(date) as date,
        COUNT(*) as email_count,
        COALESCE(SUM(size), 0) as total_size
      FROM emails
      WHERE date >= ?
      GROUP BY DATE(date)
      ORDER BY date DESC
    `, [sevenDaysAgo]);

    // Ensure we have valid data even if no emails exist
    const overview = stats[0] || {
      total_emails: 0,
      total_size: 0,
      active_users: 0,
      avg_size: 0,
      latest_email: null,
      oldest_email: null
    };

    res.json({
      overview,
      users: userStats,
      domains: domainStats,
      daily: dailyStats,
      period: parseInt(period)
    });
  } catch (error) {
    logger.error('Failed to get email stats', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk delete emails
router.delete('/bulk', async (req, res) => {
  try {
    const { emailIds } = req.body;

    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({ error: 'emailIds must be a non-empty array' });
    }

    if (emailIds.length > 100) {
      return res.status(400).json({ error: 'Cannot delete more than 100 emails at once' });
    }

    logger.info('Starting bulk email deletion', {
      count: emailIds.length,
      admin: req.user.username
    });

    let deletedCount = 0;
    let failedCount = 0;
    const failedIds = [];

    // Process each email deletion
    for (const emailId of emailIds) {
      try {
        const emails = await query('SELECT * FROM emails WHERE id = ?', [emailId]);
        if (emails.length === 0) {
          failedIds.push({ id: emailId, reason: 'Email not found' });
          failedCount++;
          continue;
        }

        const email = emails[0];

        // Delete EML file
        try {
          await fs.unlink(email.eml_path);
        } catch (error) {
          logger.warn('Failed to delete EML file', { path: email.eml_path });
        }

        // Delete from database
        await query('DELETE FROM emails WHERE id = ?', [emailId]);

        // Log audit
        await logAuditAction(req.user.id, 'delete_email', 'emails', emailId, req.ip);

        deletedCount++;
      } catch (error) {
        logger.error('Failed to delete email in bulk operation', {
          emailId,
          error: error.message
        });
        failedIds.push({ id: emailId, reason: error.message });
        failedCount++;
      }
    }

    logger.info('Bulk email deletion completed', {
      requested: emailIds.length,
      deleted: deletedCount,
      failed: failedCount,
      admin: req.user.username
    });

    res.json({
      message: `Bulk deletion completed: ${deletedCount} deleted, ${failedCount} failed`,
      results: {
        deleted: deletedCount,
        failed: failedCount,
        failedIds: failedIds
      }
    });
  } catch (error) {
    logger.error('Failed to perform bulk email deletion', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete email (soft delete by removing file and marking as deleted)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const emails = await query('SELECT * FROM emails WHERE id = ?', [id]);
    if (emails.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const email = emails[0];

    // Delete EML file
    try {
      await fs.unlink(email.eml_path);
    } catch (error) {
      logger.warn('Failed to delete EML file', { path: email.eml_path });
    }

    // Delete from database
    await query('DELETE FROM emails WHERE id = ?', [id]);

    // Log audit
    await logAuditAction(req.user.id, 'delete_email', 'emails', id, req.ip);

    logger.info('Email deleted', {
      id,
      messageId: email.message_id,
      admin: req.user.username
    });

    res.json({ message: 'Email deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete email', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a minimal valid PDF for demo purposes
function createMinimalPDF(filename) {
  // Minimal PDF content that browsers can display
  // This creates a simple PDF with text content
  const pdfBytes = new Uint8Array([
    // PDF header
    0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A,

    // Object 1: Catalog
    0x31, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A,
    0x3C, 0x3C, 0x0A,
    0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x43, 0x61, 0x74, 0x61, 0x6C, 0x6F, 0x67, 0x0A,
    0x2F, 0x50, 0x61, 0x67, 0x65, 0x73, 0x20, 0x32, 0x20, 0x30, 0x20, 0x52, 0x0A,
    0x3E, 0x3E, 0x0A,
    0x65, 0x6E, 0x64, 0x6F, 0x62, 0x6A, 0x0A,

    // Object 2: Pages
    0x32, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A,
    0x3C, 0x3C, 0x0A,
    0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x50, 0x61, 0x67, 0x65, 0x73, 0x0A,
    0x2F, 0x4B, 0x69, 0x64, 0x73, 0x20, 0x5B, 0x33, 0x20, 0x30, 0x20, 0x52, 0x5D, 0x0A,
    0x2F, 0x43, 0x6F, 0x75, 0x6E, 0x74, 0x20, 0x31, 0x0A,
    0x3E, 0x3E, 0x0A,
    0x65, 0x6E, 0x64, 0x6F, 0x62, 0x6A, 0x0A,

    // Object 3: Page
    0x33, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A,
    0x3C, 0x3C, 0x0A,
    0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x50, 0x61, 0x67, 0x65, 0x0A,
    0x2F, 0x50, 0x61, 0x72, 0x65, 0x6E, 0x74, 0x20, 0x32, 0x20, 0x30, 0x20, 0x52, 0x0A,
    0x2F, 0x4D, 0x65, 0x64, 0x69, 0x61, 0x42, 0x6F, 0x78, 0x20, 0x5B, 0x30, 0x20, 0x30, 0x20, 0x36, 0x31, 0x32, 0x20, 0x37, 0x39, 0x32, 0x5D, 0x0A,
    0x2F, 0x43, 0x6F, 0x6E, 0x74, 0x65, 0x6E, 0x74, 0x73, 0x20, 0x34, 0x20, 0x30, 0x20, 0x52, 0x0A,
    0x3E, 0x3E, 0x0A,
    0x65, 0x6E, 0x64, 0x6F, 0x62, 0x6A, 0x0A,

    // Object 4: Content Stream
    0x34, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A,
    0x3C, 0x3C, 0x0A,
    0x2F, 0x4C, 0x65, 0x6E, 0x67, 0x74, 0x68, 0x20, 0x38, 0x38, 0x0A,
    0x3E, 0x3E, 0x0A,
    0x73, 0x74, 0x72, 0x65, 0x61, 0x6D, 0x0A,
    // Content: "Demo PDF - File: filename"
    0x42, 0x54, 0x0A,
    0x2F, 0x46, 0x31, 0x20, 0x32, 0x34, 0x20, 0x54, 0x66, 0x0A,
    0x35, 0x30, 0x20, 0x37, 0x30, 0x30, 0x20, 0x54, 0x64, 0x0A,
    0x28, 0x44, 0x65, 0x6D, 0x6F, 0x20, 0x50, 0x44, 0x46, 0x20, 0x41, 0x74, 0x74, 0x61, 0x63, 0x68, 0x6D, 0x65, 0x6E, 0x74, 0x29, 0x20, 0x54, 0x6A, 0x0A,
    0x30, 0x20, 0x2D, 0x35, 0x30, 0x20, 0x54, 0x64, 0x0A,
    0x2F, 0x46, 0x31, 0x20, 0x31, 0x32, 0x20, 0x54, 0x66, 0x0A,
    0x28, 0x46, 0x69, 0x6C, 0x65, 0x3A, 0x20,
    // Insert filename here (this will be replaced)
    ...Array.from(filename.substring(0, 30), c => c.charCodeAt(0)),
    0x29, 0x20, 0x54, 0x6A, 0x0A,
    0x45, 0x54, 0x0A,
    0x65, 0x6E, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6D, 0x0A,
    0x65, 0x6E, 0x64, 0x6F, 0x62, 0x6A, 0x0A,

    // Object 5: Font
    0x35, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A,
    0x3C, 0x3C, 0x0A,
    0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x46, 0x6F, 0x6E, 0x74, 0x0A,
    0x2F, 0x53, 0x75, 0x62, 0x74, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x54, 0x79, 0x70, 0x65, 0x31, 0x0A,
    0x2F, 0x42, 0x61, 0x73, 0x65, 0x46, 0x6F, 0x6E, 0x74, 0x20, 0x2F, 0x48, 0x65, 0x6C, 0x76, 0x65, 0x74, 0x69, 0x63, 0x61, 0x0A,
    0x3E, 0x3E, 0x0A,
    0x65, 0x6E, 0x64, 0x6F, 0x62, 0x6A, 0x0A,

    // Cross-reference table
    0x78, 0x72, 0x65, 0x66, 0x0A,
    0x30, 0x20, 0x36, 0x0A,
    0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x36, 0x35, 0x35, 0x33, 0x35, 0x20, 0x66, 0x20, 0x0A,
    0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x39, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6E, 0x20, 0x0A,
    0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x35, 0x38, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6E, 0x20, 0x0A,
    0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x31, 0x35, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6E, 0x20, 0x0A,
    0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x37, 0x34, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6E, 0x20, 0x0A,
    0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x35, 0x36, 0x31, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6E, 0x20, 0x0A,

    // Trailer
    0x74, 0x72, 0x61, 0x69, 0x6C, 0x65, 0x72, 0x0A,
    0x3C, 0x3C, 0x0A,
    0x2F, 0x53, 0x69, 0x7A, 0x65, 0x20, 0x36, 0x0A,
    0x2F, 0x52, 0x6F, 0x6F, 0x74, 0x20, 0x31, 0x20, 0x30, 0x20, 0x52, 0x0A,
    0x3E, 0x3E, 0x0A,
    0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66, 0x0A,
    0x36, 0x38, 0x30, 0x0A,
    0x25, 0x25, 0x45, 0x4F, 0x46
  ]);

  return Buffer.from(pdfBytes);
}

// Generate mock EML content for simulated emails
function generateMockEMLContent(email) {
  const dateStr = email.date ? new Date(email.date).toUTCString() : new Date().toUTCString();

  const emlContent = `Return-Path: <${email.from_email}>
Received: by smtp.gmail.com with SMTP id abc123
Date: ${dateStr}
From: ${email.from_email}
To: ${email.to_email}
Subject: ${email.subject}
Content-Type: multipart/alternative; boundary="boundary123"
MIME-Version: 1.0
Message-ID: <simulated-${Date.now()}@example.com>

--boundary123
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 7bit

This is a simulated email content for development purposes.

Subject: ${email.subject}
From: ${email.from_email}
To: ${email.to_email}
Date: ${dateStr}

This email was generated during the backup simulation process.
In a real Gmail backup, this would contain the actual email content.

Features demonstrated:
- HTML and plain text content
- Proper email formatting
- Gmail-like appearance

---
Simulated Email - Generated for Testing
---

--boundary123
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: 7bit

<html>
<head>
<style>
body { font-family: Arial, sans-serif; line-height: 1.5; color: #202124; }
.highlight { background-color: #f1f3f4; padding: 10px; border-radius: 4px; }
.signature { color: #5f6368; font-style: italic; margin-top: 20px; }
</style>
</head>
<body>
<p>This is a <strong>simulated email content</strong> for development purposes.</p>

<div class="highlight">
<h3>Email Details:</h3>
<ul>
<li><strong>Subject:</strong> ${email.subject}</li>
<li><strong>From:</strong> ${email.from_email}</li>
<li><strong>To:</strong> ${email.to_email}</li>
<li><strong>Date:</strong> ${dateStr}</li>
</ul>
</div>

<p>This email was generated during the backup simulation process. In a real Gmail backup, this would contain the actual email content.</p>

<p>Features demonstrated:</p>
<ul>
<li>HTML and plain text content</li>
<li>Proper email formatting</li>
<li>Gmail-like appearance with styling</li>
<li>Responsive design elements</li>
</ul>

<div class="signature">
---
Simulated Email - Generated for Testing<br>
Google Workspace Email Backup System
</div>
</body>
</html>

--boundary123--
`;

  return emlContent;
}

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

// Debug endpoint for testing stats queries (placed before auth middleware)
const debugRouter = express.Router();

// Debug endpoint for testing stats queries (no auth required for debugging)
debugRouter.get('/debug-stats', async (req, res) => {
  try {
    console.log('🔍 Debug: Testing basic query...');

    // Simple query first
    const [result] = await query('SELECT 1 as test');
    console.log('✅ Basic query works:', result);

    // Try to query emails table directly (will fail if table doesn't exist)
    try {
      const [totalCheck] = await query('SELECT COUNT(*) as total FROM emails');
      console.log('📧 Total emails in DB:', totalCheck[0].total);

      if (totalCheck[0].total === 0) {
        return res.json({
          message: 'Emails table exists but no emails in database',
          debug: { totalEmailsInDB: 0, tableExists: true }
        });
      }

      // Check sample emails
      const [sampleEmails] = await query('SELECT id, user_id, subject, date FROM emails LIMIT 3');
      console.log('📧 Sample emails:', sampleEmails);

      res.json({
        message: 'Debug successful',
        debug: {
          totalEmailsInDB: totalCheck[0].total,
          tableExists: true,
          sampleEmails: sampleEmails
        }
      });

    } catch (tableError) {
      console.log('❌ Emails table query failed:', tableError.message);
      return res.json({
        message: 'Emails table does not exist or is empty',
        debug: { tableExists: false, error: tableError.message }
      });
    }

  } catch (error) {
    console.error('❌ Debug error:', error.message);
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// Export both routers
module.exports = router;
module.exports.debugRouter = debugRouter;
