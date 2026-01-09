/**
 * Migration script: SQLite to MySQL
 * Migrates all data from SQLite to MySQL database
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');

const SQLITE_DB_PATH = path.join(__dirname, '../data/database.sqlite');
const BACKUP_DIR = process.env.BACKUP_DIR || './backup';

async function migrate() {
  console.log('🔄 Starting SQLite to MySQL migration...');
  console.log(`📁 SQLite DB: ${SQLITE_DB_PATH}`);
  console.log(`📁 Backup dir: ${BACKUP_DIR}`);

  let sqliteDb;
  let mysqlConn;

  try {
    // Connect to SQLite
    console.log('📝 Connecting to SQLite...');
    sqliteDb = new Database(SQLITE_DB_PATH);

    // Connect to MySQL
    console.log('📝 Connecting to MySQL...');
    mysqlConn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'gws_email_backup',
      multipleStatements: true
    });

    console.log('✅ Connected to MySQL');

    // Create tables in MySQL
    console.log('📝 Creating MySQL tables...');
    await createMySQLTables(mysqlConn);

    // Migrate data
    console.log('📝 Migrating domains...');
    await migrateDomains(sqliteDb, mysqlConn);

    console.log('📝 Migrating users...');
    await migrateUsers(sqliteDb, mysqlConn);

    console.log('📝 Migrating emails...');
    await migrateEmails(sqliteDb, mysqlConn);

    console.log('📝 Migrating attachments...');
    await migrateAttachments(sqliteDb, mysqlConn);

    console.log('📝 Migrating admin users...');
    await migrateAdminUsers(sqliteDb, mysqlConn);

    console.log('📝 Migrating audit logs...');
    await migrateAuditLogs(sqliteDb, mysqlConn);

    console.log('📝 Migrating PST exports...');
    await migratePstExports(sqliteDb, mysqlConn);

    console.log('📝 Migrating IMAP connections...');
    await migrateImapConnections(sqliteDb, mysqlConn);

    // Verify migration
    const counts = await verifyMigration(mysqlConn);
    console.log('\n📊 Migration Summary:');
    console.log(`   Domains: ${counts.domains}`);
    console.log(`   Users: ${counts.users}`);
    console.log(`   Emails: ${counts.emails}`);
    console.log(`   Attachments: ${counts.attachments}`);
    console.log(`   Admin Users: ${counts.adminUsers}`);
    console.log(`   Audit Logs: ${counts.auditLogs}`);
    console.log(`   PST Exports: ${counts.pstExports}`);
    console.log(`   IMAP Connections: ${counts.imapConnections}`);

    console.log('\n✅ Migration completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('1. Update .env to use MySQL: DB_TYPE=mysql');
    console.log('2. Restart the application');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (sqliteDb) sqliteDb.close();
    if (mysqlConn) await mysqlConn.end();
  }
}

async function createMySQLTables(conn) {
  const schema = `
    -- Domains table
    CREATE TABLE IF NOT EXISTS domains (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      domain_id INT,
      email VARCHAR(255) UNIQUE NOT NULL,
      last_uid INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
    );

    -- Emails table
    CREATE TABLE IF NOT EXISTS emails (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      message_id VARCHAR(255) UNIQUE NOT NULL,
      subject TEXT,
      from_email VARCHAR(255),
      to_email TEXT,
      date DATETIME,
      eml_path VARCHAR(500),
      size INT,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Attachments table (with file_path column)
    CREATE TABLE IF NOT EXISTS attachments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email_id INT NOT NULL,
      filename VARCHAR(255),
      mime_type VARCHAR(100),
      size INT,
      file_path VARCHAR(500),
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
    );

    -- Admin users table
    CREATE TABLE IF NOT EXISTS admin_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    -- Audit logs table
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_user_id INT,
      action VARCHAR(100) NOT NULL,
      resource VARCHAR(100),
      resource_id INT,
      ip_address VARCHAR(45),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
    );

    -- PST Exports table
    CREATE TABLE IF NOT EXISTS pst_exports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      filename VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      start_date DATE,
      end_date DATE,
      file_path VARCHAR(500),
      export_format VARCHAR(20) DEFAULT 'eml',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- IMAP connections table
    CREATE TABLE IF NOT EXISTS imap_connections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      connection_id VARCHAR(100) UNIQUE NOT NULL,
      status VARCHAR(20) DEFAULT 'connecting',
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_users_domain_id ON users(domain_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_emails_user_id ON emails(user_id);
    CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
    CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
    CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
    CREATE INDEX IF NOT EXISTS idx_pst_exports_user_id ON pst_exports(user_id);
    CREATE INDEX IF NOT EXISTS idx_pst_exports_status ON pst_exports(status);
    CREATE INDEX IF NOT EXISTS idx_imap_connections_user_id ON imap_connections(user_id);
  `;

  await conn.query(schema);
  console.log('✅ MySQL tables created');
}

async function migrateDomains(sqliteDb, mysqlConn) {
  const domains = sqliteDb.prepare('SELECT * FROM domains').all();
  
  for (const domain of domains) {
    await mysqlConn.query(
      'INSERT INTO domains (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [domain.id, domain.name, domain.created_at, domain.updated_at]
    );
  }
  console.log(`✅ Migrated ${domains.length} domains`);
}

async function migrateUsers(sqliteDb, mysqlConn) {
  const users = sqliteDb.prepare('SELECT * FROM users').all();
  
  for (const user of users) {
    await mysqlConn.query(
      'INSERT INTO users (id, domain_id, email, last_uid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)',
      [user.id, user.domain_id, user.email, user.last_uid || 0, user.status || 'active', user.created_at, user.updated_at]
    );
  }
  console.log(`✅ Migrated ${users.length} users`);
}

async function migrateEmails(sqliteDb, mysqlConn) {
  const emails = sqliteDb.prepare('SELECT * FROM emails').all();
  
  for (const email of emails) {
    await mysqlConn.query(
      `INSERT INTO emails (id, user_id, message_id, subject, from_email, to_email, date, eml_path, size, indexed_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
       ON DUPLICATE KEY UPDATE subject = VALUES(subject)`,
      [email.id, email.user_id, email.message_id, email.subject, email.from_email, email.to_email, email.date, email.eml_path, email.size || 0, email.indexed_at]
    );
  }
  console.log(`✅ Migrated ${emails.length} emails`);
}

async function migrateAttachments(sqliteDb, mysqlConn) {
  const attachments = sqliteDb.prepare('SELECT * FROM attachments').all();
  
  for (const att of attachments) {
    // Check if file_path column exists in SQLite
    const tableInfo = sqliteDb.prepare("PRAGMA table_info(attachments)").all();
    const hasFilePath = tableInfo.some(col => col.name === 'file_path');
    
    const filePath = hasFilePath && att.file_path ? att.file_path : null;
    
    await mysqlConn.query(
      'INSERT INTO attachments (id, email_id, filename, mime_type, size, file_path) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE filename = VALUES(filename)',
      [att.id, att.email_id, att.filename, att.mime_type, att.size || 0, filePath]
    );
  }
  console.log(`✅ Migrated ${attachments.length} attachments`);
}

async function migrateAdminUsers(sqliteDb, mysqlConn) {
  const admins = sqliteDb.prepare('SELECT * FROM admin_users').all();
  
  for (const admin of admins) {
    await mysqlConn.query(
      'INSERT INTO admin_users (id, username, password_hash, role, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username)',
      [admin.id, admin.username, admin.password_hash, admin.role || 'admin', admin.created_at, admin.last_login]
    );
  }
  console.log(`✅ Migrated ${admins.length} admin users`);
}

async function migrateAuditLogs(sqliteDb, mysqlConn) {
  const logs = sqliteDb.prepare('SELECT * FROM audit_logs').all();
  
  for (const log of logs) {
    await mysqlConn.query(
      'INSERT INTO audit_logs (id, admin_user_id, action, resource, resource_id, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [log.id, log.admin_user_id, log.action, log.resource, log.resource_id, log.ip_address, log.created_at]
    );
  }
  console.log(`✅ Migrated ${logs.length} audit logs`);
}

async function migratePstExports(sqliteDb, mysqlConn) {
  const exports = sqliteDb.prepare('SELECT * FROM pst_exports').all();
  
  for (const exp of exports) {
    // Check for export_format column
    const tableInfo = sqliteDb.prepare("PRAGMA table_info(pst_exports)").all();
    const hasExportFormat = tableInfo.some(col => col.name === 'export_format');
    
    const exportFormat = hasExportFormat && exp.export_format ? exp.export_format : 'eml';
    
    await mysqlConn.query(
      'INSERT INTO pst_exports (id, user_id, filename, status, start_date, end_date, file_path, export_format, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [exp.id, exp.user_id, exp.filename, exp.status, exp.start_date, exp.end_date, exp.file_path, exportFormat, exp.created_at, exp.completed_at]
    );
  }
  console.log(`✅ Migrated ${exports.length} PST exports`);
}

async function migrateImapConnections(sqliteDb, mysqlConn) {
  const connections = sqliteDb.prepare('SELECT * FROM imap_connections').all();
  
  for (const conn of connections) {
    await mysqlConn.query(
      'INSERT INTO imap_connections (id, user_id, connection_id, status, last_activity, created_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE connection_id = VALUES(connection_id)',
      [conn.id, conn.user_id, conn.connection_id, conn.status, conn.last_activity, conn.created_at]
    );
  }
  console.log(`✅ Migrated ${connections.length} IMAP connections`);
}

async function verifyMigration(mysqlConn) {
  const [domains] = await mysqlConn.query('SELECT COUNT(*) as count FROM domains');
  const [users] = await mysqlConn.query('SELECT COUNT(*) as count FROM users');
  const [emails] = await mysqlConn.query('SELECT COUNT(*) as count FROM emails');
  const [attachments] = await mysqlConn.query('SELECT COUNT(*) as count FROM attachments');
  const [adminUsers] = await mysqlConn.query('SELECT COUNT(*) as count FROM admin_users');
  const [auditLogs] = await mysqlConn.query('SELECT COUNT(*) as count FROM audit_logs');
  const [pstExports] = await mysqlConn.query('SELECT COUNT(*) as count FROM pst_exports');
  const [imapConnections] = await mysqlConn.query('SELECT COUNT(*) as count FROM imap_connections');

  return {
    domains: domains[0].count,
    users: users[0].count,
    emails: emails[0].count,
    attachments: attachments[0].count,
    adminUsers: adminUsers[0].count,
    auditLogs: auditLogs[0].count,
    pstExports: pstExports[0].count,
    imapConnections: imapConnections[0].count
  };
}

// Run migration
migrate();
