-- Google Workspace Email Backup Database Schema
-- Compatible with MySQL, PostgreSQL, and SQLite

-- Domains table
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(255) UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
  email VARCHAR(255) UNIQUE NOT NULL,
  last_uid INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for users table
CREATE INDEX IF NOT EXISTS idx_users_domain_id ON users(domain_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Emails table
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message_id VARCHAR(255) UNIQUE NOT NULL,
  subject TEXT,
  from_email VARCHAR(255),
  to_email TEXT,
  date DATETIME,
  eml_path VARCHAR(500),
  size INTEGER,
  folder VARCHAR(255) DEFAULT 'INBOX',
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for emails table
CREATE INDEX IF NOT EXISTS idx_emails_user_id ON emails(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
CREATE INDEX IF NOT EXISTS idx_emails_from_email ON emails(from_email);
CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder);

-- Note: Full-text search will be implemented using LIKE queries for cross-database compatibility
-- FTS can be added later as an enhancement

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER REFERENCES emails(id) ON DELETE CASCADE,
  filename VARCHAR(255),
  mime_type VARCHAR(100),
  size INTEGER,
  file_path VARCHAR(500)
);

-- Create index for attachments table
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);

-- PST Exports table
CREATE TABLE IF NOT EXISTS pst_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  filename VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  start_date DATE,
  end_date DATE,
  file_path VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Create indexes for pst_exports table
CREATE INDEX IF NOT EXISTS idx_pst_exports_user_id ON pst_exports(user_id);
CREATE INDEX IF NOT EXISTS idx_pst_exports_status ON pst_exports(status);
CREATE INDEX IF NOT EXISTS idx_pst_exports_created_at ON pst_exports(created_at);

-- Admin users table
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'admin' CHECK (role IN ('admin', 'viewer', 'super_admin')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Create index for admin_users table
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER REFERENCES admin_users(id),
  action VARCHAR(100) NOT NULL,
  resource VARCHAR(100),
  resource_id INTEGER,
  details TEXT,
  ip_address VARCHAR(45),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for audit_logs table
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_user_id ON audit_logs(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- IMAP connections table (for tracking active connections)
CREATE TABLE IF NOT EXISTS imap_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  connection_id VARCHAR(100) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'connecting' CHECK (status IN ('connecting', 'connected', 'idle', 'disconnected')),
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for imap_connections table
CREATE INDEX IF NOT EXISTS idx_imap_connections_user_id ON imap_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_imap_connections_status ON imap_connections(status);
CREATE INDEX IF NOT EXISTS idx_imap_connections_last_activity ON imap_connections(last_activity);

-- Email folder UIDs table (for tracking last processed UID per folder per user)
CREATE TABLE IF NOT EXISTS email_folder_uids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  folder_name VARCHAR(255) NOT NULL,
  last_uid INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, folder_name)
);

-- Create indexes for email_folder_uids table
CREATE INDEX IF NOT EXISTS idx_email_folder_uids_user_id ON email_folder_uids(user_id);
CREATE INDEX IF NOT EXISTS idx_email_folder_uids_folder ON email_folder_uids(folder_name);
