const Imap = require('imap');
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

// Rate limiter untuk Google Workspace compliance
const RATE_LIMITS = {
  MAX_CONCURRENT_CONNECTIONS: 15,
  IDLE_REFRESH_INTERVAL: 25 * 60 * 1000,
  BATCH_SIZE: 50,
  FETCH_TIMEOUT: 60000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 5000,
};

class ImapService {
  constructor() {
    this.connections = new Map();
    this.backupDir = process.env.BACKUP_DIR || './backup';
    this.useRealGmail = process.env.USE_REAL_GMAIL === 'true';
    this.isProcessing = new Map();
    this.activeConnections = 0;

    const mode = this.useRealGmail ? 'PRODUCTION (Real Gmail)' : 'DEVELOPMENT (Simulated)';
    logger.info(`IMAP Service initialized in ${mode} mode`, {
      maxConcurrentConnections: RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS,
      batchSize: RATE_LIMITS.BATCH_SIZE,
    });
  }

  async acquireConnectionSlot() {
    const waitTime = 1000;
    const maxWait = 60000;
    let waited = 0;

    while (this.activeConnections >= RATE_LIMITS.MAX_CONCURRENT_CONNECTIONS) {
      if (waited >= maxWait) {
        throw new Error('Connection pool exhausted, please try again later');
      }
      await new Promise(resolve => setTimeout(resolve, waitTime));
      waited += waitTime;
    }
    this.activeConnections++;
    return true;
  }

  releaseConnectionSlot() {
    if (this.activeConnections > 0) {
      this.activeConnections--;
    }
  }

  async connect(userEmail, userId) {
    if (this.useRealGmail) {
      return this.connectRealGmail(userEmail, userId);
    } else {
      return this.connectSimulated(userEmail, userId);
    }
  }

  async connectRealGmail(userEmail, userId) {
    await this.acquireConnectionSlot();

    try {
      const { token } = await oauth2Service.generateXOAuth2Token(userEmail);

      const imapConfig = {
        user: userEmail,
        xoauth2: token,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 30000,
        connTimeout: 30000,
        mailbox: 'INBOX',
      };

      const imap = new Imap(imapConfig);
      const connectionId = uuidv4();

      return new Promise((resolve, reject) => {
        let connected = false;

        const cleanup = () => {
          if (!connected) this.releaseConnectionSlot();
        };

        imap.once('ready', async () => {
          connected = true;
          logger.info('IMAP connection ready (REAL GMAIL)', { userEmail, connectionId });

          this.connections.set(userId, {
            imap,
            connectionId,
            userEmail,
            userId,
            connectedAt: new Date(),
            simulated: false,
            lastActivity: Date.now(),
          });

          await this.updateConnectionStatus(userId, connectionId, 'connected');
          resolve({ imap, connectionId, simulated: false });
        });

        imap.once('error', (err) => {
          cleanup();
          logger.error('IMAP connection error (REAL GMAIL)', { userEmail, connectionId, error: err.message });
          reject(err);
        });

        imap.once('end', () => {
          cleanup();
          logger.info('IMAP connection ended (REAL GMAIL)', { userEmail, connectionId });
          this.connections.delete(userId);
          this.updateConnectionStatus(userId, connectionId, 'disconnected');
        });

        imap.connect();
      });
    } catch (error) {
      this.releaseConnectionSlot();
      logger.error('Failed to connect to REAL IMAP', { userEmail, error: error.message });
      throw error;
    }
  }

  async connectSimulated(userEmail, userId) {
    try {
      const connectionId = uuidv4();
      logger.info('IMAP connection simulated (development mode)', { userEmail, connectionId });

      this.connections.set(userId, {
        imap: null,
        connectionId,
        userEmail,
        userId,
        connectedAt: new Date(),
        simulated: true,
      });

      await this.updateConnectionStatus(userId, connectionId, 'connected');
      return { imap: null, connectionId, simulated: true };
    } catch (error) {
      logger.error('Failed to establish simulated IMAP connection', { userEmail, error: error.message });
      throw error;
    }
  }

  async startIdle(userId) {
    try {
      const connection = this.connections.get(userId);
      if (!connection) {
        throw new Error('No active IMAP connection for user');
      }

      const { userEmail, simulated } = connection;

      if (simulated) {
        return this.startSimulatedIdle(userId, connection);
      } else {
        return this.startRealIdle(userId, connection);
      }
    } catch (error) {
      logger.error('Failed to start IDLE', { userId, error: error.message });
      throw error;
    }
  }

  async startSimulatedIdle(userId, connection) {
    const { userEmail } = connection;
    logger.info('Starting simulated IDLE mode', { userEmail });

    await this.updateConnectionStatus(userId, connection.connectionId, 'idle');

    connection.idleInterval = setInterval(async () => {
      logger.debug('Simulated IDLE heartbeat', { userEmail });
    }, 60000);

    return { simulated: true };
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
    return new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) reject(err);
        else {
          // Get all folder names including sub-folders
          const folders = this.extractFolderNames(boxes);
          resolve(folders);
        }
      });
    });
  }

  extractFolderNames(boxes, prefix = '') {
    let folders = [];
    for (const [name, box] of Object.entries(boxes)) {
      const fullPath = prefix ? `${prefix}${name}` : name;
      // Add main folder
      folders.push(fullPath);
      // Recursively get sub-folders
      if (box.children) {
        folders = folders.concat(this.extractFolderNames(box.children, `${fullPath}`));
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
         ON CONFLICT(user_id, folder_name) DO UPDATE SET
         last_uid = excluded.last_uid,
         updated_at = NOW()`,
        [userId, folder, uid]
      );
    } catch (error) {
      logger.error('Failed to update last UID by folder', { userId, folder, uid, error: error.message });
    }
  }

  async processMessageBatch(imap, uids, userId, userEmail, folder = 'INBOX') {
    const promises = uids.map(uid =>
      this.fetchAndStoreMessage(imap, uid, userId, userEmail, folder)
        .catch(err => {
          logger.error('Failed to process message', { uid, userEmail, folder, error: err.message });
          return null;
        })
    );

    const results = await Promise.all(promises);
    const successCount = results.filter(r => r !== null).length;
    logger.info('Batch processed', { userEmail, folder, total: uids.length, success: successCount });
  }

  async fetchAndStoreMessage(imap, uid, userId, userEmail, folder = 'INBOX') {
    try {
      const messages = await this.fetchMessages(imap, uid, { bodies: '' });
      if (!messages || messages.length === 0) return null;

      const message = messages[0];
      const parsed = await simpleParser(message.body);

      // Deduplication - skip if already exists
      if (parsed.messageId) {
        const existing = await query(
          'SELECT id FROM emails WHERE message_id = ? AND user_id = ?',
          [parsed.messageId, userId]
        );

        if (existing.length > 0) {
          logger.debug('Message already exists, skipping', { messageId: parsed.messageId, userEmail, folder });
          await this.updateLastUidByFolder(userId, folder, uid);
          return null;
        }
      }

      // Store EML file
      const emlPath = await this.storeEmlFile(message.body, userEmail, parsed.date, folder);

      // CRITICAL: Store email metadata with folder
      const emailId = await this.storeEmailMetadata(userId, parsed, emlPath, message.body.length, folder);

      // Store attachments
      if (parsed.attachments && parsed.attachments.length > 0) {
        await this.storeAttachments(emailId, parsed.attachments);
      }

      await this.updateLastUidByFolder(userId, folder, uid);

      logger.info('Message stored successfully', {
        userEmail,
        folder,
        messageId: parsed.messageId,
        uid,
        subject: parsed.subject?.substring(0, 50)
      });

      return emailId;
    } catch (error) {
      logger.error('Failed to fetch and store message', { uid, userEmail, folder, error: error.message });
      throw error;
    }
  }

  async storeEmlFile(emlContent, userEmail, date, folder = 'INBOX') {
    try {
      const domain = userEmail.split('@')[1];
      const user = userEmail.split('@')[0];
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');

      const dirPath = path.join(this.backupDir, domain, user, year.toString(), month);
      await fs.mkdir(dirPath, { recursive: true });

      const messageId = this.extractMessageId(emlContent);
      const filename = `${messageId}.eml`;
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
      const sanitizeText = (text) => {
        if (!text) return null;
        return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '').substring(0, 2000);
      };

      const result = await query(
        `INSERT INTO emails (user_id, message_id, subject, from_email, to_email, date, eml_path, size, folder, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          userId,
          parsedEmail.messageId,
          sanitizeText(parsedEmail.subject),
          sanitizeText(parsedEmail.from?.text),
          sanitizeText(parsedEmail.to?.text),
          parsedEmail.date,
          emlPath,
          size,
          folder,
        ]
      );

      return result.insertId || result.rows?.[0]?.id;
    } catch (error) {
      logger.error('Failed to store email metadata', { userId, error: error.message });
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
         ON CONFLICT(user_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         status = excluded.status,
         last_activity = NOW()`,
        [userId, connectionId, status]
      );
    } catch (error) {
      logger.error('Failed to update connection status', { userId, connectionId, status, error: error.message });
    }
  }

  async openMailbox(imap, mailboxName, readOnly = true) {
    return new Promise((resolve, reject) => {
      imap.openBox(mailboxName, readOnly, (err, box) => {
        if (err) reject(err);
        else resolve(box);
      });
    });
  }

  async searchMessages(imap, criteria) {
    return new Promise((resolve, reject) => {
      imap.search(criteria, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }

  async fetchMessages(imap, uids, options) {
    return new Promise((resolve, reject) => {
      const messages = [];
      const fetch = imap.fetch(uids, options);

      fetch.on('message', (msg) => {
        let buffer = '';
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
        });
        msg.once('end', () => { messages.push({ body: buffer }); });
      });

      fetch.once('end', () => resolve(messages));
      fetch.once('error', (err) => reject(err));
    });
  }

  extractMessageId(emlContent) {
    const lines = emlContent.split('\n');
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
      const connection = this.connections.get(userId);
      if (connection) {
        if (connection.imap && !connection.simulated) {
          connection.imap.end();
        }
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
        logger.info('IMAP disconnected', { userId, mode: connection.simulated ? 'simulated' : 'real' });
      }
    } catch (error) {
      logger.error('Failed to disconnect IMAP', { userId, error: error.message });
    }
  }

  async disconnectAll() {
    for (const [userId] of this.connections) {
      await this.disconnect(userId);
    }
  }
}

const imapService = new ImapService();

module.exports = {
  ImapService,
  imapService,
};
