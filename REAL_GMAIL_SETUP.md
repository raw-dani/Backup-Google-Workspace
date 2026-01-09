# Setup Real Gmail Access untuk Testing

Panduan lengkap untuk mengakses email Gmail asli dalam development environment.

## ⚠️ **PENTING: Setup Google Cloud & Gmail API**

### Langkah 1: Setup Google Cloud Project

1. **Buat Google Cloud Project**:
   ```bash
   # Akses Google Cloud Console
   https://console.cloud.google.com/
   ```

2. **Enable Gmail API**:
   - APIs & Services → Library
   - Cari "Gmail API" → Enable

3. **Enable Admin SDK API**:
   - Cari "Admin SDK API" → Enable

### Langkah 2: Setup Service Account

1. **Create Service Account**:
   - IAM & Admin → Service Accounts
   - Create Service Account
   - Download JSON key file
   - Simpan sebagai `backend/atonergi-XXXXX.json`

2. **Enable Domain-Wide Delegation**:
   - Service Account → Details → Advanced settings
   - Enable "Enable Google Workspace Domain-wide Delegation"
   - Copy Client ID

### Langkah 3: Setup Domain-Wide Delegation

1. **Google Workspace Admin Console**:
   ```bash
   https://admin.google.com/
   ```

2. **Security → API controls**:
   - Domain-wide delegation
   - Add new client ID
   - Paste Client ID dari Service Account
   - Add scope: `https://mail.google.com/`

### Langkah 4: Setup Environment Variables

**File: `backend/.env`**
```env
# Google OAuth2 Configuration
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service@your-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./atonergi-XXXXX.json

# Development Mode - Enable Real Gmail
NODE_ENV=development
USE_REAL_GMAIL=true  # Add this to enable real Gmail access
```

### Langkah 5: Modify IMAP Service

**File: `backend/src/services/imap/imapService.js`**

```javascript
// Add at top of file
const USE_REAL_GMAIL = process.env.USE_REAL_GMAIL === 'true';

async connect(userEmail, userId) {
  // Check if we should use real Gmail
  if (USE_REAL_GMAIL) {
    return this.connectRealGmail(userEmail, userId);
  } else {
    return this.connectSimulated(userEmail, userId);
  }
}

async connectRealGmail(userEmail, userId) {
  try {
    // Generate OAuth2 token
    const { token } = await oauth2Service.generateXOAuth2Token(userEmail);

    const imapConfig = {
      user: userEmail,
      xoauth2: token,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: false,
      },
      authTimeout: 30000,
      connTimeout: 30000,
    };

    const imap = new Imap(imapConfig);
    const connectionId = uuidv4();

    return new Promise((resolve, reject) => {
      imap.once('ready', async () => {
        logger.info('IMAP connection ready (REAL GMAIL)', { userEmail, connectionId });

        this.connections.set(userId, {
          imap,
          connectionId,
          userEmail,
          userId,
          connectedAt: new Date(),
          simulated: false,
        });

        // Update connection status in database
        await this.updateConnectionStatus(userId, connectionId, 'connected');

        resolve({ imap, connectionId, simulated: false });
      });

      imap.once('error', (err) => {
        logger.error('IMAP connection error (REAL GMAIL)', {
          userEmail,
          connectionId,
          error: err.message
        });
        reject(err);
      });

      imap.once('end', () => {
        logger.info('IMAP connection ended (REAL GMAIL)', { userEmail, connectionId });
        this.connections.delete(userId);
        this.updateConnectionStatus(userId, connectionId, 'disconnected');
      });

      imap.connect();
    });
  } catch (error) {
    logger.error('Failed to connect to REAL IMAP', { userEmail, error: error.message });
    throw error;
  }
}

async connectSimulated(userEmail, userId) {
  // Existing simulated connection code
}
```

### Langkah 6: Modify Backup Service

**File: `backend/src/services/backup/scheduledBackup.js`**

```javascript
async backupUserMailbox(userId, userEmail) {
  try {
    logger.info('Starting mailbox backup', { userEmail });

    // Connect to IMAP
    const { imap, simulated } = await imapService.connect(userEmail, userId);

    if (simulated) {
      // Simulated backup for development
      // ... existing simulated code
    } else {
      // Real Gmail backup
      try {
        // Open INBOX
        await imapService.openMailbox(imap, 'INBOX');

        // Get last UID from database
        const lastUid = await imapService.getLastUid(userId);

        // Search for messages since last UID
        const searchCriteria = lastUid > 0 ? [['UID', `${lastUid + 1}:*`]] : ['ALL'];
        const results = await imapService.searchMessages(imap, searchCriteria);

        if (results.length === 0) {
          logger.info('No new messages to backup', { userEmail });
          return;
        }

        logger.info('Found messages to backup (REAL GMAIL)', { userEmail, count: results.length });

        // Process messages in batches
        const batchSize = 10;
        for (let i = 0; i < results.length; i += batchSize) {
          const batch = results.slice(i, i + batchSize);

          await Promise.all(
            batch.map(uid => imapService.fetchAndStoreMessage(imap, uid, userId, userEmail))
          );

          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        logger.info('REAL Gmail backup completed', { userEmail, processed: results.length });

      } finally {
        // Close IMAP connection
        imap.end();
      }
    }

  } catch (error) {
    logger.error('Failed to backup user mailbox', {
      userId,
      userEmail,
      error: error.message
    });
    throw error;
  }
}
```

### Langkah 7: Test Real Gmail Access

1. **Start Application**:
   ```bash
   cd backend && npm run dev:windows
   cd ../frontend && npm start
   ```

2. **Login & Setup**:
   - Login sebagai admin
   - Add domain (your-domain.com)
   - Add user dengan email Gmail real

3. **Test IMAP Connection**:
   - Click "Connect" pada user
   - Status harus "Connected (0m ago)" GREEN
   - Check logs untuk "IMAP connection ready (REAL GMAIL)"

4. **Test Manual Backup**:
   - Click "Run Now" button
   - Akan fetch email REAL dari Gmail
   - Check database untuk email records
   - Email count akan bertambah

### Troubleshooting Real Gmail Access

#### Error: "Invalid credentials"
```
Solution:
- Pastikan Service Account JSON file benar
- Pastikan Domain-Wide Delegation sudah setup
- Pastikan scope https://mail.google.com/ sudah ditambahkan
```

#### Error: "IMAP connection timeout"
```
Solution:
- Check firewall settings
- Pastikan Gmail IMAP enabled di account user
- Try different network connection
```

#### Error: "Access denied"
```
Solution:
- Pastikan user email ada di Google Workspace domain
- Pastikan Service Account punya akses ke domain tersebut
- Check Google Workspace admin console untuk API permissions
```

### Security Notes untuk Real Gmail Testing

1. **Use Test Account**: Jangan gunakan production Gmail account
2. **Limited Permissions**: Service account hanya dapat read email
3. **Monitor Usage**: Check Google Cloud billing untuk API usage
4. **Clean Up**: Delete test data setelah testing selesai

### Expected Results dengan Real Gmail

- ✅ **IMAP Status**: Connected (GREEN) untuk connections < 24 jam
- ✅ **Manual Backup**: Fetch real emails dari Gmail inbox
- ✅ **Email Data**: Real subjects, senders, dates, content
- ✅ **Search/Filter**: Bekerja dengan real email data
- ✅ **PST Export**: Dapat export real emails ke PST

---

**Dengan setup ini, Anda dapat test aplikasi dengan data email Gmail yang sesungguhnya!** 🎉