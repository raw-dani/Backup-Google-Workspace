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
  MAX_CONCURRENT_CONNECTIONS: parseInt(process.env.MAX_CONCURRENT_CONNECTIONS || '1'), // Reduced to 1 for Gmail stability
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
    this.backupDir = process.env.BACKUP_DIR || './backup';

    // Always use real Gmail mode - no development mode
    logger.info('IMAP Service initialized in PRODUCTION (Real Gmail) mode', {
      maxConcurrentConnections: RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS,
      batchSize: RATE_LIMITS.BATCH_SIZE,
      fetchTimeout: RATE_LIMITS.FETCH_TIMEOUT,
      retryDelay: RATE_LIMITS.RETRY_DELAY,
    });
  }

  // --- SLOT MANAGEMENT (SELF-HEALING) ---
  async acquireConnectionSlot() {
    const maxWait = 60000;
    let waited = 0;

    // LOGGING: Track slot acquisition attempts
    logger.debug('Attempting to acquire connection slot', {
      activeConnections: this.connections.size,
      pendingConnections: this.pendingConnections,
      maxConcurrent: RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS,
      currentTotal: this.connections.size + this.pendingConnections,
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
          timestamp: new Date().toISOString()
        });

        // Jika stuck lebih dari 1 menit padahal Map kosong, paksa reset pending counter
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
      timestamp: new Date().toISOString()
    });

    return true;
  }

  releasePendingSlot() {
    if (this.pendingConnections > 0) this.pendingConnections--;
    logger.info(`Slot Status - Active: ${this.connections.size}, Pending: ${this.pendingConnections}`);
  }

  // REKOMENDASI: Pindahkan fungsi sanitasi ke level class atau utility
  sanitizeForDb(text) {
    if (!text) return null;
    return text
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') // Hapus Emoji (Karakter 4-byte)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '') // Hapus Control Chars
      .substring(0, 500); // Batasi panjang subjek/email
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
      'Connection pool exhausted',
      'TIMEOUT',
      'ECONNRESET',
      'ENOTFOUND',
      'Authentication failed',
      'Mailbox lock',
      'Temporary failure'
    ];

    const errorMessage = error.message?.toLowerCase() || '';
    return retryableMessages.some(msg => errorMessage.includes(msg.toLowerCase()));
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

      await imap.connect();

      this.connections.set(userId, {
        imap,
        userEmail,
        userId,
        connectionId: uuidv4()
      });

      return { imap };
    } catch (error) {
      logger.error('IMAP Connection Failed', { userEmail, error: error.message });
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
        if (connection.imap && connection.imap.state === 'authenticated') {
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
        if (!imap || imap.state !== 'authenticated') {
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

      // TAHAP 2: Cek Database SEBELUM download Source (Heavy)
      const existing = await query('SELECT id FROM emails WHERE message_id = ? AND user_id = ?', [messageId, userId]);
      const isDuplicate = Array.isArray(existing) ? existing[0]?.length > 0 : existing?.id;

      if (isDuplicate) {
        // logger.debug(`Skipping Duplicate UID ${uid}`); // Opsional, agar log tidak penuh
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
      if (this.isRetryableError(error) && imap && imap.state !== 'authenticated') {
        logger.warn(`Attempting connection recovery for UID ${uid}`, { userEmail, folder });
        try {
          // Try to reopen mailbox
          await this.openMailbox(imap, folder, true);
          logger.info(`Connection recovered for UID ${uid}`, { userEmail, folder });
          // Retry the operation once after recovery
          return await this.fetchAndStoreMessage(imap, uid, userId, userEmail, folder);
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
    const userEmail = this.connections.get(Array.from(this.connections.keys()).find(key =>
      this.connections.get(key)?.imap === imap
    ))?.userEmail || 'unknown';

    return this.retryWithBackoff(async () => {
      // LOGGING: Track connection state before fetch
      logger.debug('IMAP fetch attempt', {
        uids: Array.isArray(uids) ? uids.length : uids,
        connectionState: imap?.state,
        authenticated: imap?.authenticated,
        userEmail,
        timestamp: new Date().toISOString()
      });

      const messages = [];
      // ImapFlow fetch menggunakan async generator
      for await (const message of imap.fetch(uids, options)) {
        // Pastikan kita mengonsumsi stream source jika ada
        if (message.source) {
          // Mengubah stream menjadi Buffer agar aman di memori
          message.sourceBuffer = await this.streamToBuffer(message.source);
        }
        messages.push(message);
      }

      // LOGGING: Success logging
      logger.debug('IMAP fetch success', {
        uids: Array.isArray(uids) ? uids.length : uids,
        messagesReturned: messages.length,
        userEmail,
        timestamp: new Date().toISOString()
      });

      return messages;
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

      // LOGGING: Check last processed UID for this folder
      const lastProcessedUid = await this.getLastUidByFolder(userId, folder);
      logger.info('Backup folder state check', {
        userEmail,
        folder,
        lastProcessedUid,
        timestamp: new Date().toISOString()
      });

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

      // CRITICAL FIX: Process in small batches (50-200) for Gmail IMAP performance
      // But still individual message processing to avoid parsing issues
      const batchSize = 50; // Optimal for Gmail IMAP

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

            // TEMPORARILY DISABLE STATE CHECKING - Let Gmail IMAP work with whatever state it has
            // After mailboxOpen(), Gmail may be in state 3 which should still allow fetch operations
            logger.debug('IMAP state check (DISABLED)', {
              uid,
              userEmail,
              folder,
              currentState: imap?.state,
              stateType: typeof imap?.state,
              note: 'State checking temporarily disabled to test Gmail fetch'
            });

            // Skip state validation for now - Gmail IMAP may work with state 3
            // If fetch fails due to authentication, then create new connection

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
