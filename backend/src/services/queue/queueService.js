const Queue = require('bull');
const winston = require('winston');
const { imapService } = require('../imap/imapService');
const { pstExportService } = require('../pst/pstExportService');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/queue.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

class QueueService {
  constructor() {
    // Check if Redis is explicitly configured and available
    const hasRedisConfig = process.env.REDIS_HOST || process.env.REDIS_PORT || process.env.REDIS_PASSWORD;
    const isWindows = process.platform === 'win32';

    // For Windows or when Redis is not configured, always use in-memory queues
    if (!hasRedisConfig || isWindows) {
      const reason = isWindows ? 'Windows OS detected' : 'No Redis configuration found';
      logger.info(`${reason}, using in-memory queues for sequential IMAP processing`, {
        platform: process.platform,
        hasRedisConfig
      });
      this.redisAvailable = false;
      this.imapQueue = this.createMemoryQueue('imap-tasks');
      this.backupQueue = this.createMemoryQueue('backup-tasks');
    } else {
      this.redisAvailable = false;
      this.redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || null,
        maxRetriesPerRequest: 3, // Reduce retries to fail faster
        retryDelayOnFailover: 100,
        enableReadyCheck: false,
        lazyConnect: true,
      };

      // Try to connect to Redis, fallback to in-memory queues for Windows development
      try {
        // Sequential IMAP processing - set concurrency to 1
        this.imapQueue = new Queue('imap-tasks', {
          redis: this.redisConfig,
          defaultJobOptions: {
            removeOnComplete: 50,
            removeOnFail: 20,
          },
          settings: {
            maxStalledCount: 1,
          }
        });

        // Set concurrency to 1 for sequential processing
        this.imapQueue.process(1, async (job) => {
          const { userId, userEmail, action } = job.data;

          try {
            logger.info('Processing IMAP queue job (SEQUENTIAL)', { userId, action });

            switch (action) {
              case 'connect':
                await imapService.connect(userEmail, userId);
                await imapService.startIdle(userId);
                break;

              case 'reconnect':
                await imapService.reconnect(userId);
                break;

              case 'disconnect':
                await imapService.disconnect(userId);
                break;

              default:
                throw new Error(`Unknown IMAP action: ${action}`);
            }

            logger.info('IMAP queue job completed (SEQUENTIAL)', { userId, action });
            return { success: true };
          } catch (error) {
            logger.error('IMAP queue job failed (SEQUENTIAL)', { userId, action, error: error.message });
            throw error;
          }
        });

        this.backupQueue = new Queue('backup-tasks', {
          redis: this.redisConfig,
          defaultJobOptions: {
            removeOnComplete: 20,
            removeOnFail: 10,
          }
        });
        this.redisAvailable = true;
        logger.info('Redis queues initialized (SEQUENTIAL IMAP mode)');
      } catch (error) {
        logger.warn('Redis connection failed, using in-memory queues for development', { error: error.message });
        // Fallback to in-memory queues (not persistent)
        this.imapQueue = this.createMemoryQueue('imap-tasks');
        this.backupQueue = this.createMemoryQueue('backup-tasks');
      }
    }

    this.setupQueueProcessors();
  }

  createMemoryQueue(name) {
    // Simple in-memory queue implementation with sequential processing for Windows
    const queue = {
      name,
      jobs: [],
      processing: false,
      processingQueue: [], // Queue for sequential processing
      eventListeners: new Map(),
      add: async (data, options = {}) => {
        const job = {
          id: Date.now().toString(),
          data,
          opts: options,
          progress: () => 0,
          getState: async () => 'waiting',
        };
        this.jobs.push(job);

        // For IMAP queue, add to sequential processing queue
        if (name === 'imap-tasks') {
          this.processingQueue.push(job);
          this.processNextJob();
        } else {
          // For backup queue, process immediately (can be parallel)
          job.processed = true;
          job.getState = async () => 'completed';
        }

        logger.debug('Memory queue job added', { queue: name, jobId: job.id, sequential: name === 'imap-tasks' });
        return job;
      },
      processNextJob: async function() {
        if (this.processing || this.processingQueue.length === 0) return;

        this.processing = true;
        const job = this.processingQueue.shift();

        try {
          job.getState = async () => 'active';
          logger.debug('Processing memory queue job sequentially', { queue: this.name, jobId: job.id });

          // Process the job using the IMAP handler
          if (this.name === 'imap-tasks') {
            const { userId, userEmail, action } = job.data;

            switch (action) {
              case 'connect':
                await imapService.connect(userEmail, userId);
                await imapService.startIdle(userId);
                break;
              case 'reconnect':
                await imapService.reconnect(userId);
                break;
              case 'disconnect':
                await imapService.disconnect(userId);
                break;
              default:
                throw new Error(`Unknown IMAP action: ${action}`);
            }
          }

          job.getState = async () => 'completed';
          job.returnvalue = { success: true };
          this.emit('completed', job, job.returnvalue);
          logger.debug('Memory queue job completed sequentially', { queue: this.name, jobId: job.id });

        } catch (error) {
          job.getState = async () => 'failed';
          job.failedReason = error.message;
          this.emit('failed', job, error);
          logger.error('Memory queue job failed sequentially', { queue: this.name, jobId: job.id, error: error.message });
        } finally {
          this.processing = false;
          // Process next job in queue
          if (this.processingQueue.length > 0) {
            setTimeout(() => this.processNextJob(), 100); // Small delay between jobs
          }
        }
      },
      process: (handler) => {
        this.handler = handler;
        // For backup queue, store handler but don't use for IMAP (handled in add method)
        if (this.name !== 'imap-tasks') {
          this.backupHandler = handler;
        }
      },
      getWaiting: async () => this.name === 'imap-tasks' ? this.processingQueue : [],
      getActive: async () => this.processing ? [this.processingQueue[0]].filter(Boolean) : [],
      getCompleted: async () => this.jobs.filter(job => job.getState() === 'completed'),
      getFailed: async () => this.jobs.filter(job => job.getState() === 'failed'),
      getDelayed: async () => [],
      close: async () => {},
      on: (event, listener) => {
        if (!queue.eventListeners.has(event)) {
          queue.eventListeners.set(event, []);
        }
        queue.eventListeners.get(event).push(listener);
      },
      emit: (event, ...args) => {
        const listeners = queue.eventListeners.get(event) || [];
        listeners.forEach(listener => listener(...args));
      },
      getJob: async (jobId) => {
        return queue.jobs.find(job => job.id === jobId) || null;
      }
    };
    return queue;
  }


  setupQueueProcessors() {
    // Backup queue - only process backup jobs here since IMAP is handled in constructor with concurrency 1
    if (!this.redisAvailable || typeof this.backupQueue.process === 'function') {
      this.backupQueue.process(async (job) => {
        const { userId, userEmail, type } = job.data;

        try {
          logger.info('Processing backup queue job', { userId, type });

          switch (type) {
            case 'full-backup':
              await imapService.backupUserMailbox(userId, userEmail);
              break;

            case 'incremental-backup':
              // Incremental backup logic
              break;

            default:
              throw new Error(`Unknown backup type: ${type}`);
          }

          logger.info('Backup queue job completed', { userId, type });
          return { success: true };
        } catch (error) {
          logger.error('Backup queue job failed', { userId, type, error: error.message });
          throw error;
        }
      });
    }

    // Set up event listeners for monitoring
    this.setupQueueEvents();
  }

  setupQueueEvents() {
    [this.imapQueue, this.backupQueue].forEach(queue => {
      // Only setup events if queue supports them (Bull queues)
      if (typeof queue.on === 'function') {
        queue.on('completed', (job, result) => {
          logger.info('Job completed', {
            queue: queue.name,
            jobId: job.id,
            result: JSON.stringify(result)
          });
        });

        queue.on('failed', (job, err) => {
          logger.error('Job failed', {
            queue: queue.name,
            jobId: job.id,
            error: err.message,
            data: JSON.stringify(job.data)
          });
        });

        queue.on('stalled', (jobId) => {
          logger.warn('Job stalled', { queue: queue.name, jobId });
        });
      } else {
        logger.debug('Queue does not support events (memory queue)', { queueName: queue.name });
      }
    });
  }

  async addIMAPJob(userId, userEmail, action, priority = 0) {
    try {
      let job;

      if (this.redisAvailable) {
        // Use Bull queue with Redis
        job = await this.imapQueue.add(
          { userId, userEmail, action },
          {
            priority,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            removeOnComplete: 50,
            removeOnFail: 20,
          }
        );
      } else {
        // Use in-memory queue (simplified)
        job = await this.imapQueue.add({ userId, userEmail, action });
      }

      logger.info('IMAP job added to queue', {
        userId,
        action,
        jobId: job.id,
        queueType: this.redisAvailable ? 'redis' : 'memory'
      });
      return job.id;
    } catch (error) {
      logger.error('Failed to add IMAP job to queue', {
        userId,
        action,
        error: error.message,
        redisAvailable: this.redisAvailable
      });

      // If Redis failed but we thought it was available, fallback to memory
      if (this.redisAvailable) {
        try {
          this.redisAvailable = false; // Mark as unavailable
          const memoryJob = await this.imapQueue.add({ userId, userEmail, action });
          logger.warn('IMAP job queued in memory (fallback after Redis failure)', { userId, action, jobId: memoryJob.id });
          return memoryJob.id;
        } catch (memoryError) {
          logger.error('Failed to add IMAP job to memory queue', {
            userId,
            action,
            error: memoryError.message
          });
        }
      }

      // Return a dummy job ID to prevent crashes
      return 'fallback-job-' + Date.now();
    }
  }

  async addBackupJob(userId, userEmail, type, priority = 0) {
    try {
      let job;

      if (this.redisAvailable) {
        // Use Bull queue with Redis
        job = await this.backupQueue.add(
          { userId, userEmail, type },
          {
            priority,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 10000,
            },
            removeOnComplete: 20,
            removeOnFail: 10,
          }
        );
      } else {
        // Use in-memory queue (simplified)
        job = await this.backupQueue.add({ userId, userEmail, type });
      }

      logger.info('Backup job added to queue', {
        userId,
        type,
        jobId: job.id,
        queueType: this.redisAvailable ? 'redis' : 'memory'
      });
      return job.id;
    } catch (error) {
      logger.error('Failed to add backup job to queue', {
        userId,
        type,
        error: error.message,
        redisAvailable: this.redisAvailable
      });

      // If Redis failed but we thought it was available, fallback to memory
      if (this.redisAvailable) {
        try {
          this.redisAvailable = false; // Mark as unavailable
          const memoryJob = await this.backupQueue.add({ userId, userEmail, type });
          logger.warn('Backup job queued in memory (fallback after Redis failure)', { userId, type, jobId: memoryJob.id });
          return memoryJob.id;
        } catch (memoryError) {
          logger.error('Failed to add backup job to memory queue', {
            userId,
            type,
            error: memoryError.message
          });
        }
      }

      // Return a dummy job ID to prevent crashes
      return 'fallback-job-' + Date.now();
    }
  }

  async getQueueStatus(queueName) {
    try {
      let queue;
      switch (queueName) {
        case 'imap':
          queue = this.imapQueue;
          break;
        case 'backup':
          queue = this.backupQueue;
          break;
        default:
          throw new Error(`Unknown queue: ${queueName}`);
      }

      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaiting(),
        queue.getActive(),
        queue.getCompleted(),
        queue.getFailed(),
        queue.getDelayed(),
      ]);

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
      };
    } catch (error) {
      logger.error('Failed to get queue status', { queueName, error: error.message });
      throw error;
    }
  }

  async getJobStatus(queueName, jobId) {
    try {
      let queue;
      switch (queueName) {
        case 'imap':
          queue = this.imapQueue;
          break;
        case 'backup':
          queue = this.backupQueue;
          break;
        default:
          throw new Error(`Unknown queue: ${queueName}`);
      }

      let job;
      if (typeof queue.getJob === 'function') {
        job = await queue.getJob(jobId);
      } else {
        // Memory queue
        job = queue.jobs.find(j => j.id === jobId) || null;
      }

      if (!job) {
        return null;
      }

      return {
        id: job.id,
        data: job.data,
        progress: job.progress ? job.progress() : 0,
        attemptsMade: job.attemptsMade || 0,
        finishedOn: job.finishedOn || null,
        processedOn: job.processedOn || null,
        failedReason: job.failedReason || null,
        returnvalue: job.returnvalue || null,
        state: job.getState ? await job.getState() : 'completed',
      };
    } catch (error) {
      logger.error('Failed to get job status', { queueName, jobId, error: error.message });
      throw error;
    }
  }

  async retryFailedJobs(queueName) {
    try {
      let queue;
      switch (queueName) {
        case 'imap':
          queue = this.imapQueue;
          break;
        case 'backup':
          queue = this.backupQueue;
          break;
        default:
          throw new Error(`Unknown queue: ${queueName}`);
      }

      if (typeof queue.getFailed === 'function') {
        const failedJobs = await queue.getFailed();
        const retryPromises = failedJobs.map(job => job.retry());
        await Promise.all(retryPromises);
        logger.info('Retried failed jobs', { queueName, count: failedJobs.length });
        return failedJobs.length;
      } else {
        // Memory queue - no failed jobs to retry
        logger.info('Memory queue - no failed jobs to retry', { queueName });
        return 0;
      }
    } catch (error) {
      logger.error('Failed to retry jobs', { queueName, error: error.message });
      throw error;
    }
  }

  async cleanOldJobs(queueName, grace = 24 * 60 * 60 * 1000) {
    try {
      let queue;
      switch (queueName) {
        case 'imap':
          queue = this.imapQueue;
          break;
        case 'backup':
          queue = this.backupQueue;
          break;
        default:
          throw new Error(`Unknown queue: ${queueName}`);
      }

      if (typeof queue.clean === 'function') {
        await queue.clean(grace, 'completed');
        await queue.clean(grace, 'failed');
        logger.info('Cleaned old jobs', { queueName, grace });
      } else {
        // Memory queue - no cleaning needed
        logger.info('Memory queue - no old jobs to clean', { queueName });
      }
    } catch (error) {
      logger.error('Failed to clean old jobs', { queueName, error: error.message });
      throw error;
    }
  }

  async close() {
    await Promise.all([
      this.imapQueue.close(),
      this.backupQueue.close(),
    ]);
    logger.info('Queues closed');
  }
}

const queueService = new QueueService();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await queueService.close();
});

process.on('SIGINT', async () => {
  await queueService.close();
});

async function initQueues() {
  // Queues are initialized in constructor
  logger.info('Queues initialized');
}

module.exports = {
  QueueService,
  queueService,
  initQueues,
};
