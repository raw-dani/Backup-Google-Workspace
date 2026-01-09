const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/database.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

let db;
let sqliteDb;

const DB_TYPE = process.env.DB_TYPE || (process.platform === 'win32' ? 'sqlite' : 'mysql'); // 'mysql', 'postgresql', or 'sqlite'
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || (DB_TYPE === 'postgresql' ? 5432 : 3306);
const DB_NAME = process.env.DB_NAME || 'gws_email_backup';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_FILE = process.env.DB_FILE || './data/database.sqlite';

async function connectDB() {
  try {
    if (DB_TYPE === 'sqlite') {
      // Ensure data directory exists
      const dataDir = path.dirname(DB_FILE);
      await fs.mkdir(dataDir, { recursive: true });

      sqliteDb = new sqlite3.Database(DB_FILE);

      // Enable foreign keys
      sqliteDb.run('PRAGMA foreign_keys = ON');

      // Create promise-based wrapper
      db = {
        run: (sql, params = []) => {
          return new Promise((resolve, reject) => {
            sqliteDb.run(sql, params, function(err) {
              if (err) reject(err);
              else resolve({ lastID: this.lastID, changes: this.changes });
            });
          });
        },
        get: (sql, params = []) => {
          return new Promise((resolve, reject) => {
            sqliteDb.get(sql, params, (err, row) => {
              if (err) reject(err);
              else resolve(row);
            });
          });
        },
        all: (sql, params = []) => {
          return new Promise((resolve, reject) => {
            sqliteDb.all(sql, params, (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            });
          });
        },
        close: () => {
          return new Promise((resolve, reject) => {
            sqliteDb.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
      };

      logger.info('SQLite database connected successfully', { file: DB_FILE });
    } else if (DB_TYPE === 'postgresql') {
      db = new Pool({
        host: DB_HOST,
        port: DB_PORT,
        database: DB_NAME,
        user: DB_USER,
        password: DB_PASSWORD,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });
    } else {
      db = mysql.createPool({
        host: DB_HOST,
        port: DB_PORT,
        database: DB_NAME,
        user: DB_USER,
        password: DB_PASSWORD,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
    }

    // Test connection (skip for SQLite as it's already connected)
    if (DB_TYPE !== 'sqlite') {
      const connection = await db.getConnection ? db.getConnection() : db.connect();
      logger.info('Database connected successfully');
      if (connection.release) connection.release();
      if (connection.end) connection.end();
    }

    // Initialize schema
    await initializeSchema();

  } catch (error) {
    logger.error('Database connection failed', { error: error.message });
    throw error;
  }
}

async function initializeSchema() {
  try {
    const schemaPath = path.join(__dirname, '../../config/database.sql');
    let schemaSQL = await fs.readFile(schemaPath, 'utf8');

    // Adapt SQL syntax based on database type
    schemaSQL = adaptSchemaForDatabase(schemaSQL, DB_TYPE);

    // Split SQL commands and execute them
    const commands = schemaSQL.split(';').filter(cmd => cmd.trim().length > 0);

    for (const command of commands) {
      if (command.trim()) {
        try {
          await query(command.trim());
        } catch (queryError) {
          const errorMsg = queryError.message.toLowerCase();
          const commandUpper = command.trim().toUpperCase();

          // Handle "already exists" errors gracefully
          if (errorMsg.includes('already exists') ||
              errorMsg.includes('duplicate key name') ||
              errorMsg.includes('table') && errorMsg.includes('exists') ||
              errorMsg.includes('index') && errorMsg.includes('exists')) {
            logger.info('Index already exists, skipping', {
              command: command.trim().substring(0, 100) + '...'
            });
            continue;
          }

          // For other errors, log and continue (don't fail completely)
          logger.warn('Database initialization warning', {
            command: command.trim().substring(0, 100) + '...',
            error: queryError.message
          });
        }
      }
    }

    logger.info('Database schema initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database schema', { error: error.message });
    throw error;
  }
}

function adaptSchemaForDatabase(sql, dbType) {
  let adaptedSQL = sql;

  if (dbType === 'mysql') {
    // Replace SQLite AUTOINCREMENT with MySQL AUTO_INCREMENT
    adaptedSQL = adaptedSQL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'INT PRIMARY KEY AUTO_INCREMENT');
    // Remove IF NOT EXISTS from CREATE INDEX for MySQL compatibility
    adaptedSQL = adaptedSQL.replace(/CREATE INDEX IF NOT EXISTS/g, 'CREATE INDEX');
  } else if (dbType === 'postgresql') {
    // Replace SQLite AUTOINCREMENT with PostgreSQL SERIAL
    adaptedSQL = adaptedSQL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');
  }
  // For SQLite, keep the original syntax

  return adaptedSQL;
}

async function query(sql, params = []) {
  try {
    if (DB_TYPE === 'sqlite') {
      // For SELECT queries, use 'all', for others use 'run'
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return await db.all(sql, params);
      } else {
        return await db.run(sql, params);
      }
    } else if (DB_TYPE === 'postgresql') {
      const result = await db.query(sql, params);
      return result.rows;
    } else {
      const [rows] = await db.execute(sql, params);
      return rows;
    }
  } catch (error) {
    logger.error('Database query failed', { sql, error: error.message });
    throw error;
  }
}

async function getConnection() {
  if (DB_TYPE === 'postgresql') {
    return await db.connect();
  } else {
    return await db.getConnection();
  }
}

async function beginTransaction() {
  const connection = await getConnection();
  if (DB_TYPE === 'postgresql') {
    await connection.query('BEGIN');
  } else {
    await connection.beginTransaction();
  }
  return connection;
}

async function commitTransaction(connection) {
  if (DB_TYPE === 'postgresql') {
    await connection.query('COMMIT');
  } else {
    await connection.commit();
  }
  connection.release ? connection.release() : connection.end();
}

async function rollbackTransaction(connection) {
  if (DB_TYPE === 'postgresql') {
    await connection.query('ROLLBACK');
  } else {
    await connection.rollback();
  }
  connection.release ? connection.release() : connection.end();
}

async function closeDB() {
  if (db) {
    if (DB_TYPE === 'sqlite') {
      await db.close();
    } else if (DB_TYPE === 'postgresql') {
      await db.end();
    } else {
      await db.end();
    }
    logger.info('Database connection closed');
  }
}

module.exports = {
  connectDB,
  query,
  getConnection,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  closeDB,
  DB_TYPE,
};
