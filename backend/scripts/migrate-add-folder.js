// Migration script to add folder column and create email_folder_uids table
// Auto-detects database type from .env file

const fs = require('fs');
const path = require('path');

// Read DB_TYPE from .env file
function getDBType() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const dbTypeMatch = envContent.match(/DB_TYPE\s*=\s*(\w+)/);
    if (dbTypeMatch) return dbTypeMatch[1];
  }
  // Default to sqlite if not found
  return 'sqlite';
}

// Get DB config
function getDBConfig() {
  const dbType = getDBType();
  const port = dbType === 'postgresql' ? 5432 : 3306;
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || port,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gws_email_backup',
    type: dbType
  };
}

async function migrate() {
  const dbConfig = getDBConfig();
  const dbType = dbConfig.type;
  
  console.log(`Detected DB_TYPE: ${dbType}`);
  console.log(`Database: ${dbConfig.database} on ${dbConfig.host}:${dbConfig.port}`);
  
  let connection = null;
  
  try {
    if (dbType === 'mysql') {
      const mysql = require('mysql2/promise');
      connection = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        multipleStatements: true
      });
      console.log('✅ MySQL connected successfully.');
    } else if (dbType === 'postgresql') {
      const { Pool } = require('pg');
      connection = new Pool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database
      });
      await connection.connect();
      console.log('✅ PostgreSQL connected successfully.');
    } else {
      // SQLite
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = process.env.DB_FILE || './data/database.sqlite';
      connection = new sqlite3.Database(dbPath);
      console.log(`✅ SQLite connected successfully. File: ${dbPath}`);
    }
    
    console.log('\n--- Adding folder column to emails table ---');
    
    // Check and add folder column
    if (dbType === 'mysql') {
      try {
        await connection.query('SELECT folder FROM emails LIMIT 1');
        console.log('ℹ️  Folder column already exists.');
      } catch (e) {
        await connection.query('ALTER TABLE emails ADD COLUMN folder VARCHAR(255) DEFAULT "INBOX"');
        console.log('✅ Added folder column.');
      }
    } else if (dbType === 'postgresql') {
      try {
        await connection.query('SELECT folder FROM emails LIMIT 1');
        console.log('ℹ️  Folder column already exists.');
      } catch (e) {
        await connection.query('ALTER TABLE emails ADD COLUMN folder VARCHAR(255) DEFAULT \'INBOX\'');
        console.log('✅ Added folder column.');
      }
    } else {
      // SQLite
      connection.get('SELECT folder FROM emails LIMIT 1', (err, row) => {
        if (err && err.message.includes('no such column')) {
          connection.run('ALTER TABLE emails ADD COLUMN folder VARCHAR(255) DEFAULT "INBOX"');
          console.log('✅ Added folder column.');
        } else {
          console.log('ℹ️  Folder column already exists.');
        }
      });
    }
    
    console.log('\n--- Creating email_folder_uids table ---');
    
    // Create email_folder_uids table
    if (dbType === 'mysql') {
      await connection.query('DROP TABLE IF EXISTS email_folder_uids');
      await connection.query(`
        CREATE TABLE email_folder_uids (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          folder_name VARCHAR(255) NOT NULL,
          last_uid INT DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_user_folder (user_id, folder_name),
          INDEX idx_user_id (user_id),
          INDEX idx_folder_name (folder_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('✅ Created email_folder_uids table (MySQL).');
    } else if (dbType === 'postgresql') {
      await connection.query('DROP TABLE IF EXISTS email_folder_uids');
      await connection.query(`
        CREATE TABLE email_folder_uids (
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL,
          folder_name VARCHAR(255) NOT NULL,
          last_uid INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, folder_name)
        )
      `);
      console.log('✅ Created email_folder_uids table (PostgreSQL).');
    } else {
      // SQLite
      await new Promise((resolve, reject) => {
        connection.run('DROP TABLE IF EXISTS email_folder_uids', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise((resolve, reject) => {
        connection.run(`
          CREATE TABLE email_folder_uids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            folder_name TEXT NOT NULL,
            last_uid INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, folder_name)
          )
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('✅ Created email_folder_uids table (SQLite).');
    }
    
    console.log('\n✅ Migration completed successfully!');
    console.log('');
    console.log('Summary:');
    console.log(`- emails.folder column: ${dbType.toUpperCase()}`);
    console.log(`- email_folder_uids table: ${dbType.toUpperCase()}`);
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
  } finally {
    if (connection) {
      if (dbType === 'mysql' || dbType === 'postgresql') {
        await connection.end?.();
      } else {
        connection.close?.();
      }
    }
    process.exit(0);
  }
}

migrate();
