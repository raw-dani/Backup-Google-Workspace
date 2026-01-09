const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const Queue = require('bull');
const archiver = require('archiver');
const { query } = require('../database/databaseService');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/pst-export.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

class PSTExportService {
  constructor() {
    this.exportDir = './exports';
    this.ensureExportDir();
    this.inMemoryQueue = []; // Fallback when Redis is not available
    this.processingExports = new Map(); // Track currently processing exports
    this.useRedis = false;

    // Initialize queue if Redis is available
    try {
      const redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        retryStrategy: (times) => {
          // If Redis connection fails, give up quickly
          if (times > 3) {
            return null; // Stop retrying
          }
          return Math.min(times * 200, 2000);
        },
        maxRetriesPerRequest: 1, // Fail fast if Redis is not available
      };

      this.exportQueue = new Queue('pst-exports', {
        redis: redisConfig,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      });
      
      // Test connection before proceeding
      this.exportQueue.waitUntilReady().then(() => {
        this.setupQueueProcessor();
        this.setupQueueEvents();
        this.useRedis = true;
        logger.info('PST Export queue initialized with Redis');
      }).catch((err) => {
        logger.warn('Redis not available, using in-memory queue', { error: err.message });
        this.cleanupQueue();
      });
    } catch (error) {
      logger.warn('Redis not available, using in-memory queue', { error: error.message });
      this.exportQueue = null;
    }
  }

  cleanupQueue() {
    if (this.exportQueue) {
      try {
        this.exportQueue.close();
      } catch (e) {
        // Ignore close errors
      }
      this.exportQueue = null;
    }
    this.useRedis = false;
  }

  setupQueueEvents() {
    if (!this.exportQueue) return;

    // Track job events for better logging
    this.exportQueue.on('completed', (job, result) => {
      logger.info('Export job completed', { jobId: job.id, exportId: job.data?.exportId });
    });

    this.exportQueue.on('failed', (job, error) => {
      // Don't log if export was manually deleted or cancelled
      if (error && error.message && !error.message.includes('Export not found')) {
        logger.error('Export job failed', { jobId: job.id, exportId: job.data?.exportId, error: error.message });
      }
    });

    this.exportQueue.on('stalled', (job) => {
      logger.warn('Export job stalled', { jobId: job.id, exportId: job.data?.exportId });
    });

    this.exportQueue.on('error', (error) => {
      // Only log meaningful errors, not connection blips
      if (error && error.message && error.message.length > 0) {
        logger.error('Queue error', { error: error.message });
      }
    });
  }

  ensureExportDir() {
    fsSync.mkdirSync(this.exportDir, { recursive: true });
  }

  setupQueueProcessor() {
    if (!this.exportQueue) return;

    this.exportQueue.process(async (job) => {
      const { exportId, userId, startDate, endDate, format } = job.data;

      try {
        logger.info('Processing export job', { exportId, userId, format });

        await this.updateExportStatus(exportId, 'processing');

        const result = await this.generateExport(userId, startDate, endDate, format, exportId);

        await this.updateExportStatus(exportId, 'completed', result.filePath);

        logger.info('Export completed', { exportId, ...result });

        return { success: true, ...result };
      } catch (error) {
        logger.error('Export failed', { exportId, error: error.message });
        await this.updateExportStatus(exportId, 'failed');
        throw error;
      }
    });
  }

  async createExport(userId, startDate = null, endDate = null, format = 'zip') {
    try {
      const exportId = uuidv4();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = format === 'pst' ? 'zip' : format; // ZIP for EMLs, or actual PST
      const filename = `backup_${userId}_${timestamp}.${extension}`;

      await query(
        `INSERT INTO pst_exports (id, user_id, filename, status, start_date, end_date, export_format, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, NOW())`,
        [exportId, userId, filename, startDate, endDate, format]
      );

      if (this.exportQueue) {
        await this.exportQueue.add({
          exportId,
          userId,
          startDate,
          endDate,
          format,
        });
      } else {
        // Run synchronously if no queue
        await this.updateExportStatus(exportId, 'processing');
        const result = await this.generateExport(userId, startDate, endDate, format, exportId);
        await this.updateExportStatus(exportId, 'completed', result.filePath);
      }

      logger.info('Export job created', { exportId, userId, format });

      return exportId;
    } catch (error) {
      logger.error('Failed to create export', { userId, error: error.message });
      throw error;
    }
  }

  async generateExport(userId, startDate, endDate, format, exportId) {
    try {
      // Get user info
      const users = await query('SELECT email FROM users WHERE id = ?', [userId]);
      if (users.length === 0) {
        throw new Error('User not found');
      }

      const userEmail = users[0].email;

      // Build query for emails
      let queryStr = 'SELECT * FROM emails WHERE user_id = ?';
      let params = [userId];

      if (startDate && endDate) {
        queryStr += ' AND date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }

      queryStr += ' ORDER BY date ASC';

      const emails = await query(queryStr, params);

      if (emails.length === 0) {
        throw new Error('No emails found for export');
      }

      logger.info('Found emails for export', { userId, count: emails.length, format });

      // Generate export based on format
      let filePath;
      if (format === 'eml') {
        filePath = await this.createEMLZip(emails, userEmail, exportId);
      } else if (format === 'pst') {
        // For PST, we create a ZIP with EMLs that can be imported
        filePath = await this.createPSTCompatibleZip(emails, userEmail, exportId);
      } else {
        // Default to EML ZIP
        filePath = await this.createEMLZip(emails, userEmail, exportId);
      }

      const stats = fsSync.statSync(filePath);

      return {
        filePath,
        emailCount: emails.length,
        fileSize: stats.size,
        format,
      };

    } catch (error) {
      logger.error('Failed to generate export', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Create a ZIP file with EML files organized by date folders
   * This can be imported to Outlook using File → Open & Export
   */
  async createEMLZip(emails, userEmail, exportId) {
    const zipPath = path.join(this.exportDir, `backup_${exportId}.zip`);
    const tempDir = path.join(this.exportDir, `temp_${exportId}`);
    const totalEmails = emails.length;

    try {
      // Create temp directory
      fsSync.mkdirSync(tempDir, { recursive: true });

      // Process emails in batches
      const batchSize = 50;
      let processedCount = 0;

      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);

        const promises = batch.map(async (email) => {
          try {
            // Create date-based folder structure
            const emailDate = new Date(email.date);
            const year = emailDate.getFullYear();
            const month = String(emailDate.getMonth() + 1).padStart(2, '0');
            const day = String(emailDate.getDate()).padStart(2, '0');

            const folderPath = path.join(tempDir, `${year}`, `${month}-${year}`, `${day}-${year}`);
            fsSync.mkdirSync(folderPath, { recursive: true });

            // Create safe filename
            const safeSubject = this.sanitizeFilename(email.subject || 'no-subject');
            const safeFrom = this.sanitizeFilename(email.from_email || 'unknown');
            const filename = `${safeFrom}_${safeSubject}_${Date.now()}.eml`;
            const filePath = path.join(folderPath, filename);

            // Copy or create EML file
            if (await this.fileExists(email.eml_path)) {
              await fs.copyFile(email.eml_path, filePath);
            } else {
              // Create EML file from database content if available
              await this.createEMLFile(filePath, email);
            }

            return true;
          } catch (error) {
            logger.warn('Failed to process email for export', {
              messageId: email.message_id,
              error: error.message
            });
            return false;
          }
        });

        const results = await Promise.all(promises);
        processedCount += results.filter(r => r).length;

        // Update progress in database
        const progress = Math.round((processedCount / totalEmails) * 90); // Max 90% for processing
        await this.updateExportStatus(exportId, 'processing', null, progress);

        logger.info(`Export batch progress: ${processedCount}/${totalEmails} (${Math.round((processedCount/totalEmails)*100)}%)`);
      }

      // Update progress to 95% while creating ZIP
      await this.updateExportStatus(exportId, 'processing', null, 95);

      // Create ZIP file
      await this.createZipArchive(tempDir, zipPath);

      // Clean up temp directory
      fsSync.rmSync(tempDir, { recursive: true, force: true });

      logger.info('EML ZIP created successfully', { zipPath, emailCount: processedCount });

      return zipPath;

    } catch (error) {
      // Clean up on error
      if (fsSync.existsSync(tempDir)) {
        fsSync.rmSync(tempDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /**
   * Create PST-compatible structure with Import instructions
   */
  async createPSTCompatibleZip(emails, userEmail, exportId) {
    const zipPath = path.join(this.exportDir, `pst_backup_${exportId}.zip`);
    const tempDir = path.join(this.exportDir, `pst_temp_${exportId}`);

    try {
      fsSync.mkdirSync(tempDir, { recursive: true });

      // Create EML files organized by year/month
      let processedCount = 0;
      const batchSize = 50;

      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);

        const promises = batch.map(async (email) => {
          try {
            const emailDate = new Date(email.date);
            const year = emailDate.getFullYear();
            const month = String(emailDate.getMonth() + 1).padStart(2, '0');

            const folderPath = path.join(tempDir, 'Emails', year.toString(), month);
            fsSync.mkdirSync(folderPath, { recursive: true });

            const safeSubject = this.sanitizeFilename(email.subject || 'no-subject');
            const filename = `${safeSubject}_${Date.now()}.eml`;
            const filePath = path.join(folderPath, filename);

            if (await this.fileExists(email.eml_path)) {
              await fs.copyFile(email.eml_path, filePath);
            } else {
              await this.createEMLFile(filePath, email);
            }

            return true;
          } catch (error) {
            return false;
          }
        });

        const results = await Promise.all(promises);
        processedCount += results.filter(r => r).length;
      }

      // Create IMPORT_INSTRUCTIONS.txt
      const instructions = this.generateImportInstructions(userEmail, processedCount);
      await fs.writeFile(path.join(tempDir, 'IMPORT_INSTRUCTIONS.txt'), instructions);

      // Create ZIP
      await this.createZipArchive(tempDir, zipPath);

      // Clean up
      fsSync.rmSync(tempDir, { recursive: true, force: true });

      logger.info('PST-compatible ZIP created', { zipPath, emailCount: processedCount });

      return zipPath;

    } catch (error) {
      if (fsSync.existsSync(tempDir)) {
        fsSync.rmSync(tempDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  generateImportInstructions(userEmail, emailCount) {
    return `
==============================================
  EMAIL BACKUP IMPORT INSTRUCTIONS
==============================================

Backup for: ${userEmail}
Total Emails: ${emailCount}
Date: ${new Date().toLocaleString()}

----------------------------------------------
METHOD 1: Import to Microsoft Outlook
----------------------------------------------

1. Extract the ZIP file
2. Open Microsoft Outlook
3. Go to File → Open & Export → Import/Export
4. Select "Import an Internet Mail and Address Book"
5. Choose "EML format" or "Outlook Data File (.pst)"
6. Select the extracted EML files folder
7. Complete the import process

----------------------------------------------
METHOD 2: Use Outlook's Auto-Import
----------------------------------------------

1. In Outlook, go to File → Open & Export
2. Click "Import/Export"
3. Select "Import from another program or file"
4. Choose "Outlook Data File (.pst)" for PST
5. Or "Comma Separated Values" for CSV

----------------------------------------------
METHOD 3: Direct EML Import
----------------------------------------------

1. Open Outlook
2. Drag and drop EML files into the folder
3. Or use File → Open → Open an Outlook Data File

==============================================
NOTE: This backup uses EML format which is
natively supported by Microsoft Outlook.
EML files can also be imported to:
- Thunderbird
- Windows Mail
- Apple Mail
- Other email clients
==============================================
`;
  }

  async createEMLFile(filePath, email) {
    const emlContent = `From: ${email.from_email}
To: ${email.to_email}
Subject: ${email.subject}
Date: ${new Date(email.date).toUTCString()}
Message-ID: ${email.message_id}
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

[Email content stored in backup at: ${email.eml_path}]

This is a backup record. Original EML file may be available in the backup directory.
`;

    await fs.writeFile(filePath, emlContent);
  }

  sanitizeFilename(filename) {
    if (!filename) return 'unknown';
    return filename
      .replace(/[^a-zA-Z0-9]/g, '_')
      .substring(0, 50);
  }

  async fileExists(filePath) {
    if (!filePath) return false;
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async createZipArchive(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      const output = fsSync.createWriteStream(outputPath);

      output.on('close', () => {
        logger.info('ZIP archive created', { outputPath, size: archive.pointer() });
        resolve(outputPath);
      });

      archive.on('error', (err) => {
        logger.error('ZIP creation failed', { error: err.message });
        reject(err);
      });

      archive.directory(sourceDir, false);
      archive.pipe(output);
      archive.finalize();
    });
  }

  async updateExportStatus(exportId, status, filePath = null, progress = null) {
    try {
      if (status === 'completed') {
        await query(
          'UPDATE pst_exports SET status = ?, file_path = ?, completed_at = NOW(), progress = 100 WHERE id = ?',
          [status, filePath, exportId]
        );
      } else if (progress !== null) {
        await query(
          'UPDATE pst_exports SET status = ?, progress = ? WHERE id = ?',
          [status, progress, exportId]
        );
      } else {
        await query(
          'UPDATE pst_exports SET status = ? WHERE id = ?',
          [status, exportId]
        );
      }
    } catch (error) {
      logger.error('Failed to update export status', { exportId, status, error: error.message });
    }
  }

  async getExportStatus(exportId) {
    try {
      const result = await query('SELECT * FROM pst_exports WHERE id = ?', [exportId]);
      return result[0] || null;
    } catch (error) {
      logger.error('Failed to get export status', { exportId, error: error.message });
      throw error;
    }
  }

  async getUserExports(userId) {
    try {
      return await query(
        'SELECT * FROM pst_exports WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
    } catch (error) {
      logger.error('Failed to get user exports', { userId, error: error.message });
      throw error;
    }
  }

  async deleteExport(exportId) {
    try {
      const exports = await query('SELECT file_path FROM pst_exports WHERE id = ?', [exportId]);
      if (exports.length === 0) {
        throw new Error('Export not found');
      }

      if (exports[0].file_path) {
        try {
          await fs.unlink(exports[0].file_path);
        } catch (error) {
          logger.warn('Failed to delete export file', { exportId });
        }
      }

      await query('DELETE FROM pst_exports WHERE id = ?', [exportId]);
      logger.info('Export deleted', { exportId });
    } catch (error) {
      logger.error('Failed to delete export', { exportId, error: error.message });
      throw error;
    }
  }

  async getQueueStatus() {
    if (!this.exportQueue) {
      // Fallback to in-memory tracking
      const processingCount = this.processingExports.size;
      return {
        available: false,
        message: 'Redis not configured',
        inMemoryQueue: this.inMemoryQueue.length,
        processing: processingCount,
        totalPending: this.inMemoryQueue.length + processingCount,
      };
    }

    try {
      const [waiting, active, completed, failed] = await Promise.all([
        this.exportQueue.getWaitingCount(),
        this.exportQueue.getActiveCount(),
        this.exportQueue.getCompletedCount(),
        this.exportQueue.getFailedCount(),
      ]);

      return {
        available: true,
        waiting,
        active,
        completed,
        failed,
        totalPending: waiting + active,
      };
    } catch (error) {
      logger.error('Failed to get queue status', { error: error.message });
      return {
        available: false,
        message: 'Failed to get queue status',
        error: error.message,
      };
    }
  }

  async retryExport(exportId) {
    try {
      const exportData = await this.getExportStatus(exportId);
      if (!exportData) {
        throw new Error('Export not found');
      }

      if (exportData.status !== 'failed') {
        throw new Error('Only failed exports can be retried');
      }

      // Reset status
      await this.updateExportStatus(exportId, 'pending');
      await query('UPDATE pst_exports SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?', [exportId]);

      // Re-queue the export
      if (this.exportQueue) {
        await this.exportQueue.add({
          exportId,
          userId: exportData.user_id,
          startDate: exportData.start_date,
          endDate: exportData.end_date,
          format: exportData.export_format || 'eml',
          retryAttempt: (exportData.retry_count || 0) + 1,
        });
      } else {
        // Run synchronously
        await this.updateExportStatus(exportId, 'processing');
        const result = await this.generateExport(
          exportData.user_id,
          exportData.start_date,
          exportData.end_date,
          exportData.export_format || 'eml',
          exportId
        );
        await this.updateExportStatus(exportId, 'completed', result.filePath);
      }

      logger.info('Export retry queued', { exportId, retryAttempt: (exportData.retry_count || 0) + 1 });

      return exportId;
    } catch (error) {
      logger.error('Failed to retry export', { exportId, error: error.message });
      throw error;
    }
  }

  async getFailedExports() {
    try {
      const result = await query(
        'SELECT * FROM pst_exports WHERE status = ? ORDER BY created_at DESC LIMIT 50',
        ['failed']
      );
      return result;
    } catch (error) {
      logger.error('Failed to get failed exports', { error: error.message });
      throw error;
    }
  }

  async cancelExport(exportId) {
    try {
      const exportData = await this.getExportStatus(exportId);
      if (!exportData) {
        throw new Error('Export not found');
      }

      if (exportData.status === 'completed') {
        throw new Error('Cannot cancel completed export');
      }

      if (exportData.status === 'cancelled') {
        throw new Error('Export is already cancelled');
      }

      // Update status to cancelled
      await query(
        'UPDATE pst_exports SET status = ?, cancelled_at = NOW(), updated_at = NOW() WHERE id = ?',
        ['cancelled', exportId]
      );

      // Remove from queue if Redis is available
      if (this.exportQueue) {
        const jobs = await this.exportQueue.getJobs(['waiting', 'active'], 0, 100);
        for (const job of jobs) {
          if (job.data.exportId === exportId) {
            await job.remove();
            break;
          }
        }
      }

      logger.info('Export cancelled', { exportId });

      return true;
    } catch (error) {
      logger.error('Failed to cancel export', { exportId, error: error.message });
      throw error;
    }
  }

  async close() {
    if (this.exportQueue) {
      await this.exportQueue.close();
    }
  }
}

const pstExportService = new PSTExportService();

process.on('SIGTERM', async () => {
  await pstExportService.close();
});

process.on('SIGINT', async () => {
  await pstExportService.close();
});

module.exports = {
  PSTExportService,
  pstExportService,
};
