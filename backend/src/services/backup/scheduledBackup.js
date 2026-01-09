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
    this.cronJob = null;
    this.useRealGmail = process.env.USE_REAL_GMAIL === 'true';
    this.backupInterval = process.env.BACKUP_INTERVAL || '60'; // Default 60 minutes
    this.maxConcurrentUsers = parseInt(process.env.MAX_CONCURRENT_USERS || '3'); // Default 3 concurrent users
    this.batchSize = parseInt(process.env.BATCH_SIZE || '5'); // Default 5 messages per batch
    this.batchDelay = parseInt(process.env.BATCH_DELAY || '2000'); // Default 2 seconds delay between batches

    const mode = this.useRealGmail ? 'PRODUCTION (Real Gmail)' : 'DEVELOPMENT (Simulated)';
    logger.info(`Scheduled Backup Service initialized in ${mode} mode`);
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
        const mode = this.useRealGmail ? 'REAL' : 'SIMULATED';
        logger.info(`Starting scheduled backup (${mode})`);

        await this.performBackup();

        logger.info(`Scheduled backup (${mode}) completed successfully`);
      } catch (error) {
        logger.error('Scheduled backup failed', { error: error.message });
      } finally {
        this.isRunning = false;
      }
    });

    const mode = this.useRealGmail ? 'PRODUCTION (Real Gmail)' : 'DEVELOPMENT (Simulated)';
    logger.info(`Scheduled backup service started (${mode} - runs every ${intervalMinutes} minutes)`);
  }

  async performBackup() {
    try {
      // Get all active users
      const users = await query(
        'SELECT id, email FROM users WHERE status = ?',
        ['active']
      );

      const mode = this.useRealGmail ? 'REAL' : 'SIMULATED';
      logger.info(`Found users for ${mode} backup`, { count: users.length });

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

      for (const batch of concurrentBatches) {
        logger.info(`Processing concurrent batch of ${batch.length} users`);

        // Process batch concurrently
        const batchPromises = batch.map(user =>
          this.backupUserMailbox(user.id, user.email).catch(error => {
            logger.error(`Failed to backup user mailbox (${mode})`, {
              userId: user.id,
              email: user.email,
              error: error.message
            });
            return null; // Don't fail the entire batch
          })
        );

        await Promise.all(batchPromises);

        // Add delay between concurrent batches to be respectful to Google
        if (concurrentBatches.indexOf(batch) < concurrentBatches.length - 1) {
          logger.info(`Waiting before processing next concurrent batch...`);
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay between batches
        }
      }

      logger.info(`All user backups completed (${mode})`);
    } catch (error) {
      logger.error('Failed to perform scheduled backup', { error: error.message });
      throw error;
    }
  }

  async backupUserMailbox(userId, userEmail) {
    if (this.useRealGmail) {
      return this.backupRealMailbox(userId, userEmail);
    } else {
      return this.backupSimulatedMailbox(userId, userEmail);
    }
  }

  async backupSimulatedMailbox(userId, userEmail) {
    try {
      logger.info('Starting SIMULATED mailbox backup', { userEmail });

      // Simulate finding some messages
      const simulatedMessageCount = Math.floor(Math.random() * 5) + 1; // 1-5 messages
      logger.info('Simulated backup found messages', { userEmail, count: simulatedMessageCount });

      // Create simulated email records in database
      for (let i = 0; i < simulatedMessageCount; i++) {
        const messageId = `simulated-${userId}-${Date.now()}-${i}`;
        const subject = `Simulated Email ${i + 1}`;
        const fromEmail = `sender${i + 1}@example.com`;
        const toEmail = userEmail;
        const emailDate = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000); // Random date within last week

        // Check if message already exists (simulate duplicate prevention)
        const existing = await query('SELECT id FROM emails WHERE message_id = ?', [messageId]);
        if (existing.length > 0) {
          continue; // Skip duplicate
        }

        // Create simulated .eml file path
        const year = emailDate.getFullYear();
        const month = String(emailDate.getMonth() + 1).padStart(2, '0');
        const domain = userEmail.split('@')[1];
        const userPart = userEmail.split('@')[0];
        const emlPath = `backup/${domain}/${userPart}/${year}/${month}/${messageId}.eml`;

        // Insert email record
        await query(
          `INSERT INTO emails
           (user_id, message_id, subject, from_email, to_email, date, eml_path, size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, messageId, subject, fromEmail, toEmail, emailDate, emlPath, Math.floor(Math.random() * 10000) + 1000]
        );

        // Update last UID to simulate progression
        const currentUid = await imapService.getLastUid(userId);
        await imapService.updateLastUid(userId, currentUid + 1);
      }

      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 500));

      logger.info('Simulated backup completed', { userEmail, processed: simulatedMessageCount });
    } catch (error) {
      logger.error('Failed to perform simulated mailbox backup', {
        userId,
        userEmail,
        error: error.message
      });
      throw error;
    }
  }

  async backupRealMailbox(userId, userEmail) {
    try {
      logger.info('Starting REAL mailbox backup', { userEmail });

      // Connect to IMAP
      const { imap } = await imapService.connect(userEmail, userId);

      try {
        // Open INBOX
        await imapService.openMailbox(imap, 'INBOX');

        // Get last UID from database
        const lastUid = await imapService.getLastUid(userId);

        // Search for messages since last UID
        const searchCriteria = lastUid > 0 ? [['UID', `${lastUid + 1}:*`]] : ['ALL'];
        const results = await imapService.searchMessages(imap, searchCriteria);

        if (results.length === 0) {
          logger.info('No new messages to backup (REAL)', { userEmail });
          return;
        }

        logger.info('Found messages to backup (REAL)', { userEmail, count: results.length });

        // Process messages in small batches to avoid being flagged as suspicious
        for (let i = 0; i < results.length; i += this.batchSize) {
          const batch = results.slice(i, i + this.batchSize);
          logger.info(`Processing batch ${Math.floor(i/this.batchSize) + 1} of ${Math.ceil(results.length/this.batchSize)} (${batch.length} messages)`);

          // Process batch sequentially to be more respectful to Google
          for (const uid of batch) {
            try {
              await imapService.fetchAndStoreMessage(imap, uid, userId, userEmail);
              // Small delay between individual messages
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
              logger.error('Failed to fetch message in batch', { uid, userEmail, error: error.message });
            }
          }

          // Longer delay between batches to prevent rate limiting
          if (i + this.batchSize < results.length) {
            logger.info(`Waiting ${this.batchDelay}ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, this.batchDelay));
          }
        }

        logger.info('REAL mailbox backup completed', { userEmail, processed: results.length });

      } finally {
        // Close IMAP connection
        imap.end();
      }

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
    try {
      const mode = this.useRealGmail ? 'REAL' : 'SIMULATED';
      logger.info(`Starting manual backup (${mode})`, { userId });

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

      logger.info(`Manual backup (${mode}) completed successfully`);
    } catch (error) {
      logger.error('Manual backup failed', { error: error.message });
      throw error;
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
