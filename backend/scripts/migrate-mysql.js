/**
 * MySQL Database Migration Script
 * Updates existing MySQL database schema with new columns
 */

const mysql = require('mysql2/promise');

async function migrate() {
  console.log('🔄 Starting MySQL database migration...');

  let conn;

  try {
    // Connect to MySQL
    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'gws_email_backup'
    });

    console.log('✅ Connected to MySQL');

    // Add file_path column to attachments table if not exists
    console.log('📝 Checking attachments table...');
    await addColumnIfNotExists(conn, 'attachments', 'file_path', 'VARCHAR(500) NULL');
    console.log('✅ attachments.file_path column ready');

    // Add export_format column to pst_exports table if not exists
    console.log('📝 Checking pst_exports table...');
    await addColumnIfNotExists(conn, 'pst_exports', 'export_format', "VARCHAR(20) DEFAULT 'eml'");
    await addColumnIfNotExists(conn, 'pst_exports', 'start_date', 'DATE NULL');
    await addColumnIfNotExists(conn, 'pst_exports', 'end_date', 'DATE NULL');
    console.log('✅ pst_exports columns ready');

    // Create indexes if not exist
    console.log('📝 Creating indexes...');
    await createIndexIfNotExists(conn, 'idx_users_domain_id', 'users', 'domain_id');
    await createIndexIfNotExists(conn, 'idx_users_email', 'users', 'email');
    await createIndexIfNotExists(conn, 'idx_emails_user_id', 'emails', 'user_id');
    await createIndexIfNotExists(conn, 'idx_emails_message_id', 'emails', 'message_id');
    await createIndexIfNotExists(conn, 'idx_emails_date', 'emails', 'date');
    await createIndexIfNotExists(conn, 'idx_attachments_email_id', 'attachments', 'email_id');
    await createIndexIfNotExists(conn, 'idx_pst_exports_user_id', 'pst_exports', 'user_id');
    await createIndexIfNotExists(conn, 'idx_pst_exports_status', 'pst_exports', 'status');
    await createIndexIfNotExists(conn, 'idx_imap_connections_user_id', 'imap_connections', 'user_id');
    console.log('✅ Indexes ready');

    // Verify tables
    console.log('\n📊 Database Status:');
    await showTableCount(conn, 'domains');
    await showTableCount(conn, 'users');
    await showTableCount(conn, 'emails');
    await showTableCount(conn, 'attachments');
    await showTableCount(conn, 'admin_users');
    await showTableCount(conn, 'pst_exports');

    console.log('\n✅ Migration completed successfully!');
    console.log('📝 The database schema is now up to date.');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

async function addColumnIfNotExists(conn, tableName, columnName, columnDef) {
  try {
    // Check if column exists
    const [columns] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [process.env.DB_NAME || 'gws_email_backup', tableName, columnName]
    );

    if (columns.length === 0) {
      // Add column
      await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
      console.log(`   Added ${tableName}.${columnName}`);
    } else {
      console.log(`   ${tableName}.${columnName} already exists`);
    }
  } catch (error) {
    console.error(`   Error checking ${tableName}.${columnName}:`, error.message);
  }
}

async function createIndexIfNotExists(conn, indexName, tableName, columnName) {
  try {
    // Check if index exists
    const [indexes] = await conn.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [process.env.DB_NAME || 'gws_email_backup', tableName, indexName]
    );

    if (indexes.length === 0) {
      // Create index
      await conn.query(`CREATE INDEX ${indexName} ON ${tableName} (${columnName})`);
      console.log(`   Created index ${indexName}`);
    } else {
      console.log(`   Index ${indexName} already exists`);
    }
  } catch (error) {
    // Index might already exist with different name
    console.log(`   Index ${indexName} check: ${error.message}`);
  }
}

async function showTableCount(conn, tableName) {
  try {
    const [result] = await conn.query(`SELECT COUNT(*) as count FROM ${tableName}`);
    console.log(`   ${tableName}: ${result[0].count} rows`);
  } catch (error) {
    console.log(`   ${tableName}: Error - ${error.message}`);
  }
}

// Run migration
migrate();
