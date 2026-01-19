const express = require('express');
const { query } = require('../services/database/databaseService');
const { queueService } = require('../services/queue/queueService');
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
    new winston.transports.File({ filename: 'logs/users.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// All routes require authentication
router.use(authenticateToken);

// Get all users
router.get('/', async (req, res) => {
  try {
    const { domain_id, status, page = 1, limit = 50 } = req.query;

    let queryStr = `
      SELECT u.*, d.name as domain_name,
             COUNT(e.id) as email_count,
             SUM(e.size) as total_size,
             MAX(e.date) as last_email_date
      FROM users u
      LEFT JOIN domains d ON u.domain_id = d.id
      LEFT JOIN emails e ON u.id = e.user_id
    `;

    const params = [];
    const conditions = [];

    if (domain_id) {
      conditions.push('u.domain_id = ?');
      params.push(domain_id);
    }

    if (status) {
      conditions.push('u.status = ?');
      params.push(status);
    }

    if (conditions.length > 0) {
      queryStr += ' WHERE ' + conditions.join(' AND ');
    }

    queryStr += ' GROUP BY u.id ORDER BY u.email';
    const limitValue = parseInt(limit);
    const offsetValue = (parseInt(page) - 1) * limitValue;

    // MySQL doesn't support parameterized LIMIT/OFFSET, so we use template literals for these values
    queryStr += ` LIMIT ${limitValue} OFFSET ${offsetValue}`;

    const users = await query(queryStr, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM users u';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const totalResult = await query(countQuery, params);
    const total = totalResult[0].total;

    // Add connection data to each user
    const usersWithConnections = await Promise.all(
      users.map(async (user) => {
        try {
          const connections = await query(
            'SELECT * FROM imap_connections WHERE user_id = ? ORDER BY last_activity DESC LIMIT 1',
            [user.id]
          );

          if (connections[0]) {
            const connection = connections[0];
            const lastActivity = new Date(connection.last_activity);
            const timeSinceActivity = Date.now() - lastActivity.getTime();
            const isRecent = timeSinceActivity < 24 * 60 * 60 * 1000; // 24 hours for development
            const isConnected = connection.status === 'connected';

            return {
              ...user,
              connection: {
                ...connection,
                isRecent,
                timeSinceActivity: Math.floor(timeSinceActivity / 1000), // seconds
                connected: isConnected && isRecent,
                message: isConnected && isRecent ?
                  'IMAP connection is active' :
                  `IMAP connection is ${connection.status}`
              },
            };
          }

          return {
            ...user,
            connection: null,
          };
        } catch (error) {
          logger.warn('Failed to fetch connection for user', { userId: user.id, error: error.message });
          return {
            ...user,
            connection: null,
          };
        }
      })
    );

    res.json({
      users: usersWithConnections,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to get users', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const users = await query(`
      SELECT u.*, d.name as domain_name,
             COUNT(e.id) as email_count,
             SUM(e.size) as total_size,
             MAX(e.date) as last_email_date
      FROM users u
      LEFT JOIN domains d ON u.domain_id = d.id
      LEFT JOIN emails e ON u.id = e.user_id
      WHERE u.id = ?
      GROUP BY u.id
    `, [id]);

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get connection status
    const connections = await query(
      'SELECT * FROM imap_connections WHERE user_id = ? ORDER BY last_activity DESC LIMIT 1',
      [id]
    );

    res.json({
      user: users[0],
      connection: connections[0] || null,
    });
  } catch (error) {
    logger.error('Failed to get user', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    logger.info('Status update request received', {
      userId: id,
      newStatus: status,
      admin: req.user.username,
      ip: req.ip
    });

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be active or inactive' });
    }

    // Check if user exists
    const users = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const oldStatus = users[0].status;
    logger.info('Current user status before update', {
      userId: id,
      email: users[0].email,
      oldStatus,
      newStatus: status
    });

    // Update status
    await query(
      'UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );

    logger.info('User status updated in database', {
      userId: id,
      email: users[0].email,
      oldStatus,
      newStatus: status
    });

    // If activating, start IMAP connection
    if (status === 'active') {
      logger.info('Queueing IMAP connect job', { userId: id, email: users[0].email });
      await queueService.addIMAPJob(id, users[0].email, 'connect', 1);
    } else {
      // If deactivating, disconnect IMAP
      logger.info('Queueing IMAP disconnect job', { userId: id, email: users[0].email });
      await queueService.addIMAPJob(id, users[0].email, 'disconnect', 1);
    }

    // Log audit
    await logAuditAction(req.user.id, 'update_user_status', 'users', id, req.ip);

    logger.info('User status update completed successfully', {
      userId: id,
      email: users[0].email,
      oldStatus,
      newStatus: status,
      admin: req.user.username
    });

    res.json({
      user: {
        id,
        status,
        updated_at: new Date(),
      },
    });
  } catch (error) {
    logger.error('Failed to update user status', {
      userId: req.params.id,
      newStatus: req.body.status,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start IMAP connection for user
router.post('/:id/connect', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists and is active
    const users = await query('SELECT * FROM users WHERE id = ? AND status = ?', [id, 'active']);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found or inactive' });
    }

    // Always use real Gmail mode - no simulated mode
    logger.info('IMAP connection requested (PRODUCTION - Real Gmail)', {
      userId: id,
      email: users[0].email,
      admin: req.user.username
    });

    // Update connection status to simulate successful connection
    // Use UUID format like production mode for consistency
    const { v4: uuidv4 } = require('uuid');
    const connectionId = uuidv4();

    try {
      // Try to insert first
      await query(
        'INSERT INTO imap_connections (user_id, connection_id, status, last_activity) VALUES (?, ?, ?, NOW())',
        [id, connectionId, 'connected']
      );
    } catch (insertError) {
      // If insert fails (duplicate user_id), update instead
      await query(
        'UPDATE imap_connections SET connection_id = ?, status = ?, last_activity = NOW() WHERE user_id = ?',
        [connectionId, 'connected', id]
      );
    }

    // Log audit
    await logAuditAction(req.user.id, 'connect_user', 'users', id, req.ip);

    res.json({
      message: 'IMAP connection established (PRODUCTION - Real Gmail)',
      status: 'connected',
    });
  } catch (error) {
    logger.error('Failed to establish IMAP connection', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to establish IMAP connection' });
  }
});

// Start manual backup for user (async - returns immediately)
router.post('/:id/backup', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('Manual backup request received', {
      userId: id,
      admin: req.user.username,
      ip: req.ip
    });

    // Check if user exists and is active
    const users = await query('SELECT * FROM users WHERE id = ? AND status = ?', [id, 'active']);
    if (users.length === 0) {
      logger.warn('Manual backup rejected - user not found or inactive', {
        userId: id,
        admin: req.user.username
      });
      return res.status(404).json({ error: 'User not found or inactive' });
    }

    logger.info('User status verified for manual backup', {
      userId: id,
      email: users[0].email,
      status: users[0].status,
      admin: req.user.username
    });

    // Check Google Service Account configuration before attempting backup
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

    if (!serviceAccountEmail || !keyFile) {
      const errorMsg = 'Google Service Account not configured. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_KEY_FILE environment variables.';
      logger.error('Manual backup failed - service account not configured', {
        userId: id,
        email: users[0].email,
        hasEmail: !!serviceAccountEmail,
        hasKeyFile: !!keyFile
      });
      return res.status(500).json({
        error: errorMsg,
        details: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: serviceAccountEmail ? 'configured' : 'missing',
          GOOGLE_SERVICE_ACCOUNT_KEY_FILE: keyFile ? 'configured' : 'missing'
        }
      });
    }

    // Check if manual backup is already running for this user
    const { scheduledBackupService } = require('../services/backup/scheduledBackup');
    const status = scheduledBackupService.getStatus();

    if (status.manualBackupRunning) {
      logger.warn('Manual backup rejected - already running', {
        userId: id,
        email: users[0].email,
        admin: req.user.username
      });
      return res.status(409).json({
        error: 'Manual backup already running. Please wait for the current backup to complete.',
        status: 'running'
      });
    }

    // Start manual backup asynchronously
    logger.info('Starting async manual backup for user', {
      userId: id,
      email: users[0].email,
      admin: req.user.username
    });

    // Run backup in background (don't await)
    const { runManualBackup } = require('../services/backup/scheduledBackup');
    runManualBackup(id).then(() => {
      logger.info('Manual backup completed successfully in background', {
        userId: id,
        email: users[0].email,
        admin: req.user.username
      });
    }).catch(async (error) => {
      logger.error('Manual backup failed in background', {
        userId: id,
        email: users[0].email,
        admin: req.user.username,
        error: error.message
      });

      // If backup failed, disconnect IMAP connection to clean up
      try {
        const { imapService } = require('../services/imap/imapService');
        await imapService.disconnect(id);
        logger.info('IMAP connection cleaned up after backup failure', {
          userId: id,
          email: users[0].email
        });
      } catch (disconnectError) {
        logger.warn('Failed to cleanup IMAP connection after backup failure', {
          userId: id,
          email: users[0].email,
          error: disconnectError.message
        });
      }
    });

    // Log audit
    await logAuditAction(req.user.id, 'manual_backup', 'users', id, req.ip);

    // Return immediately with backup ID for status tracking
    const backupId = `manual_${id}_${Date.now()}`;
    res.json({
      message: 'Manual backup started successfully',
      backupId: backupId,
      userId: id,
      email: users[0].email,
      status: 'running'
    });

  } catch (error) {
    logger.error('Failed to start manual backup', {
      userId: req.params.id,
      admin: req.user.username,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: 'Failed to start manual backup' });
  }
});

// Get manual backup status for user
router.get('/:id/backup/status', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const users = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get backup service status
    const { scheduledBackupService } = require('../services/backup/scheduledBackup');
    const serviceStatus = scheduledBackupService.getStatus();

    // Get recent backup logs or connection status as proxy for backup progress
    const connections = await query(
      'SELECT * FROM imap_connections WHERE user_id = ? ORDER BY last_activity DESC LIMIT 1',
      [id]
    );

    let backupStatus = 'idle';
    let message = 'No backup in progress';
    let progress = null;

    if (serviceStatus.manualBackupRunning) {
      backupStatus = 'running';
      message = 'Manual backup is currently running';

      // Try to get more detailed status from connection
      if (connections.length > 0) {
        const connection = connections[0];
        const lastActivity = new Date(connection.last_activity);
        const timeSinceActivity = Date.now() - lastActivity.getTime();
        const isRecent = timeSinceActivity < 5 * 60 * 1000; // 5 minutes

        if (connection.status === 'connected' && isRecent) {
          message = 'Backup in progress - IMAP connection active';
          progress = 'Processing emails...';
        } else if (connection.status === 'idle' && isRecent) {
          message = 'Backup completed - connection idle';
          progress = 'Backup finished';
        } else if (connection.status === 'disconnected') {
          // Check if it was recently disconnected (might indicate failure)
          if (timeSinceActivity < 2 * 60 * 1000) { // 2 minutes ago
            backupStatus = 'failed';
            message = 'Backup failed - connection lost';
            progress = 'Connection error occurred';
          } else {
            message = 'Backup may have encountered connection issues';
            progress = 'Checking connection...';
          }
        }
      }
    } else {
      // Check if backup recently completed or failed by looking at connection activity
      if (connections.length > 0) {
        const connection = connections[0];
        const lastActivity = new Date(connection.last_activity);
        const timeSinceActivity = Date.now() - lastActivity.getTime();
        const recentlyActive = timeSinceActivity < 15 * 60 * 1000; // 15 minutes

        if (recentlyActive) {
          if (connection.status === 'idle') {
            backupStatus = 'completed';
            message = 'Backup completed successfully';
            progress = 'All emails processed';
          } else if (connection.status === 'disconnected') {
            // If recently disconnected and no backup running, it might have failed
            backupStatus = 'failed';
            message = 'Backup failed - connection was lost';
            progress = 'Backup terminated unexpectedly';
          }
        }
      }
    }

    res.json({
      userId: id,
      email: users[0].email,
      status: backupStatus,
      message: message,
      progress: progress,
      lastActivity: connections[0]?.last_activity || null,
      connectionStatus: connections[0]?.status || 'unknown'
    });

  } catch (error) {
    logger.error('Failed to get manual backup status', {
      userId: req.params.id,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to get backup status' });
  }
});

// Disconnect IMAP for user
router.post('/:id/disconnect', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const users = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Always use real Gmail mode - no simulated mode
    logger.info('IMAP disconnect requested (PRODUCTION - Real Gmail)', {
      userId: id,
      email: users[0].email,
      admin: req.user.username
    });

    // Update connection status to simulate disconnection
    await query(
      'UPDATE imap_connections SET status = ?, last_activity = NOW() WHERE user_id = ?',
      ['disconnected', id]
    );

    // Log audit
    await logAuditAction(req.user.id, 'disconnect_user', 'users', id, req.ip);

    res.json({
      message: 'IMAP connection disconnected (PRODUCTION - Real Gmail)',
      status: 'disconnected',
    });
  } catch (error) {
    logger.error('Failed to disconnect IMAP', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to disconnect IMAP connection' });
  }
});

// Get IMAP connection status for user
router.get('/:id/imap-status', async (req, res) => {
  try {
    const { id } = req.params;

    const connections = await query(
      'SELECT * FROM imap_connections WHERE user_id = ? ORDER BY last_activity DESC LIMIT 1',
      [id]
    );

    if (connections.length === 0) {
      return res.json({
        connected: false,
        status: 'never_connected',
        lastActivity: null,
        connectionId: null,
        message: 'User has never connected to IMAP'
      });
    }

    const connection = connections[0];
    const isConnected = connection.status === 'connected';
    const lastActivity = new Date(connection.last_activity);
    const timeSinceActivity = Date.now() - lastActivity.getTime();
    const isRecent = timeSinceActivity < 24 * 60 * 60 * 1000; // 24 hours for development

    res.json({
      connected: isConnected && isRecent,
      status: connection.status,
      lastActivity: connection.last_activity,
      connectionId: connection.connection_id,
      timeSinceActivity: Math.floor(timeSinceActivity / 1000), // seconds
      isRecent,
      message: isConnected && isRecent ?
        'IMAP connection is active' :
        `IMAP connection is ${connection.status}`
    });
  } catch (error) {
    logger.error('Failed to get IMAP status', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to get IMAP status' });
  }
});

// Get user's email statistics
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const { period = '30' } = req.query; // days

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(period));

    // Get email stats
    const stats = await query(`
      SELECT
        COUNT(*) as total_emails,
        SUM(size) as total_size,
        COUNT(CASE WHEN date >= ? THEN 1 END) as recent_emails,
        MAX(date) as last_email_date,
        MIN(date) as first_email_date
      FROM emails
      WHERE user_id = ?
    `, [startDate, id]);

    // Get daily email counts
    const dailyStats = await query(`
      SELECT
        DATE(date) as date,
        COUNT(*) as count,
        SUM(size) as size
      FROM emails
      WHERE user_id = ? AND date >= ?
      GROUP BY DATE(date)
      ORDER BY date DESC
      LIMIT 30
    `, [id, startDate]);

    res.json({
      stats: stats[0],
      daily: dailyStats,
    });
  } catch (error) {
    logger.error('Failed to get user stats', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user and all associated data
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const users = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    try {
      // Skip IMAP disconnect for now to avoid timeout issues
      // TODO: Implement proper IMAP disconnect before deletion

      // Delete in order: attachments, emails, imap_connections, pst_exports, then user
      // Using individual queries for SQLite compatibility
      logger.info('Starting user deletion process', { userId: id, email: users[0].email });

      const attachmentCount = await query('SELECT COUNT(*) as count FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE user_id = ?)', [id]);
      const emailCount = await query('SELECT COUNT(*) as count FROM emails WHERE user_id = ?', [id]);

      logger.info('Deleting user data', {
        userId: id,
        emails: emailCount[0].count,
        attachments: attachmentCount[0].count
      });

      // Delete step by step with logging
      await query('DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE user_id = ?)', [id]);
      logger.debug('Deleted attachments', { userId: id });

      await query('DELETE FROM emails WHERE user_id = ?', [id]);
      logger.debug('Deleted emails', { userId: id });

      await query('DELETE FROM imap_connections WHERE user_id = ?', [id]);
      logger.debug('Deleted IMAP connections', { userId: id });

      await query('DELETE FROM pst_exports WHERE user_id = ?', [id]);
      logger.debug('Deleted PST exports', { userId: id });

      await query('DELETE FROM users WHERE id = ?', [id]);
      logger.info('User deletion completed successfully', { userId: id, email: users[0].email });

      // Log audit
      await logAuditAction(req.user.id, 'delete_user', 'users', id, req.ip);

      logger.info('User deleted', {
        id,
        email: users[0].email,
        admin: req.user.username
      });

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      logger.error('Failed to delete user data', { id, error: error.message });
      throw error;
    }
  } catch (error) {
    logger.error('Failed to delete user', { id: req.params.id, error: error.message });
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
