const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { oauth2Service } = require('../auth/oauth2Service');
const { query } = require('../database/databaseService');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/imap.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Rate limiter untuk Google Workspace compliance - Sequential IMAP mode
// Values can be overridden via environment variables with better defaults
const RATE_LIMITS = {
  MAX_CONCURRENT_CONNECTIONS: parseInt(process.env.MAX_CONCURRENT_CONNECTIONS || '2'), // Increased to 2 for better recovery
  IDLE_REFRESH_INTERVAL: 25 * 60 * 1000,
  BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '50'), // Reduced batch size for stability
  FETCH_TIMEOUT: parseInt(process.env.FETCH_TIMEOUT || '120000'), // 2 minutes for large batches
  RETRY_ATTEMPTS: 5, // Increased retry attempts
  RETRY_DELAY: parseInt(process.env.RETRY_DELAY || '3000'), // Increased base delay
  MAX_RETRY_DELAY: 30000, // Maximum delay between retries
  FETCH_DELAY: parseInt(process.env.FETCH_DELAY || '800'), // Delay between individual fetches
};

class ImapService {
  constructor() {
    this.connections = new Map();
    this.isProcessing = new Map();
    this.pendingConnections = 0; // Counter khusus untuk proses handshake
    this.connectionQueue = []; // Queue for connection requests when pool is full
    this.backupDir = process.env.BACKUP_DIR || './backup';

    // OPTIMASI: Cache Message-ID untuk menghindari query database berulang
    // Batasi ukuran cache untuk mencegah memory exhaustion
    this.messageIdCache = new Map(); // userId -> Set of messageIds
    this.cacheExpiry = new Map(); // userId -> expiry timestamp
    this.maxCacheSize = 50000; // Batasi maksimal 50K Message-ID per user untuk mailbox besar

    // Always use real Gmail mode - no development mode
    logger.info('IMAP Service initialized in PRODUCTION (Real Gmail) mode', {
      maxConcurrentConnections: RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS,
      batchSize: RATE_LIMITS.BATCH_SIZE,
      fetchTimeout: RATE_LIMITS.FETCH_TIMEOUT,
      retryDelay: RATE_LIMITS.RETRY_DELAY,
      environmentCheck: {
        MAX_CONCURRENT_CONNECTIONS: process.env.MAX_CONCURRENT_CONNECTIONS || 'default(2)',
        NODE_ENV: process.env.NODE_ENV
      }
    });

    // Setup global error handlers for IMAP connections
    this.setupGlobalErrorHandlers();

    // Start periodic cleanup of dead connections
    this.startConnectionCleanup();
  }

  // Setup global error handlers to prevent application crashes
  setupGlobalErrorHandlers() {
    process.on('uncaughtException', (error) => {
      if (error.code === 'ETIMEOUT' || error.message?.includes('Socket timeout')) {
        logger.error('Uncaught socket timeout error caught globally', {
          error: error.message,
          code: error.code,
          stack: error.stack?.substring(0, 500)
        });
        // Don't exit process, just log and continue
        return;
      }
      // Re-throw other uncaught exceptions
      throw error;
    });

    process.on('unhandledRejection', (reason, promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      if (error.code === 'ETIMEOUT' || error.message?.includes('Socket timeout')) {
        logger.error('Unhandled socket timeout rejection caught globally', {
          error: error.message,
          code: error.code,
          stack: error.stack?.substring(0, 500)
        });
        // Don't exit process, just log and continue
        return;
      }
      // Re-throw other unhandled rejections
      throw reason;
    });
  }

  // --- SLOT MANAGEMENT (SELF-HEALING) ---
  async acquireConnectionSlot() {
    const maxWait = 120000; // Increased to 2 minutes for queued requests
    let waited = 0;

    // LOGGING: Track slot acquisition attempts
    logger.debug('Attempting to acquire connection slot', {
      activeConnections: this.connections.size,
      pendingConnections: this.pendingConnections,
      maxConcurrent: RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS,
      currentTotal: this.connections.size + this.pendingConnections,
      queueLength: this.connectionQueue.length,
      timestamp: new Date().toISOString()
    });

    // Slot dihitung dari: Koneksi Aktif di Map + Proses yang sedang Connecting
    while ((this.connections.size + this.pendingConnections) >= RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS) {
      if (waited >= maxWait) {
        // LOGGING: Pool exhaustion details
        logger.error('Connection pool exhausted - detailed analysis', {
          activeConnections: this.connections.size,
          pendingConnections: this.pendingConnections,
          maxConcurrent: RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS,
          waitedMs: waited,
          connectionIds: Array.from(this.connections.keys()),
          queueLength: this.connectionQueue.length,
          timestamp: new Date().toISOString()
        });

        // Jika stuck lebih dari 2 menit padahal Map kosong, paksa reset pending counter
        if (this.connections.size === 0 && this.pendingConnections > 0) {
          logger.warn('Force resetting pending connection counter (Stuck detected)');
          this.pendingConnections = 0;
          break;
        }
        throw new Error('Connection pool exhausted, please try again later');
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      waited += 2000;
    }
    this.pendingConnections++;

    // LOGGING: Slot acquired successfully
    logger.debug('Connection slot acquired', {
      activeConnections: this.connections.size,
      pendingConnections: this.pendingConnections,
      queueLength: this.connectionQueue.length,
      timestamp: new Date().toISOString()
    });

    return true;
  }

  releasePendingSlot() {
    if (this.pendingConnections > 0) this.pendingConnections--;
    logger.info(`Slot Status - Active: ${this.connections.size}, Pending: ${this.pendingConnections}`);
  }

  releaseConnectionSlot() {
    // This method is called when a connection is removed from the active connections map
    // The slot counting is handled by the Map size, so no additional action needed here
    // But we log the current status for monitoring
    logger.debug(`Connection slot released - Active: ${this.connections.size}, Pending: ${this.pendingConnections}`);
  }

  // Periodic cleanup of dead/stale connections - DISABLED for Gmail IMAP stability
  startConnectionCleanup() {
    // Temporarily disable automatic connection cleanup for Gmail IMAP
    // to prevent aggressive disconnection during backup operations
    logger.info('Connection cleanup DISABLED for Gmail IMAP stability', {
      reason: 'Preventing aggressive disconnections during backup',
      note: 'Connections will be cleaned up only when explicitly needed'
    });

    // Keep the method structure but don't start the interval
    // Manual cleanup can still be called if needed
    this.manualCleanup = async () => {
      try {
        const now = Date.now();
        const staleThreshold = 60 * 60 * 1000; // 1 hour for manual cleanup
        let cleanedCount = 0;

        for (const [userId, connection] of this.connections.entries()) {
          const lastActivity = connection.lastActivity || connection.connectedAt || 0;
          const timeSinceActivity = now - lastActivity;

          // Only check for very stale connections (1 hour+)
          if (timeSinceActivity > staleThreshold) {
            logger.warn('Manual cleanup of very stale connection', {
              userId,
              userEmail: connection.userEmail,
              timeSinceActivity: Math.floor(timeSinceActivity / 1000),
              threshold: Math.floor(staleThreshold / 1000),
              connectionState: connection.imap?.state,
              connectionId: connection.connectionId
            });

            await this.forceDisconnect(userId);
            cleanedCount++;
          }
        }

        if (cleanedCount > 0) {
          logger.info('Manual connection cleanup completed', {
            cleanedCount,
            remainingConnections: this.connections.size
          });
        }
      } catch (error) {
        logger.error('Error during manual connection cleanup', { error: error.message });
      }
    };
  }

  // REKOMENDASI: Pindahkan fungsi sanitasi ke level class atau utility
  sanitizeForDb(text) {
    if (!text) return null;
    return text
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') // Hapus Emoji (Karakter 4-byte)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '') // Hapus Control Chars
      .substring(0, 500); // Batasi panjang subjek/email
  }

  // OPTIMASI: Load Message-ID cache untuk user tertentu
  async loadMessageIdCache(userId, forceReload = false) {
    try {
      const now = Date.now();
      const cacheExpiry = this.cacheExpiry.get(userId);

      // Cek apakah cache masih valid (5 menit)
      if (!forceReload && cacheExpiry && (now - cacheExpiry) < 5 * 60 * 1000) {
        logger.debug('Using cached Message-IDs', { userId, cacheAge: Math.floor((now - cacheExpiry) / 1000) });
        return this.messageIdCache.get(userId) || new Set();
      }

      // Load Message-IDs dari database
      logger.info('Loading Message-ID cache from database', { userId });
      const results = await query('SELECT message_id FROM emails WHERE user_id = ?', [userId]);

      const messageIds = new Set();
      if (Array.isArray(results)) {
        results.forEach(row => {
          if (row.message_id) {
            messageIds.add(row.message_id);
          }
        });
      }

      // Simpan ke cache
      this.messageIdCache.set(userId, messageIds);
      this.cacheExpiry.set(userId, now);

      logger.info('Message-ID cache loaded', { userId, totalMessageIds: messageIds.size });
      return messageIds;

    } catch (error) {
      logger.error('Failed to load Message-ID cache', { userId, error: error.message });
      return new Set(); // Return empty set on error
    }
  }

  // ENHANCED: Check if user has emails to sync with smart comparison
  async checkUserHasEmailsToSync(userId, userEmail) {
    try {
      // Get current DB count
      const dbStats = await query('SELECT COUNT(*) as dbCount FROM emails WHERE user_id = ?', [userId]);
      const dbCount = dbStats[0]?.dbCount || 0;

      // Get Gmail count by connecting temporarily
      const { imap } = await this.connect(userEmail, userId);
      let gmailCount = 0;

      try {
        // Get all folders and count messages in each
        const folders = await this.listFolders(imap);
        for (const folder of folders) {
          try {
            await this.openMailbox(imap, folder, true);
            const mailbox = await imap.mailboxOpen(folder, { readOnly: true });
            if (mailbox && mailbox.exists !== undefined) {
              gmailCount += mailbox.exists;
            }
          } catch (folderError) {
            logger.warn('Failed to count messages in folder', {
              userEmail, folder, error: folderError.message
            });
            // Continue with other folders
          }
        }
      } finally {
        // Always disconnect after counting
        await this.disconnect(userId);
      }

      // If counts match, no need to sync
      if (dbCount === gmailCount) {
        logger.info(`✅ ${userEmail}: DB (${dbCount}) matches Gmail (${gmailCount}) - no sync needed`);
        return false;
      }

      // If DB has more than Gmail (shouldn't happen), force full sync
      if (dbCount > gmailCount) {
        logger.warn(`⚠️ ${userEmail}: DB (${dbCount}) > Gmail (${gmailCount}) - forcing full sync`);
        return true;
      }

      // Calculate difference
      const emailsToSync = gmailCount - dbCount;
      logger.info(`📥 ${userEmail}: ${emailsToSync} new emails to sync (DB: ${dbCount}, Gmail: ${gmailCount})`);
      return emailsToSync > 0;

    } catch (error) {
      logger.error(`❌ Error checking sync status for ${userEmail}:`, error);
      // If we can't determine, assume we need to sync
      return true;
    }
  }

  // OPTIMASI: Clear Message-ID cache untuk user tertentu
  clearMessageIdCache(userId = null) {
    if (userId) {
      // Clear cache untuk user tertentu
      this.messageIdCache.delete(userId);
      this.cacheExpiry.delete(userId);
      logger.debug('Message-ID cache cleared for user', { userId });
    } else {
      // Clear semua cache
      this.messageIdCache.clear();
      this.cacheExpiry.clear();
      logger.info('All Message-ID caches cleared');
    }
  }

  // OPTIMASI: Get cache statistics
  getCacheStats() {
    const stats = {
      totalUsersCached: this.messageIdCache.size,
      cacheDetails: []
    };

    for (const [userId, messageIds] of this.messageIdCache.entries()) {
      const expiry = this.cacheExpiry.get(userId);
      const age = expiry ? Math.floor((Date.now() - expiry) / 1000) : 0;
      stats.cacheDetails.push({
        userId,
        messageIdCount: messageIds.size,
        cacheAgeSeconds: age,
        isExpired: age > 300 // 5 minutes
      });
    }

    return stats;
  }

  // RESUME: Parse UID terakhir yang berhasil dari log terbaru
  async getLastSuccessfulUidFromLog(userEmail, folder = 'INBOX') {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Path log file
      const logPath = path.join(process.cwd(), 'logs', 'imap.log');

      // Cek apakah file log ada
      try {
        await fs.access(logPath);
      } catch (error) {
        logger.debug('Log file not found, cannot resume from log', { logPath });
        return 0;
      }

      // Baca log file (ambil 10MB terakhir untuk performa)
      const logContent = await fs.readFile(logPath, 'utf8');
      const lines = logContent.split('\n').reverse(); // Dari bawah ke atas (terbaru)

      // Cari pattern UID yang berhasil
      const successPattern = /✓ SUCCESS: UID (\d+) saved/;
      const duplicatePattern = /Skipping Duplicate UID (\d+) \(cached\)/;

      for (const line of lines) {
        // Cari UID yang berhasil disimpan
        const successMatch = line.match(successPattern);
        if (successMatch) {
          const uid = parseInt(successMatch[1]);
          logger.info('Found last successful UID from log', { userEmail, folder, uid });
          return uid;
        }

        // Cari UID yang duplicate (juga berarti berhasil diproses)
        const duplicateMatch = line.match(duplicatePattern);
        if (duplicateMatch) {
          const uid = parseInt(duplicateMatch[1]);
          logger.info('Found last duplicate UID from log', { userEmail, folder, uid });
          return uid;
        }

        // Jika menemukan error untuk user/folder ini, berhenti
        if (line.includes(`"userEmail":"${userEmail}"`) && line.includes(`"folder":"${folder}"`) &&
            (line.includes('error') || line.includes('Error'))) {
          logger.debug('Found error in log, stopping search', { userEmail, folder });
          break;
        }
      }

      logger.debug('No successful UID found in recent log', { userEmail, folder });
      return 0;

    } catch (error) {
      logger.warn('Failed to parse UID from log', { userEmail, folder, error: error.message });
      return 0;
    }
  }

  // RESUME: Smart resume dengan kombinasi database + log parsing
  async getResumeUid(userId, userEmail, folder = 'INBOX') {
    try {
      // 1. Coba ambil dari database (terpercaya)
      const dbUid = await this.getLastUidByFolder(userId, folder);

      // 2. Jika database kosong, coba parse dari log
      if (dbUid === 0) {
        const logUid = await this.getLastSuccessfulUidFromLog(userEmail, folder);
        if (logUid > 0) {
          logger.info('Using UID from log parsing for resume', { userEmail, folder, logUid });

          // Simpan ke database untuk future reference
          await this.updateLastUidByFolder(userId, folder, logUid);

          return logUid;
        }
      }

      // 3. Jika database ada, validasi dengan log (opsional)
      if (dbUid > 0 && process.env.VALIDATE_RESUME_WITH_LOG === 'true') {
        const logUid = await this.getLastSuccessfulUidFromLog(userEmail, folder);
        if (logUid > dbUid) {
          logger.warn('Log shows higher UID than database, using log value', {
            userEmail, folder, dbUid, logUid
          });
          await this.updateLastUidByFolder(userId, folder, logUid);
          return logUid;
        }
      }

      return dbUid;

    } catch (error) {
      logger.error('Failed to get resume UID', { userId, userEmail, folder, error: error.message });
      return 0; // Fallback ke 0 jika error
    }
  }

  // OPTIMASI: Memory monitoring dan cleanup
  getMemoryStats() {
    const memUsage = process.memoryUsage();
    return {
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
      cacheSize: this.messageIdCache.size,
      cacheMemoryEstimate: this.estimateCacheMemoryUsage() // MB
    };
  }

  // Estimasi memory usage dari cache
  estimateCacheMemoryUsage() {
    let totalMessageIds = 0;
    for (const messageIds of this.messageIdCache.values()) {
      totalMessageIds += messageIds.size;
    }

    // Rough estimate: 100 bytes per Message-ID (string + Set overhead)
    return Math.round((totalMessageIds * 100) / 1024 / 1024); // MB
  }

  // OPTIMASI: Periodic memory cleanup untuk mailbox besar
  async performMemoryCleanup(forceGc = false) {
    try {
      // Clear expired caches
      const now = Date.now();
      let clearedUsers = 0;

      for (const [userId, expiry] of this.cacheExpiry.entries()) {
        const age = now - expiry;
        if (age > 10 * 60 * 1000) { // 10 minutes (lebih lama dari 5 menit cache)
          this.messageIdCache.delete(userId);
          this.cacheExpiry.delete(userId);
          clearedUsers++;
        }
      }

      if (clearedUsers > 0) {
        logger.info('Memory cleanup: cleared expired caches', { clearedUsers });
      }

      // Force garbage collection jika memory usage tinggi
      const memStats = this.getMemoryStats();
      if ((forceGc || memStats.heapUsed > 300) && global.gc) { // > 300MB heap usage
        logger.info('Memory cleanup: running garbage collection', {
          heapUsedMB: memStats.heapUsed,
          cacheSize: memStats.cacheSize
        });
        global.gc();

        // Check memory after GC
        const afterGc = this.getMemoryStats();
        logger.info('Memory cleanup completed', {
          beforeHeapMB: memStats.heapUsed,
          afterHeapMB: afterGc.heapUsed,
          freedMB: memStats.heapUsed - afterGc.heapUsed
        });
      }

    } catch (error) {
      logger.warn('Memory cleanup failed', { error: error.message });
    }
  }

  // Check if connection is healthy
  async isConnectionHealthy(userId) {
    try {
      const connection = this.connections.get(userId);
      if (!connection || !connection.imap) {
        return false;
      }

      const { imap, userEmail } = connection;

      // Check basic connection state
      if (imap.state !== 2) {
        logger.debug('Connection not in authenticated state', { userId, userEmail, state: imap.state });
        return false;
      }

      // Check if connection is recent (not stale)
      const lastActivity = new Date(connection.lastActivity || 0);
      const timeSinceActivity = Date.now() - lastActivity.getTime();
      const maxAge = 20 * 60 * 1000; // 20 minutes

      if (timeSinceActivity > maxAge) {
        logger.debug('Connection is stale', {
          userId, userEmail,
          timeSinceActivity: Math.floor(timeSinceActivity / 1000),
          maxAge: Math.floor(maxAge / 1000)
        });
        return false;
      }

      // Skip NOOP test for Gmail IMAP to avoid unnecessary disconnections
      // State validation is sufficient for health checking
      logger.debug('Connection health check passed (state validation only)', {
        userId, userEmail, state: imap.state, lastActivity: connection.lastActivity
      });
      return true;

    } catch (error) {
      logger.debug('Connection health check failed', { userId, error: error.message });
      return false;
    }
  }

  // Retry mechanism with exponential backoff for IMAP operations
  async retryWithBackoff(operation, operationName, userEmail, maxAttempts = RATE_LIMITS.RETRY_ATTEMPTS) {
    let attempt = 0;
    let lastError;

    while (attempt < maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        attempt++;
        lastError = error;

        // Check if error is retryable
        const isRetryable = this.isRetryableError(error);

        if (!isRetryable || attempt >= maxAttempts) {
          logger.error(`${operationName} failed after ${attempt} attempts`, {
            userEmail,
            error: error.message,
            isRetryable,
            finalAttempt: true
          });
          throw error;
        }

        // Calculate delay with exponential backoff
        const baseDelay = RATE_LIMITS.RETRY_DELAY;
        const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 1000; // Add jitter to prevent thundering herd
        const delay = Math.min(exponentialDelay + jitter, RATE_LIMITS.MAX_RETRY_DELAY);

        logger.warn(`${operationName} failed, retrying in ${Math.round(delay)}ms`, {
          userEmail,
          attempt,
          maxAttempts,
          error: error.message,
          delayMs: Math.round(delay)
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  // Determine if an error is retryable
  isRetryableError(error) {
    const retryableMessages = [
      'Connection not available',
      'Connection no longer available',
      'Connection not in valid state',
      'Connection pool exhausted',
      'TIMEOUT',
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEOUT',
      'Socket timeout',
      'Authentication failed',
      'Mailbox lock',
      'Temporary failure'
    ];

    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code?.toLowerCase() || '';

    return retryableMessages.some(msg =>
      errorMessage.includes(msg.toLowerCase()) || errorCode.includes(msg.toLowerCase())
    );
  }

  async connect(userEmail, userId) {
    // Always use real Gmail mode - no simulated mode
    return this.connectRealGmail(userEmail, userId);
  }

  async connectRealGmail(userEmail, userId) {
    try {
      await this.acquireConnectionSlot();

      const tokenData = await oauth2Service.generateXOAuth2Token(userEmail);
      const imap = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: userEmail, accessToken: tokenData.token },
        connectTimeout: 30000,
        logger: false // Matikan logger internal agar tidak spam log
      });

      // Add error event listeners before connecting
      imap.on('error', (error) => {
        logger.error('IMAP connection error event', {
          userEmail,
          userId,
          error: error.message,
          code: error.code,
          timestamp: new Date().toISOString()
        });

        // Force disconnect on critical errors
        if (error.code === 'ETIMEOUT' || error.code === 'ECONNRESET') {
          logger.warn('Critical IMAP error detected, scheduling force disconnect', {
            userEmail,
            userId,
            errorCode: error.code
          });
          // Use setTimeout to avoid immediate disconnect during error handling
          setTimeout(() => {
            this.forceDisconnect(userId).catch(disconnectError => {
              logger.error('Failed to force disconnect after critical error', {
                userId,
                userEmail,
                disconnectError: disconnectError.message
              });
            });
          }, 1000);
        }
      });

      // Add close event listener
      imap.on('close', () => {
        logger.warn('IMAP connection closed unexpectedly', {
          userEmail,
          userId,
          timestamp: new Date().toISOString()
        });
      });

      await imap.connect();

      this.connections.set(userId, {
        imap,
        userEmail,
        userId,
        connectionId: uuidv4(),
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        isDisconnecting: false // Flag to prevent operations during disconnect
      });

      logger.info('IMAP connection established successfully', {
        userEmail,
        userId,
        connectionId: this.connections.get(userId).connectionId
      });

      return { imap };
    } catch (error) {
      logger.error('IMAP Connection Failed', {
        userEmail,
        userId,
        error: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      });
      throw error;
    } finally {
      // Selalu lepaskan status PENDING, baik sukses maupun gagal
      this.releasePendingSlot();
    }
  }



  async startIdle(userId) {
    try {
      const connection = this.connections.get(userId);
      if (!connection) {
        throw new Error('No active IMAP connection for user');
      }

      const { userEmail } = connection;

      // Always use real IDLE mode - no simulated mode
      return this.startRealIdle(userId, connection);
    } catch (error) {
      logger.error('Failed to start IDLE', { userId, error: error.message });
      throw error;
    }
  }

  async startRealIdle(userId, connection) {
    const { imap, userEmail } = connection;

    try {
      await this.openMailbox(imap, 'INBOX', false);
      const lastUid = await this.getLastUid(userId);

      logger.info('Starting REAL IDLE mode', { userEmail, lastUid });
      await this.updateConnectionStatus(userId, connection.connectionId, 'idle');

      imap.idle.start();

      // CRITICAL: Handle new mail - only process NEW emails
      imap.on('mail', async (numNewMsgs) => {
        logger.info('New mail detected (REAL)', { userEmail, numNewMsgs });
        connection.lastActivity = Date.now();
        await this.handleNewMail(imap, userId, userEmail);
      });

      // CRITICAL: Ignore delete/expunge actions - IMMUTABLE BACKUP
      imap.on('update', async (seqno, info) => {
        connection.lastActivity = Date.now();

        // REJECT ALL DELETE ACTIONS
        if (info.flags && info.flags.includes('\\Deleted')) {
          logger.debug('DELETE ACTION REJECTED - Immutable backup', { userEmail, seqno });
          return; // Do NOT process deleted messages
        }

        // Handle flag updates (read status, etc.)
        if (info.flags) {
          logger.debug('Message flags updated', { userEmail, seqno, flags: info.flags });
          // Only re-fetch if there might be content changes
          await this.handleNewMail(imap, userId, userEmail);
        }
      });

      // Auto-reconnect before Gmail timeout
      connection.reconnectTimeout = setTimeout(() => {
        logger.info('Scheduled IMAP reconnect', { userEmail });
        this.reconnect(userId);
      }, RATE_LIMITS.IDLE_REFRESH_INTERVAL);

      connection.heartbeatInterval = setInterval(() => {
        if (connection.imap && connection.imap.state === 2) {
          connection.lastActivity = Date.now();
          logger.debug('IMAP heartbeat', { userEmail });
        }
      }, 5 * 60 * 1000);

      return { simulated: false };
    } catch (error) {
      logger.error('Failed to start real IDLE', { userEmail, error: error.message });
      throw error;
    }
  }

  async handleNewMail(imap, userId, userEmail) {
    // Prevent duplicate processing
    if (this.isProcessing.get(userId)) {
      logger.debug('Already processing mail, skipping', { userEmail });
      return;
    }

    this.isProcessing.set(userId, true);

    try {
      // Get all folders and process new mail in each
      const folders = await this.listFolders(imap);
      logger.info('Processing all folders', { userEmail, folderCount: folders.length });

      for (const folder of folders) {
        await this.processFolderNewMail(imap, folder, userId, userEmail);
      }
    } catch (error) {
      logger.error('Failed to handle new mail', { userEmail, error: error.message });
    } finally {
      this.isProcessing.set(userId, false);
    }
  }

  async listFolders(imap) {
    try {
      // IMAPFLOW: Use mailbox listing
      const mailboxes = await imap.list();
      const folders = mailboxes.map(mailbox => mailbox.path);
      return folders;
    } catch (error) {
      logger.error('Failed to list folders', { error: error.message });
      throw error;
    }
  }

  extractFolderNames(boxes, prefix = '') {
    let folders = [];
    for (const [name, box] of Object.entries(boxes)) {
      const fullPath = prefix ? `${prefix}/${name}` : name; // Use '/' separator instead of concatenation
      // Add main folder
      folders.push(fullPath);
      // Recursively get sub-folders
      if (box.children) {
        folders = folders.concat(this.extractFolderNames(box.children, fullPath));
      }
    }
    return folders;
  }

  async processFolderNewMail(imap, folder, userId, userEmail) {
    try {
      // Get last processed UID for this folder
      const lastUid = await this.getLastUidByFolder(userId, folder);
      
      // Open the folder
      await this.openMailbox(imap, folder, false);

      // Search for new messages
      const searchCriteria = lastUid > 0 ? [['UID', `${lastUid + 1}:*`]] : ['ALL'];
      const results = await this.searchMessages(imap, searchCriteria);

      if (results.length === 0) {
        logger.debug('No new messages in folder', { userEmail, folder });
        return;
      }

      logger.info('New messages found in folder', { userEmail, folder, count: results.length });

      // Process in batches
      const batches = this.chunkArray(results, RATE_LIMITS.BATCH_SIZE);

      for (const batch of batches) {
        await this.processMessageBatch(imap, batch, userId, userEmail, folder);
      }
    } catch (error) {
      logger.warn('Failed to process folder', { userEmail, folder, error: error.message });
      // Continue with next folder even if this one fails
    }
  }

  async getLastUidByFolder(userId, folder) {
    try {
      const result = await query(
        'SELECT last_uid FROM email_folder_uids WHERE user_id = ? AND folder_name = ?',
        [userId, folder]
      );
      return result[0]?.last_uid || 0;
    } catch (error) {
      logger.error('Failed to get last UID by folder', { userId, folder, error: error.message });
      return 0;
    }
  }

  async updateLastUidByFolder(userId, folder, uid) {
    try {
      await query(
        `INSERT INTO email_folder_uids (user_id, folder_name, last_uid, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
         last_uid = VALUES(last_uid),
         updated_at = NOW()`,
        [userId, folder, uid]
      );
    } catch (error) {
      logger.error('Failed to update last UID by folder', { userId, folder, uid, error: error.message });
    }
  }

  async processMessageBatch(imap, uids, userId, userEmail, folder = 'INBOX') {
    logger.info('Starting batch processing', { userEmail, folder, batchSize: uids.length });

    let successCount = 0;
    let errorCount = 0;

    // Proses satu per satu, jangan pakai Promise.all agar tidak OOM (Out of Memory)
    for (const [index, uid] of uids.entries()) {
      try {
        if (!imap || imap.state !== 2) {
          logger.error('IMAP connection lost during batch', { uid, userEmail });
          break;
        }

        // Gunakan info agar muncul di console
        logger.info(`Processing ${index + 1}/${uids.length}`, { uid, userEmail });

        const result = await this.fetchAndStoreMessage(imap, uid, userId, userEmail, folder);

        if (result) {
          successCount++;
        }
      } catch (err) {
        errorCount++;
        logger.error('Failed to process message', { uid, error: err.message });
      }
    }

    logger.info('Batch processing completed', {
      folder,
      success: successCount,
      errors: errorCount
    });
  }

  async fetchAndStoreMessage(imap, uid, userId, userEmail, folder = 'INBOX') {
    try {
      // Update last activity for connection health monitoring
      const connection = this.connections.get(userId);
      if (connection) {
        connection.lastActivity = Date.now();
      }

      // TAHAP 1: Light Fetch (Hanya ambil Envelope/Message-ID)
      const lightMessages = await this.fetchMessages(imap, uid.toString(), {
        envelope: true,
        uid: true // Pastikan UID disertakan
      });

      if (!lightMessages || lightMessages.length === 0) {
        await this.updateLastUidByFolder(userId, folder, uid);
        return null;
      }

      const msgInfo = lightMessages[0];
      const messageId = msgInfo.envelope?.messageId || `no-id-${uid}-${userId}`;

      // TAHAP 2: OPTIMASI - Cek Message-ID Cache SEBELUM download Source (Heavy)
      // Load cache jika belum ada
      if (!this.messageIdCache.has(userId)) {
        await this.loadMessageIdCache(userId);
      }

      const messageIdCache = this.messageIdCache.get(userId);
      const isDuplicate = messageIdCache?.has(messageId);

      if (isDuplicate) {
        logger.debug(`Skipping Duplicate UID ${uid} (cached)`, { messageId });
        // PENTING: Update UID bahkan untuk duplicate agar resume bekerja
        await this.updateLastUidByFolder(userId, folder, uid);
        return null;
      }

      // TAHAP 3: Heavy Fetch (Hanya jika email benar-benar baru)
      logger.info(`Downloading New Email UID ${uid}...`);
      const fullMessages = await this.fetchMessages(imap, uid.toString(), {
        source: true,
        internalDate: true,
      });

      if (!fullMessages || !fullMessages[0].sourceBuffer) {
        await this.updateLastUidByFolder(userId, folder, uid);
        return null;
      }

      const rawContent = fullMessages[0].sourceBuffer;

      // Monitor RAM saat memproses file besar
      if (rawContent.length > 10 * 1024 * 1024) {
        logger.info(`Handling Large Email (${(rawContent.length/1024/1024).toFixed(2)} MB)`, { uid });
      }

      // Parsing menggunakan simpleParser
      const parsed = await simpleParser(rawContent);

      // Simpan EML (Gunakan messageId hasil parsing agar tidak split buffer lagi)
      const emlPath = await this.storeEmlFile(rawContent, userEmail, parsed.date || new Date(), messageId, folder);

      // Simpan Metadata
      const emailId = await this.storeEmailMetadata(userId, parsed, emlPath, rawContent.length, folder);

      if (emailId) {
        if (parsed.attachments?.length > 0) {
          await this.storeAttachments(emailId, parsed.attachments);
        }
        await this.updateLastUidByFolder(userId, folder, uid);
        logger.info(`✓ SUCCESS: UID ${uid} saved`, { emailId, subject: this.sanitizeForDb(parsed.subject) });
        return emailId;
      }

      return null;
    } catch (error) {
      // ENHANCED LOGGING: Connection state during fetch failure
      logger.error(`Error UID ${uid} - connection analysis:`, {
        msg: error.message,
        errorCode: error.code,
        connectionState: imap?.state,
        authenticated: imap?.authenticated,
        mailbox: imap?.mailbox?.path,
        userEmail,
        folder,
        timestamp: new Date().toISOString()
      });

      // CONNECTION RECOVERY: If connection error, try to recover
      if (this.isRetryableError(error) &&
          (error.message?.includes('Connection not in valid state') ||
           error.message?.includes('Connection no longer available'))) {
        logger.warn(`Attempting connection recovery for UID ${uid}`, { userEmail, folder });
        try {
          // Force disconnect the problematic connection first
          const userIdToDisconnect = Array.from(this.connections.keys()).find(key =>
            this.connections.get(key)?.imap === imap
          );

          if (userIdToDisconnect) {
            logger.info(`Force disconnecting stale connection for user ${userIdToDisconnect}`, { userEmail, folder });
            // Use synchronous force disconnect to ensure immediate cleanup
            this.forceDisconnectSync(userIdToDisconnect);
          }

          // Wait a bit for cleanup to complete
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Create a new connection for this user
          logger.info(`Creating new connection for recovery`, { userEmail, folder });
          const { imap: newImap } = await this.connect(userEmail, userId);

          // Open the mailbox with new connection
          await this.openMailbox(newImap, folder, true);

          logger.info(`Connection recovered with new connection for UID ${uid}`, { userEmail, folder });

          // Retry the operation once after recovery with new connection
          return await this.fetchAndStoreMessage(newImap, uid, userId, userEmail, folder);
        } catch (recoveryError) {
          logger.error(`Connection recovery failed for UID ${uid}`, {
            userEmail,
            folder,
            recoveryError: recoveryError.message
          });
        }
      }

      await this.updateLastUidByFolder(userId, folder, uid);
      return null;
    }
  }

  // Update storeEmlFile agar menerima messageId langsung
  async storeEmlFile(emlContent, userEmail, date, messageId, folder = 'INBOX') {
    try {
      const domain = userEmail.split('@')[1];
      const user = userEmail.split('@')[0];
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');

      const dirPath = path.join(this.backupDir, domain, user, year.toString(), month);
      await fs.mkdir(dirPath, { recursive: true });

      // Bersihkan Message-ID dari karakter ilegal untuk nama file
      const safeId = messageId.replace(/[^a-zA-Z0-9.@_-]/g, '_');
      const filename = `${safeId}.eml`;
      const filePath = path.join(dirPath, filename);

      await fs.writeFile(filePath, emlContent);
      return filePath;
    } catch (error) {
      logger.error('Failed to store EML file', { userEmail, error: error.message });
      throw error;
    }
  }

  async storeEmailMetadata(userId, parsedEmail, emlPath, size, folder = 'INBOX') {
    try {
      const sql = `INSERT IGNORE INTO emails (user_id, message_id, subject, from_email, to_email, date, eml_path, size, folder, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;

      const params = [
        userId,
        parsedEmail.messageId || uuidv4(),
        this.sanitizeForDb(parsedEmail.subject),
        this.sanitizeForDb(parsedEmail.from?.text),
        this.sanitizeForDb(parsedEmail.to?.text),
        parsedEmail.date || new Date(),
        emlPath,
        size,
        folder
      ];

      const result = await query(sql, params);

      // FIX UNTUK MYSQL2 PROMISE:
      // result biasanya berbentuk [ResultSetHeader, Fields]
      const header = Array.isArray(result) ? result[0] : result;

      if (header && header.affectedRows === 0) {
        logger.info('Duplicate email ignored', { messageId: parsedEmail.messageId });
        return null;
      }

      const insertId = header.insertId || (header.rows && header.rows[0]?.id);

      // OPTIMASI: Update Message-ID cache dengan email baru
      if (insertId && parsedEmail.messageId) {
        if (!this.messageIdCache.has(userId)) {
          this.messageIdCache.set(userId, new Set());
        }
        this.messageIdCache.get(userId).add(parsedEmail.messageId);
        logger.debug('Message-ID cache updated', { userId, messageId: parsedEmail.messageId });
      }

      return insertId;
    } catch (error) {
      logger.error('DB Metadata Error', { error: error.message });
      throw error;
    }
  }

  async storeAttachments(emailId, attachments) {
    if (!attachments || attachments.length === 0) return;

    try {
      // Get email info for folder structure
      const emails = await query('SELECT eml_path FROM emails WHERE id = ?', [emailId]);
      if (emails.length === 0) return;

      const emlDir = path.dirname(emails[0].eml_path);
      const attachmentsDir = path.join(emlDir, 'attachments');
      await fs.mkdir(attachmentsDir, { recursive: true });

      for (const attachment of attachments) {
        const filename = attachment.filename || `attachment_${Date.now()}`;
        const filePath = path.join(attachmentsDir, filename);

        // Store actual file content
        if (attachment.content && Buffer.isBuffer(attachment.content)) {
          await fs.writeFile(filePath, attachment.content);
        } else if (attachment.content && typeof attachment.content === 'string') {
          await fs.writeFile(filePath, attachment.content, 'utf8');
        } else if (attachment.stream) {
          // Handle stream if provided
          await this.writeStreamToFile(attachment.stream, filePath);
        }

        // Store metadata with file path
        await query(
          'INSERT INTO attachments (email_id, filename, mime_type, size, file_path) VALUES (?, ?, ?, ?, ?)',
          [emailId, filename, attachment.contentType || 'application/octet-stream', attachment.size || 0, filePath]
        );

        logger.debug('Attachment stored', { emailId, filename, path: filePath });
      }
    } catch (error) {
      logger.error('Failed to store attachments', { emailId, error: error.message });
    }
  }

  async writeStreamToFile(stream, filePath) {
    return new Promise((resolve, reject) => {
      const writeStream = require('fs').createWriteStream(filePath);
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  }

  async getLastUid(userId) {
    try {
      const result = await query('SELECT last_uid FROM users WHERE id = ?', [userId]);
      return result[0]?.last_uid || 0;
    } catch (error) {
      logger.error('Failed to get last UID', { userId, error: error.message });
      return 0;
    }
  }

  async updateLastUid(userId, uid) {
    try {
      await query('UPDATE users SET last_uid = ?, updated_at = NOW() WHERE id = ?', [uid, userId]);
    } catch (error) {
      logger.error('Failed to update last UID', { userId, uid, error: error.message });
    }
  }

  async updateConnectionStatus(userId, connectionId, status) {
    try {
      await query(
        `INSERT INTO imap_connections (user_id, connection_id, status, last_activity)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
         connection_id = VALUES(connection_id),
         status = VALUES(status),
         last_activity = NOW()`,
        [userId, connectionId, status]
      );
    } catch (error) {
      logger.error('Failed to update connection status', { userId, connectionId, status, error: error.message });
    }
  }

  async openMailbox(imap, mailboxName, readOnly = true) {
    try {
      // IMAPFLOW: Use mailboxOpen() API (not selectMailbox)
      const mailbox = await imap.mailboxOpen(mailboxName, { readOnly });
      logger.debug('Mailbox opened', { mailbox: mailboxName });
      return mailbox;
    } catch (error) {
      logger.error('Failed to open mailbox', { mailbox: mailboxName, error: error.message });
      throw error;
    }
  }

  async searchMessages(imap, criteria) {
    try {
      let searchCriteria;

      // Jika criteria adalah UID range (seperti "92:*")
      if (typeof criteria === 'string' || typeof criteria === 'number') {
        searchCriteria = { uid: criteria };
      } else if (Array.isArray(criteria) && criteria[0] && criteria[0][0] === 'UID') {
        // Mengubah format [['UID', '92:*']] menjadi { uid: '92:*' }
        searchCriteria = { uid: criteria[0][1] };
      } else {
        searchCriteria = { all: true };
      }

      logger.debug('IMAP search criteria conversion', {
        originalCriteria: criteria,
        convertedCriteria: searchCriteria
      });

      const results = await imap.search(searchCriteria);
      // imap.search mengembalikan array of UIDs di imapflow
      return results;
    } catch (error) {
      logger.error('IMAP search failed', { criteria, error: error.message });
      throw error;
    }
  }

  async fetchMessages(imap, uids, options) {
    // Find connection info safely
    let userEmail = 'unknown';
    let userId = 'unknown';
    let connectionFound = false;

    for (const [key, connection] of this.connections.entries()) {
      if (connection?.imap === imap) {
        userEmail = connection.userEmail;
        userId = connection.userId;
        connectionFound = true;

        // Check if connection is being disconnected
        if (connection.isDisconnecting) {
          logger.warn('IMAP fetch cancelled - connection is disconnecting', {
            userEmail,
            userId,
            timestamp: new Date().toISOString()
          });
          throw new Error('Connection is being disconnected');
        }
        break;
      }
    }

    // Log warning if connection not found - this indicates a race condition
    if (!connectionFound) {
      logger.warn('IMAP fetch called on unknown/disconnected connection', {
        uids: Array.isArray(uids) ? uids.length : uids,
        imapState: imap?.state,
        activeConnections: this.connections.size,
        timestamp: new Date().toISOString()
      });
    }

    return this.retryWithBackoff(async () => {
      // VALIDATION: Check if connection is still valid before fetch
      if (!connectionFound) {
        throw new Error('Connection no longer available - fetch cancelled');
      }

      // Allow both 'authenticated' (state 2) and 'selected' (state 3) states for fetch operations
      if (!imap || (imap.state !== 2 && imap.state !== 3)) {
        logger.warn('IMAP fetch cancelled - invalid connection state', {
          userEmail,
          userId,
          imapState: imap?.state,
          authenticated: imap?.authenticated,
          timestamp: new Date().toISOString()
        });
        throw new Error('Connection not in valid state for fetch');
      }

      // LOGGING: Track connection state before fetch
      logger.debug('IMAP fetch attempt', {
        uids: Array.isArray(uids) ? uids.length : uids,
        connectionState: imap?.state,
        authenticated: imap?.authenticated,
        userEmail,
        timestamp: new Date().toISOString()
      });

      const messages = [];

      try {
        // ImapFlow fetch menggunakan async generator dengan timeout
        const fetchPromise = (async () => {
          for await (const message of imap.fetch(uids, options)) {
            // Pastikan kita mengonsumsi stream source jika ada
            if (message.source) {
              // Mengubah stream menjadi Buffer agar aman di memori dengan timeout
              const bufferPromise = this.streamToBuffer(message.source);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Buffer conversion timeout')), 120000) // 2 minutes
              );
              message.sourceBuffer = await Promise.race([bufferPromise, timeoutPromise]);
            }
            messages.push(message);
          }
          return messages;
        })();

        // Add overall fetch timeout (5 minutes for large emails)
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('IMAP fetch timeout')), 300000)
        );

        const result = await Promise.race([fetchPromise, timeoutPromise]);

        // LOGGING: Success logging
        logger.debug('IMAP fetch success', {
          uids: Array.isArray(uids) ? uids.length : uids,
          messagesReturned: messages.length,
          userEmail,
          timestamp: new Date().toISOString()
        });

        return result;

      } catch (fetchError) {
        // Enhanced error logging for fetch operations
        logger.error('IMAP fetch operation failed', {
          uids: Array.isArray(uids) ? uids.length : uids,
          userEmail,
          error: fetchError.message,
          code: fetchError.code,
          isTimeout: fetchError.message?.includes('timeout'),
          timestamp: new Date().toISOString()
        });
        throw fetchError;
      }

    }, 'IMAP fetch', userEmail);
  }

  // Helper untuk mengubah stream menjadi Buffer
  async streamToBuffer(readable) {
    try {
      const chunks = [];
      for await (const chunk of readable) {
        // Perbaikan: Jika chunk adalah angka (byte), bungkus ke dalam Buffer
        if (typeof chunk === 'number') {
          chunks.push(Buffer.from([chunk]));
        } else {
          chunks.push(Buffer.from(chunk));
        }
      }
      return Buffer.concat(chunks);
    } catch (error) {
      logger.error('Error converting stream to buffer', { error: error.message });
      throw error;
    }
  }

  async streamToString(stream) {
    return new Promise((resolve, reject) => {
      let data = '';
      stream.on('data', chunk => data += chunk.toString('utf8'));
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
  }

  extractMessageId(emlContent) {
    // Jika emlContent adalah Buffer, ubah ke String
    const content = Buffer.isBuffer(emlContent) ? emlContent.toString('utf8') : emlContent;

    const lines = content.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().startsWith('message-id:')) {
        return line.split(':')[1].trim().replace(/[<>]/g, '');
      }
    }
    return uuidv4();
  }

  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  async reconnect(userId) {
    try {
      logger.info('Reconnecting IMAP', { userId });
      await this.disconnect(userId);

      const users = await query('SELECT email FROM users WHERE id = ?', [userId]);
      if (users.length === 0) throw new Error('User not found');

      await this.connect(users[0].email, userId);
      await this.startIdle(userId);

      const mode = this.useRealGmail ? 'REAL' : 'simulated';
      logger.info(`IMAP reconnected (${mode})`, { userId });
    } catch (error) {
      logger.error('Failed to reconnect IMAP', { userId, error: error.message });
    }
  }

  async disconnect(userId) {
    try {
      logger.info('Starting IMAP disconnect process', { userId });

      const connection = this.connections.get(userId);
      if (connection) {
        logger.info('Found active connection for disconnect', {
          userId,
          connectionId: connection.connectionId,
          simulated: connection.simulated,
          userEmail: connection.userEmail
        });

        if (connection.imap && !connection.simulated) {
          logger.info('Logging out IMAPFLOW connection', { userId });
          await connection.imap.logout();
        }

        if (connection.idleInterval) {
          logger.info('Clearing idle interval', { userId });
          clearInterval(connection.idleInterval);
        }
        if (connection.reconnectTimeout) {
          logger.info('Clearing reconnect timeout', { userId });
          clearTimeout(connection.reconnectTimeout);
        }
        if (connection.heartbeatInterval) {
          logger.info('Clearing heartbeat interval', { userId });
          clearInterval(connection.heartbeatInterval);
        }

        this.connections.delete(userId);
        this.releaseConnectionSlot();

        // Update connection status in database
        await this.updateConnectionStatus(userId, connection.connectionId, 'disconnected');

        logger.info('IMAP disconnected successfully', {
          userId,
          connectionId: connection.connectionId,
          mode: connection.simulated ? 'simulated' : 'real',
          userEmail: connection.userEmail
        });
      } else {
        logger.warn('No active connection found for disconnect', { userId });
      }
    } catch (error) {
      logger.error('Failed to disconnect IMAP', { userId, error: error.message, stack: error.stack });
    }
  }

  async disconnectAll() {
    for (const [userId] of this.connections) {
      await this.disconnect(userId);
    }
  }

  // Force disconnect - more aggressive disconnection for stale connections
  async forceDisconnect(userId) {
    try {
      logger.info('Starting force disconnect process', { userId });

      const connection = this.connections.get(userId);
      if (connection) {
        // Set disconnecting flag to prevent new operations
        connection.isDisconnecting = true;

        logger.info('Found active connection for force disconnect', {
          userId,
          connectionId: connection.connectionId,
          userEmail: connection.userEmail
        });

        // Force close the IMAP connection without waiting
        if (connection.imap) {
          try {
            // Try logout first
            await Promise.race([
              connection.imap.logout(),
              new Promise(resolve => setTimeout(resolve, 2000)) // 2 second timeout
            ]);
          } catch (logoutError) {
            logger.warn('Logout failed during force disconnect, continuing', {
              userId,
              error: logoutError.message
            });
          }

          // Force close the connection
          try {
            connection.imap.close();
          } catch (closeError) {
            logger.warn('Close failed during force disconnect, continuing', {
              userId,
              error: closeError.message
            });
          }
        }

        // Clear timers
        if (connection.idleInterval) {
          clearInterval(connection.idleInterval);
        }
        if (connection.reconnectTimeout) {
          clearTimeout(connection.reconnectTimeout);
        }
        if (connection.heartbeatInterval) {
          clearInterval(connection.heartbeatInterval);
        }

        this.connections.delete(userId);
        this.releaseConnectionSlot();

        // Update connection status in database
        await this.updateConnectionStatus(userId, connection.connectionId, 'disconnected');

        logger.info('Force disconnect completed successfully', {
          userId,
          connectionId: connection.connectionId,
          userEmail: connection.userEmail
        });
      } else {
        logger.warn('No active connection found for force disconnect', { userId });
      }
    } catch (error) {
      logger.error('Failed to force disconnect IMAP', { userId, error: error.message, stack: error.stack });
      // Still try to remove from connections map even if error occurred
      this.connections.delete(userId);
      this.releaseConnectionSlot();
    }
  }

  // Synchronous force disconnect for immediate cleanup during recovery
  forceDisconnectSync(userId) {
    try {
      logger.info('Starting synchronous force disconnect', { userId });

      const connection = this.connections.get(userId);
      if (connection) {
        // Set disconnecting flag immediately
        connection.isDisconnecting = true;

        logger.info('Found active connection for sync force disconnect', {
          userId,
          connectionId: connection.connectionId,
          userEmail: connection.userEmail
        });

        // Clear timers immediately
        if (connection.idleInterval) {
          clearInterval(connection.idleInterval);
        }
        if (connection.reconnectTimeout) {
          clearTimeout(connection.reconnectTimeout);
        }
        if (connection.heartbeatInterval) {
          clearInterval(connection.heartbeatInterval);
        }

        // Force close connection synchronously if possible
        if (connection.imap) {
          try {
            connection.imap.close();
          } catch (closeError) {
            logger.warn('Sync close failed, continuing', {
              userId,
              error: closeError.message
            });
          }
        }

        // Immediately remove from connections and release slot
        this.connections.delete(userId);
        this.releaseConnectionSlot();

        logger.info('Synchronous force disconnect completed', {
          userId,
          connectionId: connection.connectionId,
          userEmail: connection.userEmail
        });
      } else {
        logger.warn('No active connection found for sync force disconnect', { userId });
      }
    } catch (error) {
      logger.error('Failed to sync force disconnect IMAP', { userId, error: error.message });
      // Still try to remove from connections map even if error occurred
      this.connections.delete(userId);
      this.releaseConnectionSlot();
    }
  }

  // Method for full mailbox backup (used by queue service)
  async backupUserMailbox(userId, userEmail) {
    try {
      logger.info('Starting full mailbox backup (REAL GMAIL)', { userId, userEmail });

      // Always use real Gmail mode - no simulated mode
      await this.backupRealMailbox(userId, userEmail);

      logger.info('Full mailbox backup completed (REAL GMAIL)', { userId, userEmail });
    } catch (error) {
      logger.error('Full mailbox backup failed (REAL GMAIL)', { userId, userEmail, error: error.message });
      throw error;
    }
  }

  async backupRealMailbox(userId, userEmail) {
    try {
      // OPTIMASI: Load Message-ID cache di awal backup untuk menghindari query database berulang
      logger.info('Loading Message-ID cache for backup optimization', { userId, userEmail });
      const messageIdCache = await this.loadMessageIdCache(userId, true); // Force reload untuk backup
      logger.info('Message-ID cache ready', { userId, cachedMessageIds: messageIdCache.size });

      // Connect to IMAP
      const { imap } = await this.connect(userEmail, userId);

      // Get all folders
      const allFolders = await this.listFolders(imap);
      logger.info('Available folders', { userEmail, folderCount: allFolders.length, folders: allFolders });

      // CRITICAL FIX: Prioritize Gmail system folders for backup stability
      // Gmail labels can be problematic, so backup system folders first
      const gmailSystemFolders = [
        'INBOX',
        '[Gmail]/All Mail',
        '[Gmail]/Sent Mail',
        '[Gmail]/Trash'
      ];

      // Separate system folders from user labels
      const systemFolders = allFolders.filter(folder =>
        gmailSystemFolders.some(sysFolder =>
          folder.toLowerCase().includes(sysFolder.toLowerCase())
        )
      );

      const labelFolders = allFolders.filter(folder =>
        !gmailSystemFolders.some(sysFolder =>
          folder.toLowerCase().includes(sysFolder.toLowerCase())
        )
      );

      logger.info('Separated folders for backup', {
        userEmail,
        systemFolders: systemFolders.length,
        labelFolders: labelFolders.length
      });

      // Process system folders first (more reliable)
      for (const folder of systemFolders) {
        try {
          logger.info('Backing up Gmail system folder', { userEmail, folder });
          await this.backupFolder(imap, folder, userId, userEmail);
        } catch (folderError) {
          logger.warn('Failed to backup system folder, continuing with others', {
            userEmail, folder, error: folderError.message
          });
          // Continue with next folder, don't fail the entire backup
        }
      }

      // Process user label folders (may be less reliable)
      for (const folder of labelFolders) {
        try {
          logger.info('Backing up Gmail label folder', { userEmail, folder });
          await this.backupFolder(imap, folder, userId, userEmail);
        } catch (folderError) {
          logger.warn('Failed to backup label folder, continuing with others', {
            userEmail, folder, error: folderError.message
          });
          // Continue with next folder, don't fail the entire backup
        }
      }

      // Disconnect after backup
      await this.disconnect(userId);
      logger.info('Gmail mailbox backup completed successfully', { userEmail, totalFolders: allFolders.length });

    } catch (error) {
      logger.error('Real mailbox backup failed', { userId, userEmail, error: error.message });
      // Make sure to disconnect even on error
      try {
        await this.disconnect(userId);
      } catch (disconnectError) {
        logger.warn('Failed to disconnect after backup error', { userId, error: disconnectError.message });
      }
      throw error;
    }
  }

  async backupFolder(imap, folder, userId, userEmail) {
    try {
      logger.info('Backing up folder', { userEmail, folder });

    // RESUME: Smart resume dari database + log parsing
    let lastProcessedUid = await this.getResumeUid(userId, userEmail, folder);
    logger.info('Backup folder resume check', {
      userEmail,
      folder,
      lastProcessedUid,
      resumeSource: lastProcessedUid > 0 ? 'database_or_log' : 'fresh_start',
      timestamp: new Date().toISOString()
    });

    // FORCE RESUME: Jika environment variable diset, gunakan UID tertentu
    const forceResumeUid = process.env.FORCE_RESUME_UID ? parseInt(process.env.FORCE_RESUME_UID) : null;
    if (forceResumeUid && forceResumeUid > 0) {
      logger.warn('FORCE RESUME activated - overriding resume UID', {
        userEmail, folder, originalUid: lastProcessedUid, forcedUid: forceResumeUid
      });
      lastProcessedUid = forceResumeUid;
    }

      // Get fresh token for this operation
      const tokenData = await oauth2Service.generateXOAuth2Token(userEmail);

      // Open the folder
      await this.openMailbox(imap, folder, true); // Read-only for backup

      // CRITICAL FIX: For Gmail, search messages from last UID onwards, not ALL
      // This prevents re-processing already backed up messages
      let results;
      try {
        let searchCriteria;
        if (lastProcessedUid > 0) {
          // Search from last processed UID + 1 onwards
          searchCriteria = [['UID', `${lastProcessedUid + 1}:*`]];
          logger.info('Resuming backup from last UID', {
            userEmail,
            folder,
            lastProcessedUid,
            searchCriteria: searchCriteria[0][1]
          });
        } else {
          // First time backup - search ALL messages
          searchCriteria = ['ALL'];
          logger.info('Starting fresh backup - searching ALL messages', {
            userEmail,
            folder
          });
        }

        results = await this.searchMessages(imap, searchCriteria);
        logger.info('IMAP search completed', {
          userEmail,
          folder,
          uidCount: results.length,
          searchCriteria: searchCriteria,
          lastProcessedUid
        });
      } catch (searchError) {
        logger.error('IMAP search failed', { userEmail, folder, error: searchError.message });
        throw searchError;
      }

      if (results.length === 0) {
        logger.debug('No messages in folder', { userEmail, folder });
        return;
      }

      logger.info('Found messages in folder for backup', { userEmail, folder, count: results.length });

      // CRITICAL FIX: ImapFlow search() returns Set<number>, convert to Array first
      const uids = Array.from(results);

      // LOGGING: Check UID ordering and sort if needed
      logger.debug('Raw UID analysis', {
        userEmail,
        folder,
        totalUids: uids.length,
        first10Uids: uids.slice(0, 10),
        last10Uids: uids.slice(-10),
        isSorted: uids.length > 1 ? uids.every((uid, i) => i === 0 || uid >= uids[i-1]) : true,
        timestamp: new Date().toISOString()
      });

      // CRITICAL FIX: Sort UIDs ascending for chronological processing (oldest first)
      uids.sort((a, b) => a - b);

      logger.info('Starting Gmail-compatible sequential processing', {
        userEmail,
        folder,
        totalMessages: uids.length,
        uidRange: uids.length > 0 ? `${uids[0]}-${uids[uids.length-1]}` : 'none',
        sortedAscending: true
      });

      // DEBUG: Log sample UIDs to verify they're sorted
      logger.info('Gmail UID sample (first 10, sorted)', {
        userEmail,
        folder,
        uidSample: uids.slice(0, 10),
        isAscending: uids.slice(0, 10).every((uid, i) => i === 0 || uid >= uids[i-1])
      });

      let processedCount = 0;
      let successCount = 0;
      let errorCount = 0;

      // OPTIMASI MEMORY: Adjust batch size based on mailbox size untuk mencegah OOM
      const totalMessages = uids.length;
      let batchSize;

      if (totalMessages > 10000) {
        batchSize = 25; // Smaller batch untuk mailbox sangat besar
        logger.info('Using smaller batch size for large mailbox', { userEmail, folder, totalMessages, batchSize });
      } else if (totalMessages > 5000) {
        batchSize = 30; // Medium batch untuk mailbox besar
        logger.info('Using medium batch size for large mailbox', { userEmail, folder, totalMessages, batchSize });
      } else {
        batchSize = 50; // Normal batch untuk mailbox kecil
      }

      // MANUAL GC: Force garbage collection sebelum memulai batch processing besar
      if (totalMessages > 5000 && global.gc) {
        logger.info('Running manual garbage collection before large batch processing', { userEmail, folder, totalMessages });
        global.gc();
      }

      for (let batchIndex = 0; batchIndex < uids.length; batchIndex += batchSize) {
        const batch = uids.slice(batchIndex, batchIndex + batchSize);

        logger.info('Processing Gmail UID batch', {
          userEmail,
          folder,
          batchStart: batchIndex + 1,
          batchEnd: Math.min(batchIndex + batchSize, uids.length),
          batchSize: batch.length,
          totalProcessed: processedCount,
          totalMessages: uids.length
        });

        // Process each UID in batch individually
        for (let i = 0; i < batch.length; i++) {
          const uid = batch[i];
          const globalIndex = batchIndex + i;

          try {
            logger.debug(`Processing message ${globalIndex + 1}/${uids.length}`, {
              uid,
              userEmail,
              folder
            });

            // CEK STATUS KONECKSI: Jika koneksi sudah terputus, buat koneksi baru
            if (!imap || imap.state !== 2 && imap.state !== 3) {
              logger.warn('Connection lost during batch processing, creating new connection', {
                uid,
                userEmail,
                folder,
                currentState: imap?.state,
                batchIndex,
                uidIndex: i
              });

              // Disconnect koneksi lama jika masih ada
              try {
                await this.disconnect(userId);
              } catch (disconnectError) {
                logger.warn('Error disconnecting broken connection', { error: disconnectError.message });
              }

              // Buat koneksi baru
              const { imap: newImap } = await this.connect(userEmail, userId);
              await this.openMailbox(newImap, folder, true);

              // Update referensi imap ke koneksi baru
              imap = newImap;

              logger.info('New connection established for continued processing', {
                uid,
                userEmail,
                folder,
                newState: imap.state
              });
            }

            // Process single message
            const result = await this.fetchAndStoreMessage(imap, uid, userId, userEmail, folder);

            if (result !== null) {
              successCount++;
              logger.debug('Message processed successfully', { uid, userEmail, folder, emailId: result });
            } else {
              logger.debug('Message skipped (duplicate)', { uid, userEmail, folder });
            }

            processedCount++;

          } catch (messageError) {
            errorCount++;
            logger.error('Failed to process individual message', {
              uid,
              userEmail,
              folder,
              index: globalIndex,
              error: messageError.message,
              errorType: messageError.constructor.name
            });
          }

          // CRITICAL FIX: Delay between individual messages for Gmail stability
          if (globalIndex < uids.length - 1) {
            const delayMs = RATE_LIMITS.FETCH_DELAY;
            logger.debug('Delaying between messages', {
              uid,
              userEmail,
              folder,
              delayMs,
              nextUid: uids[globalIndex + 1],
              timestamp: new Date().toISOString()
            });
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }

        // Log progress after each batch
        logger.info('Gmail batch processing completed', {
          userEmail,
          folder,
          batchProcessed: Math.min(batchIndex + batchSize, uids.length),
          totalMessages: uids.length,
          success: successCount,
          errors: errorCount,
          successRate: `${Math.round(successCount/Math.max(processedCount, 1)*100)}%`
        });

        // Delay between batches for Gmail rate limiting
        if (batchIndex + batchSize < uids.length) {
          logger.debug('Delaying before next Gmail batch', { userEmail, folder, delayMs: 1000 });
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second between batches
        }
      }

      logger.info('Gmail folder processing completed', {
        userEmail,
        folder,
        totalMessages: results.length,
        success: successCount,
        errors: errorCount,
        successRate: `${Math.round(successCount/results.length*100)}%`
      });

      logger.info('Folder backup completed', { userEmail, folder, totalMessages: results.length });

    } catch (error) {
      logger.error('Folder backup failed', { userEmail, folder, error: error.message });
      throw error;
    }
  }
}

const imapService = new ImapService();

module.exports = {
  ImapService,
  imapService,
};
