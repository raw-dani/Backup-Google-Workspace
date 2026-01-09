// Fix admin_users CHECK constraint to allow super_admin role
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function getDBType() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const dbTypeMatch = envContent.match(/DB_TYPE\s*=\s*(\w+)/);
    if (dbTypeMatch) return dbTypeMatch[1];
  }
  return 'sqlite';
}

async function fixConstraint() {
  const dbType = getDBType();
  
  if (dbType !== 'mysql') {
    console.log('ℹ️  This script is for MySQL only. Your DB_TYPE is:', dbType);
    console.log('   The database.sql schema has been updated for new installations.');
    process.exit(0);
  }
  
  let connection = null;
  
  try {
    const mysql = require('mysql2/promise');
    const dbConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'gws_email_backup'
    };
    
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connected to MySQL');
    
    // Drop old check constraint
    console.log('🔧 Dropping old CHECK constraint...');
    try {
      await connection.query('ALTER TABLE admin_users DROP CHECK admin_users_chk_1');
      console.log('✅ Dropped old constraint');
    } catch (e) {
      if (e.message.includes('CHECK')) {
        console.log('ℹ️  No check constraint found or already dropped');
      } else {
        console.log('⚠️  Could not drop constraint:', e.message);
      }
    }
    
    // Add new check constraint with super_admin
    console.log('🔧 Adding new CHECK constraint with super_admin...');
    await connection.query(
      'ALTER TABLE admin_users ADD CONSTRAINT admin_users_chk_1 CHECK (role IN (\'admin\', \'viewer\', \'super_admin\'))'
    );
    console.log('✅ Added new constraint');
    
    // Upgrade existing admin to super_admin
    console.log('🔧 Checking and upgrading existing admin...');
    const [admins] = await connection.query('SELECT id, role FROM admin_users LIMIT 1');
    if (admins.length > 0 && admins[0].role !== 'super_admin') {
      const bcrypt = require('bcrypt');
      const hashedPassword = await bcrypt.hash('admin123', 12);
      await connection.query(
        'UPDATE admin_users SET password_hash = ?, role = ? WHERE id = ?',
        [hashedPassword, 'super_admin', admins[0].id]
      );
      console.log('✅ Upgraded existing admin to super_admin');
    } else if (admins.length > 0) {
      console.log('✅ Admin is already super_admin');
    }
    
    console.log('\n✅ Fix completed successfully!');
    
  } catch (error) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

fixConstraint();
