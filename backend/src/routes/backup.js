const express = require('express');
const { authenticateToken } = require('./auth');
const winston = require('winston');
const { scheduledBackupService, runManualBackup, getScheduledBackupStatus } = require('../services/backup/scheduledBackup');

const router = express.Router();
const debugRouter = express.Router(); // Separate router for debug endpoints
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/backup.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// All routes require authentication
router.use(authenticateToken);

// Debug endpoints (no auth required)
debugRouter.get('/config-debug', async (req, res) => {
  try {
    console.log('🔍 Debug: Backup config requested (no auth)');
    const config = {
      backupInterval: process.env.BACKUP_INTERVAL || '60',
      maxConcurrentUsers: process.env.MAX_CONCURRENT_USERS || '1', // Sequential mode
      batchSize: process.env.BATCH_SIZE || '100',                 // Faster processing
      batchDelay: process.env.BATCH_DELAY || '2000',
      useRealGmail: process.env.USE_REAL_GMAIL === 'true',
      // Add IMAP config
      maxConcurrentConnections: process.env.MAX_CONCURRENT_CONNECTIONS || '1',
      nodeEnv: process.env.NODE_ENV,
      port: process.env.PORT
    };

    console.log('✅ Debug backup config response:', config);
    res.json({ config });
  } catch (error) {
    console.error('❌ Debug backup config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get backup configuration
router.get('/config', async (req, res) => {
  try {
    console.log('🔍 Backup config requested by:', req.user?.username || 'unknown');
    const config = {
      backupInterval: process.env.BACKUP_INTERVAL || '60',
      maxConcurrentUsers: process.env.MAX_CONCURRENT_USERS || '1', // Sequential mode
      batchSize: process.env.BATCH_SIZE || '100',                 // Faster processing
      batchDelay: process.env.BATCH_DELAY || '2000',
      useRealGmail: process.env.USE_REAL_GMAIL === 'true'
    };

    console.log('✅ Backup config response:', config);
    res.json({ config });
  } catch (error) {
    logger.error('Failed to get backup config', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint for backup config (no auth required)
router.get('/config-debug', async (req, res) => {
  try {
    console.log('🔍 Debug: Backup config requested (no auth)');
    const config = {
      backupInterval: process.env.BACKUP_INTERVAL || '60',
      maxConcurrentUsers: process.env.MAX_CONCURRENT_USERS || '1', // Sequential mode
      batchSize: process.env.BATCH_SIZE || '100',                 // Faster processing
      batchDelay: process.env.BATCH_DELAY || '2000',
      useRealGmail: process.env.USE_REAL_GMAIL === 'true'
    };

    console.log('✅ Debug backup config response:', config);
    res.json({ config });
  } catch (error) {
    console.error('❌ Debug backup config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update backup configuration
router.put('/config', async (req, res) => {
  try {
    const { backupInterval, maxConcurrentUsers, batchSize, batchDelay } = req.body;

    // Validate inputs
    const validIntervals = ['5', '15', '30', '60'];
    if (backupInterval && !validIntervals.includes(backupInterval.toString())) {
      return res.status(400).json({ error: 'Invalid backup interval. Must be 5, 15, 30, or 60 minutes' });
    }

    if (maxConcurrentUsers && (maxConcurrentUsers < 1 || maxConcurrentUsers > 10)) {
      return res.status(400).json({ error: 'Max concurrent users must be between 1 and 10' });
    }

    if (batchSize && (batchSize < 1 || batchSize > 20)) {
      return res.status(400).json({ error: 'Batch size must be between 1 and 20' });
    }

    if (batchDelay && (batchDelay < 500 || batchDelay > 10000)) {
      return res.status(400).json({ error: 'Batch delay must be between 500ms and 10000ms' });
    }

    // Update environment variables (in production, this would require restart)
    if (backupInterval) process.env.BACKUP_INTERVAL = backupInterval.toString();
    if (maxConcurrentUsers) process.env.MAX_CONCURRENT_USERS = maxConcurrentUsers.toString();
    if (batchSize) process.env.BATCH_SIZE = batchSize.toString();
    if (batchDelay) process.env.BATCH_DELAY = batchDelay.toString();

    // Restart backup service with new configuration
    scheduledBackupService.stopScheduledBackup();
    scheduledBackupService.startScheduledBackup();

    logger.info('Backup configuration updated', {
      backupInterval,
      maxConcurrentUsers,
      batchSize,
      batchDelay,
      admin: req.user.username
    });

    res.json({
      message: 'Backup configuration updated successfully',
      config: {
        backupInterval: process.env.BACKUP_INTERVAL,
        maxConcurrentUsers: process.env.MAX_CONCURRENT_USERS,
        batchSize: process.env.BATCH_SIZE,
        batchDelay: process.env.BATCH_DELAY
      }
    });
  } catch (error) {
    logger.error('Failed to update backup config', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get backup status
router.get('/status', async (req, res) => {
  try {
    const status = getScheduledBackupStatus();
    res.json({ status });
  } catch (error) {
    logger.error('Failed to get backup status', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Run manual backup for all users
router.post('/manual', async (req, res) => {
  try {
    logger.info('Manual backup triggered by admin', { admin: req.user.username });

    // Run backup in background
    runManualBackup().catch(error => {
      logger.error('Manual backup failed in background', { error: error.message });
    });

    res.json({
      message: 'Manual backup started in background',
      status: 'running'
    });
  } catch (error) {
    logger.error('Failed to start manual backup', { error: error.message });
    res.status(500).json({ error: 'Failed to start manual backup' });
  }
});

// Run manual backup for specific user
router.post('/manual/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info('Manual backup triggered for specific user', {
      userId,
      admin: req.user.username
    });

    // Run backup in background
    runManualBackup(parseInt(userId)).catch(error => {
      logger.error('Manual backup failed for user in background', {
        userId,
        error: error.message
      });
    });

    res.json({
      message: `Manual backup started for user ${userId} in background`,
      status: 'running',
      userId: parseInt(userId)
    });
  } catch (error) {
    logger.error('Failed to start manual backup for user', {
      userId: req.params.userId,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to start manual backup for user' });
  }
});

// Get backup statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = {
      lastBackup: null,
      totalBackups: 0,
      successRate: 0,
      averageDuration: 0
    };

    // This would be implemented to read from logs or database
    // For now, return placeholder stats
    res.json({ stats });
  } catch (error) {
    logger.error('Failed to get backup stats', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.debugRouter = debugRouter;
