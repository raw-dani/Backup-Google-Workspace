/**
 * Quick fix: Add missing columns to emails table
 */

const mysql = require('mysql2/promise');

async function migrate() {
  console.log('🔄 Fixing emails table schema...');

  let conn;

  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'gws_email_backup'
    });

    console.log('✅ Connected to MySQL');

    // Add missing columns to emails table
    console.log('📝 Adding columns to emails table...');
    
    await addColumnIfNotExists(conn, 'emails', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
    await addColumnIfNotExists(conn, 'emails', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await addColumnIfNotExists(conn, 'emails', 'indexed_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

    console.log('✅ Emails table schema fixed!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

async function addColumnIfNotExists(conn, tableName, columnName, columnDef) {
  try {
    const [columns] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [process.env.DB_NAME || 'gws_email_backup', tableName, columnName]
    );

    if (columns.length === 0) {
      await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
      console.log(`   Added ${tableName}.${columnName}`);
    } else {
      console.log(`   ${tableName}.${columnName} already exists`);
    }
  } catch (error) {
    console.error(`   Error: ${error.message}`);
  }
}

migrate();
