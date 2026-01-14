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
      if (this.isRunning) {
        logger.warn('Scheduled backup already running, skipping');
        return;
      }

      try {
        this.isRunning = true;
        logger.info('Starting scheduled backup (REAL)');

        await this.performBackup();

        logger.info('Scheduled backup (REAL) completed successfully');
      } catch (error) {
        logger.error('Scheduled backup failed', { error: error.message });
      } finally {
        this.isRunning = false;
      }
    });

    logger.info(`Scheduled backup service started (PRODUCTION (Real Gmail) - runs every ${intervalMinutes} minutes)`);
  }

  async performBackup() {
    try {
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
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay between users

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

  getStatus() {
    return {
      isRunning: this.isRunning,
      manualBackupRunning: this.manualBackupRunning,
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
};
