const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcrypt');

// Read DB_TYPE from .env file
function getDBType() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const dbTypeMatch = envContent.match(/DB_TYPE\s*=\s*(\w+)/);
    if (dbTypeMatch) return dbTypeMatch[1];
  }
  return 'sqlite';
}

// Get DB config based on type
function getDBConfig() {
  const dbType = getDBType();
  return {
    type: dbType,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || (dbType === 'postgresql' ? 5432 : 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gws_email_backup',
    file: process.env.DB_FILE || './data/database.sqlite'
  };
}

// Setup initial admin user
async function setupAdmin() {
  const dbConfig = getDBConfig();
  const dbType = dbConfig.type;
  
  console.log(`Detected DB_TYPE: ${dbType}`);
  
  let connection = null;
  let query = null;
  
  try {
    if (dbType === 'mysql') {
      const mysql = require('mysql2/promise');
      connection = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database
      });
      query = async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows;
      };
      console.log('✅ Connected to MySQL');
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
      query = async (sql, params) => {
        const result = await connection.query(sql, params);
        return result.rows;
      };
      console.log('✅ Connected to PostgreSQL');
    } else {
      // SQLite
      const sqlite3 = require('sqlite3').verbose();
      connection = new sqlite3.Database(dbConfig.file);
      query = async (sql, params) => {
        return new Promise((resolve, reject) => {
          connection.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row ? [row] : []);
          });
        });
      };
      console.log(`✅ Connected to SQLite: ${dbConfig.file}`);
    }
    
    console.log('🔍 Checking if admin user already exists...');
    
    // Check if admin user exists and get role
    let existingAdmins;
    let getAdminQuery;
    
    if (dbType === 'mysql') {
      existingAdmins = await query('SELECT id, role FROM admin_users LIMIT 1');
    } else if (dbType === 'postgresql') {
      existingAdmins = await query('SELECT id, role FROM admin_users LIMIT 1');
    } else {
      existingAdmins = await query('SELECT id, role FROM admin_users LIMIT 1');
    }
    
    if (existingAdmins.length > 0) {
      const admin = existingAdmins[0];
      if (admin.role === 'super_admin') {
        console.log('✅ Super admin user already exists');
        process.exit(0);
      } else {
        // Update existing admin to super_admin
        console.log(`⚠️  Admin user exists but role is '${admin.role}'. Upgrading to super_admin...`);
        
        const password = 'admin123';
        const saltRounds = 12;
        console.log('🔐 Hashing password...');
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        
        if (dbType === 'mysql') {
          await query(
            'UPDATE admin_users SET password_hash = ?, role = ? WHERE id = ?',
            [hashedPassword, 'super_admin', admin.id]
          );
        } else if (dbType === 'postgresql') {
          await query(
            'UPDATE admin_users SET password_hash = $1, role = $2 WHERE id = $3',
            [hashedPassword, 'super_admin', admin.id]
          );
        } else {
          await query(
            'UPDATE admin_users SET password_hash = ?, role = ? WHERE id = ?',
            [hashedPassword, 'super_admin', admin.id]
          );
        }
        
        console.log('✅ Admin role upgraded to super_admin!');
        console.log(`👤 Username: admin`);
        console.log(`🔑 Password: admin123`);
        console.log(`🎯 Role: super_admin`);
        console.log(`🗄️ Database: ${dbType.toUpperCase()}`);
        console.log('');
        console.log('⚠️  IMPORTANT: Change the default password after first login!');
        process.exit(0);
      }
    }
    
    // Create admin user as super_admin
    const username = 'admin';
    const password = 'admin123';
    const saltRounds = 12;
    
    console.log('🔐 Hashing password...');
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    console.log('👤 Creating super_admin user...');
    
    if (dbType === 'mysql') {
      await query(
        'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, hashedPassword, 'super_admin']
      );
    } else if (dbType === 'postgresql') {
      await query(
        'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3)',
        [username, hashedPassword, 'super_admin']
      );
    } else {
      await query(
        'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, hashedPassword, 'super_admin']
      );
    }
    
    console.log('✅ Super admin user created successfully!');
    console.log(`👤 Username: ${username}`);
    console.log(`🔑 Password: ${password}`);
    console.log(`🎯 Role: super_admin`);
    console.log(`🗄️ Database: ${dbType.toUpperCase()}`);
    console.log('');
    console.log('⚠️  IMPORTANT: Change the default password after first login!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Failed to setup admin user:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      if (dbType === 'mysql' || dbType === 'postgresql') {
        await connection.end?.();
      } else {
        connection.close?.();
      }
    }
  }
}

// Run setup
setupAdmin();
