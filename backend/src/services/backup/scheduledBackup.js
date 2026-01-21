const cron = require('node-cron');
const winston = require('winston');
const { query } = require('../database/databaseService');
const { imapService } = require('../imap/imapService');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/scheduled-backup.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

class ScheduledBackupService {
  constructor() {
    this.isRunning = false;
    this.manualBackupRunning = false; // Flag to prevent concurrent manual backups
    this.bulkImapRunning = false; // Flag to prevent concurrent bulk IMAP operations
    this.backupLock = false; // Additional lock to prevent any backup during bulk operations
    this.cronJob = null;
    // Always use real Gmail mode - no development mode
    this.backupInterval = process.env.BACKUP_INTERVAL || '60'; // Default 60 minutes
    this.maxConcurrentUsers = parseInt(process.env.MAX_CONCURRENT_USERS || '1'); // Default 1 for sequential mode
    this.batchSize = parseInt(process.env.BATCH_SIZE || '100'); // Default 100 for faster processing
    this.batchDelay = parseInt(process.env.BATCH_DELAY || '2000'); // Default 2 seconds delay between batches

    logger.info('Scheduled Backup Service initialized in PRODUCTION (Real Gmail) mode');
    logger.info(`Backup configuration: interval=${this.backupInterval}min, concurrent=${this.maxConcurrentUsers}, batch=${this.batchSize}, delay=${this.batchDelay}ms`);
  }

  startScheduledBackup() {
    // Convert minutes to cron expression
    const intervalMinutes = parseInt(this.backupInterval);
    let cronExpression;

    if (intervalMinutes === 5) {
      cronExpression = '*/5 * * * *'; // Every 5 minutes
    } else if (intervalMinutes === 15) {
      cronExpression = '*/15 * * * *'; // Every 15 minutes
    } else if (intervalMinutes === 30) {
      cronExpression = '*/30 * * * *'; // Every 30 minutes
    } else {
      cronExpression = `*/${intervalMinutes} * * * *`; // Custom interval (default 60 minutes)
    }

    this.cronJob = cron.schedule(cronExpression, async () => {
      // Use enhanced check that gives bulk operations absolute priority
      if (!this.shouldRunScheduledBackup()) {
        return;
      }

      try {
        this.isRunning = true;
        logger.info('Starting scheduled backup (REAL)', {
          intervalMinutes,
          timestamp: new Date().toISOString()
        });

        await this.performBackup();

        logger.info('Scheduled backup (REAL) completed successfully', {
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Scheduled backup failed', {
          error: error.message,
          stack: error.stack?.substring(0, 500),
          timestamp: new Date().toISOString()
        });
      } finally {
        this.isRunning = false;
      }
    });

    logger.info(`Scheduled backup service started (PRODUCTION (Real Gmail) - runs every ${intervalMinutes} minutes)`);
  }

  async performBackup() {
    try {
      // Clean up any stale connections before starting backup
      await this.cleanupStaleConnections();

      // Get all active users
      const users = await query(
        'SELECT id, email FROM users WHERE status = ?',
        ['active']
      );

      logger.info('Found users for REAL backup', { count: users.length });

      if (users.length === 0) {
        logger.info('No active users to backup');
        return;
      }

      // Process users concurrently in batches to avoid overwhelming Google
      const concurrentBatches = [];
      for (let i = 0; i < users.length; i += this.maxConcurrentUsers) {
        const batch = users.slice(i, i + this.maxConcurrentUsers);
        concurrentBatches.push(batch);
      }

      // Process users SEQUENTIALLY to avoid any potential credential conflicts
      // Even though maxConcurrentUsers = 1, we want to ensure complete isolation
      for (const user of users) {
        try {
          // Double-check user status before processing
          const currentUser = await query(
            'SELECT status FROM users WHERE id = ?',
            [user.id]
          );

          if (currentUser.length === 0 || currentUser[0].status !== 'active') {
            logger.info(`Skipping backup for inactive user`, {
              userId: user.id,
              email: user.email,
              currentStatus: currentUser[0]?.status || 'not found'
            });
            continue;
          }

          logger.info('Starting sequential backup for user', {
            userId: user.id,
            email: user.email
          });

          await this.backupUserMailbox(user.id, user.email);

          logger.info('Backup completed for user', {
            userId: user.id,
            email: user.email
          });

          // Add delay between users to ensure complete cleanup and avoid rate limiting
          const delayBetweenUsers = 10000; // Increased to 10 seconds for better Gmail stability
          logger.info(`Waiting ${delayBetweenUsers/1000} seconds before next user`, { userId, userEmail });
          await new Promise(resolve => setTimeout(resolve, delayBetweenUsers));

        } catch (error) {
          logger.error('Failed to backup user mailbox (REAL)', {
            userId: user.id,
            email: user.email,
            error: error.message
          });
          // Continue with next user even if one fails
        }
      }

      logger.info('All user backups completed (REAL)');
    } catch (error) {
      logger.error('Failed to perform scheduled backup', { error: error.message });
      throw error;
    }
  }

  async backupUserMailbox(userId, userEmail) {
    // Always use real Gmail mode - no simulated mode
    return this.backupRealMailbox(userId, userEmail);
  }

  async backupRealMailbox(userId, userEmail) {
    try {
      logger.info('Starting REAL mailbox backup', { userEmail });

      // Check if there's an existing connection and if it's healthy
      const hasExistingConnection = imapService.connections.has(userId);
      let connectionHealthy = false;

      if (hasExistingConnection) {
        connectionHealthy = await imapService.isConnectionHealthy(userId);
        logger.info('Existing connection health check', {
          userId,
          userEmail,
          hasConnection: hasExistingConnection,
          isHealthy: connectionHealthy
        });

        if (!connectionHealthy) {
          logger.warn('Existing connection is unhealthy, forcing disconnect', { userId, userEmail });
          await imapService.forceDisconnect(userId);
        }
      }

      // Use the comprehensive backupFolder method from imapService
      // This handles all folders, proper batching, and error handling
      await imapService.backupUserMailbox(userId, userEmail);

      logger.info('REAL mailbox backup completed', { userEmail });

    } catch (error) {
      logger.error('Failed to perform real mailbox backup', {
        userId,
        userEmail,
        error: error.message
      });
      throw error;
    }
  }

  async cleanupStaleConnections() {
    try {
      logger.info('Starting stale connection cleanup before backup');

      const activeConnections = Array.from(imapService.connections.keys());
      let cleanedCount = 0;

      for (const userId of activeConnections) {
        try {
          const isHealthy = await imapService.isConnectionHealthy(userId);
          if (!isHealthy) {
            logger.warn('Found stale connection, forcing disconnect', { userId });
            await imapService.forceDisconnect(userId);
            cleanedCount++;
          }
        } catch (error) {
          logger.error('Error checking connection health', { userId, error: error.message });
          // Force disconnect on error
          await imapService.forceDisconnect(userId);
          cleanedCount++;
        }
      }

      logger.info('Stale connection cleanup completed', {
        checked: activeConnections.length,
        cleaned: cleanedCount
      });

    } catch (error) {
      logger.error('Failed to cleanup stale connections', { error: error.message });
    }
  }

  async manualBackup(userId = null) {
    // Check if manual backup is already running to prevent concurrent backups
    if (this.manualBackupRunning) {
      const errorMsg = 'Manual backup already running. Please wait for the current backup to complete before starting a new one.';
      logger.warn('Manual backup rejected - already running', { userId });
      throw new Error(errorMsg);
    }

    try {
      this.manualBackupRunning = true;
      logger.info('Starting manual backup (REAL)', { userId });

      if (userId) {
        // Clean up stale connections for specific user
        const isHealthy = await imapService.isConnectionHealthy(userId);
        if (!isHealthy && imapService.connections.has(userId)) {
          logger.warn('Existing connection unhealthy, forcing disconnect before manual backup', { userId });
          await imapService.forceDisconnect(userId);
        }

        // Backup specific user
        const users = await query('SELECT email FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
          throw new Error('User not found');
        }

        await this.backupUserMailbox(userId, users[0].email);
      } else {
        // Backup all users
        await this.performBackup();
      }

      logger.info('Manual backup (REAL) completed successfully');
    } catch (error) {
      logger.error('Manual backup failed', { error: error.message });
      throw error;
    } finally {
      this.manualBackupRunning = false;
    }
  }

  stopScheduledBackup() {
    if (this.cronJob) {
      this.cronJob.stop();
      logger.info('Scheduled backup service stopped');
    }
  }

  // Check if any backup operation is currently running
  isAnyBackupRunning() {
    return this.isRunning || this.manualBackupRunning || this.bulkImapRunning || this.backupLock;
  }

  // Start bulk IMAP operation (called from frontend bulk IMAP)
  async startBulkImap() {
    if (this.isAnyBackupRunning()) {
      const errorMsg = 'Cannot start bulk IMAP: Another backup operation is currently running';
      logger.warn('Bulk IMAP rejected - backup already running', {
        isRunning: this.isRunning,
        manualBackupRunning: this.manualBackupRunning,
        bulkImapRunning: this.bulkImapRunning,
        backupLock: this.backupLock
      });
      throw new Error(errorMsg);
    }

    this.bulkImapRunning = true;
    this.backupLock = true; // Set global backup lock
    logger.info('Bulk IMAP operation started with global lock - BLOCKING all scheduled backups');

    // Return immediately to allow frontend to start processing without delay
    // The frontend's pollBulkImapStatus function will handle the actual user processing
    // This ensures bulk operations run immediately and bypass the queue service entirely
  }

  // Enhanced scheduled backup check that respects bulk operations
  shouldRunScheduledBackup() {
    // Bulk IMAP operations have absolute priority - never interrupt them
    if (this.bulkImapRunning || this.backupLock) {
      logger.info('Scheduled backup skipped - bulk IMAP operation has priority', {
        bulkImapRunning: this.bulkImapRunning,
        backupLock: this.backupLock
      });
      return false;
    }

    // Also check for manual backups
    if (this.manualBackupRunning) {
      logger.info('Scheduled backup skipped - manual backup in progress');
      return false;
    }

    // Check if scheduled backup is already running (shouldn't happen but just in case)
    if (this.isRunning) {
      logger.warn('Scheduled backup skipped - already running');
      return false;
    }

    return true;
  }

  // Perform direct bulk IMAP processing for selected users (bypassing queue service)
  async performDirectBulkImapProcessing(userIds) {
    try {
      // SPECIFIC BULK LOG: Clear indication that bulk operation is starting
      logger.info('🚀 [BULK BACKUP START] Instant bulk backup processing initiated (bypassing queue service)', {
        operation: 'BULK_BACKUP_DIRECT',
        userCount: userIds.length,
        userIds: userIds,
        timestamp: new Date().toISOString()
      });

      // Get user emails for processing
      const { query } = require('../database/databaseService');
      const users = await query(
        'SELECT id, email FROM users WHERE id IN (?) AND status = ?',
        [userIds, 'active']
      );

      // SPECIFIC BULK LOG: Show which users will be processed
      logger.info('📋 [BULK BACKUP USERS] Found active users for instant bulk processing', {
        operation: 'BULK_BACKUP_DIRECT',
        count: users.length,
        users: users.map(u => u.email),
        timestamp: new Date().toISOString()
      });

      if (users.length === 0) {
        logger.info('⚠️ [BULK BACKUP SKIPPED] No active users found for bulk backup processing', {
          operation: 'BULK_BACKUP_DIRECT',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Process users sequentially to avoid overwhelming Gmail
      for (const user of users) {
        try {
          // SPECIFIC BULK LOG: Clear indication of bulk user processing
          logger.info(`🔄 [BULK BACKUP USER START] Processing user in bulk operation: ${user.email}`, {
            operation: 'BULK_BACKUP_DIRECT',
            userId: user.id,
            email: user.email,
            timestamp: new Date().toISOString()
          });

          // Clean up stale connections for specific user
          const isHealthy = await imapService.isConnectionHealthy(user.id);
          if (!isHealthy && imapService.connections.has(user.id)) {
            logger.warn('Existing connection unhealthy, forcing disconnect before bulk backup', { 
              userId: user.id, 
              email: user.email 
            });
            await imapService.forceDisconnect(user.id);
          }

          // Perform actual backup for the user
          await this.backupUserMailbox(user.id, user.email);

          // SPECIFIC BULK LOG: Success for individual user in bulk operation
          logger.info(`✅ [BULK BACKUP USER SUCCESS] Completed processing user: ${user.email}`, {
            operation: 'BULK_BACKUP_DIRECT',
            userId: user.id,
            email: user.email,
            timestamp: new Date().toISOString()
          });

          // Add delay between users to ensure complete cleanup and avoid rate limiting
          const delayBetweenUsers = 10000; // 10 seconds for better Gmail stability
          logger.info(`⏳ [BULK BACKUP DELAY] Waiting ${delayBetweenUsers/1000} seconds before next user`, {
            operation: 'BULK_BACKUP_DIRECT',
            currentUser: user.email,
            nextDelaySeconds: delayBetweenUsers/1000,
            timestamp: new Date().toISOString()
          });
          await new Promise(resolve => setTimeout(resolve, delayBetweenUsers));

        } catch (error) {
          // SPECIFIC BULK LOG: Error for individual user in bulk operation
          logger.error(`❌ [BULK BACKUP USER ERROR] Failed to process user: ${user.email}`, {
            operation: 'BULK_BACKUP_DIRECT',
            userId: user.id,
            email: user.email,
            error: error.message,
            timestamp: new Date().toISOString()
          });
          // Continue with next user even if one fails
        }
      }

      // SPECIFIC BULK LOG: Clear indication that bulk operation completed
      logger.info('🎉 [BULK BACKUP COMPLETED] Instant bulk backup processing finished successfully', {
        operation: 'BULK_BACKUP_DIRECT',
        userCount: users.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      // SPECIFIC BULK LOG: Error for entire bulk operation
      logger.error('💥 [BULK BACKUP FAILED] Instant bulk backup processing failed', {
        operation: 'BULK_BACKUP_DIRECT',
        error: error.message,
        stack: error.stack?.substring(0, 500),
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  // End bulk IMAP operation
  async endBulkImap() {
    this.bulkImapRunning = false;
    this.backupLock = false; // Release global backup lock
    logger.info('Bulk IMAP operation ended, global lock released');
  }

  // Stop manual backup operation
  async stopManualBackup() {
    this.manualBackupRunning = false;
    logger.info('Manual backup operation stopped');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      manualBackupRunning: this.manualBackupRunning,
      bulkImapRunning: this.bulkImapRunning,
      anyBackupRunning: this.isAnyBackupRunning(),
      nextRun: this.cronJob ? this.cronJob.nextRun : null,
    };
  }
}

const scheduledBackupService = new ScheduledBackupService();

function startScheduledBackup() {
  scheduledBackupService.startScheduledBackup();
}

function stopScheduledBackup() {
  scheduledBackupService.stopScheduledBackup();
}

function getScheduledBackupStatus() {
  return scheduledBackupService.getStatus();
}

async function runManualBackup(userId = null) {
  return await scheduledBackupService.manualBackup(userId);
}

module.exports = {
  ScheduledBackupService,
  scheduledBackupService,
  startScheduledBackup,
  stopScheduledBackup,
  getScheduledBackupStatus,
  runManualBackup,
  stopManualBackup: scheduledBackupService.stopManualBackup.bind(scheduledBackupService),
};
