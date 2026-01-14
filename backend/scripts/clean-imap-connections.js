#!/usr/bin/env node

const mysql = require('mysql2/promise');
require('dotenv').config();

const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  warn: (msg) => console.log(`[WARN] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.log(`[ERROR] ${new Date().toISOString()} - ${msg}`)
};

async function cleanImapConnections() {
  let connection;

  try {
    // Create database connection
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'gws_email_backup'
    });

    logger.info('Connected to database');

    // Check current connection records
    const [rows] = await connection.execute(
      'SELECT COUNT(*) as total FROM imap_connections'
    );
    const totalRecords = rows[0].total;
    logger.info(`Found ${totalRecords} connection records`);

    if (totalRecords === 0) {
      logger.info('No connection records to clean');
      return;
    }

    // Show sample of connection records
    const [sampleRows] = await connection.execute(
      'SELECT connection_id, status, last_activity FROM imap_connections LIMIT 10'
    );

    logger.info('Sample connection records:');
    sampleRows.forEach((row, index) => {
      logger.info(`  ${index + 1}. ID: ${row.connection_id}, Status: ${row.status}, Last Activity: ${row.last_activity}`);
    });

    // Count old connection records (more than 24 hours old)
    const [oldRows] = await connection.execute(
      'SELECT COUNT(*) as old_count FROM imap_connections WHERE last_activity < DATE_SUB(NOW(), INTERVAL 24 HOUR)'
    );
    const oldCount = oldRows[0].old_count;

    // Count simulated connections (if any)
    const [simRows] = await connection.execute(
      "SELECT COUNT(*) as sim_count FROM imap_connections WHERE connection_id LIKE 'dev-%' OR connection_id LIKE 'sim-%'"
    );
    const simCount = simRows[0].sim_count;

    logger.info(`Found ${oldCount} connections older than 24 hours`);
    logger.info(`Found ${simCount} simulated connections`);

    // Ask for confirmation
    console.log('\n=== CLEANUP PLAN ===');
    console.log(`Total records: ${totalRecords}`);
    console.log(`Old records (>24h): ${oldCount}`);
    console.log(`Simulated records: ${simCount}`);

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise((resolve) => {
      rl.question('\nProceed with cleanup? (y/N): ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase());
      });
    });

    if (answer !== 'y' && answer !== 'yes') {
      logger.info('Cleanup cancelled by user');
      return;
    }

    // Perform cleanup
    logger.info('Starting cleanup...');

    // Delete old connections (>24 hours)
    if (oldCount > 0) {
      const [deleteResult] = await connection.execute(
        'DELETE FROM imap_connections WHERE last_activity < DATE_SUB(NOW(), INTERVAL 24 HOUR)'
      );
      logger.info(`Deleted ${deleteResult.affectedRows} old connection records`);
    }

    // Delete simulated connections
    if (simCount > 0) {
      const [deleteResult] = await connection.execute(
        "DELETE FROM imap_connections WHERE connection_id LIKE 'dev-%' OR connection_id LIKE 'sim-%'"
      );
      logger.info(`Deleted ${deleteResult.affectedRows} simulated connection records`);
    }

    // Show remaining records
    const [remainingRows] = await connection.execute(
      'SELECT COUNT(*) as remaining FROM imap_connections'
    );
    const remainingCount = remainingRows[0].remaining;

    logger.info(`Cleanup completed. ${remainingCount} connection records remaining.`);

    // Show final state
    if (remainingCount > 0) {
      const [finalRows] = await connection.execute(
        'SELECT connection_id, status, last_activity FROM imap_connections ORDER BY last_activity DESC LIMIT 5'
      );

      logger.info('Remaining active connections:');
      finalRows.forEach((row, index) => {
        logger.info(`  ${index + 1}. ID: ${row.connection_id}, Status: ${row.status}, Last Activity: ${row.last_activity}`);
      });
    }

  } catch (error) {
    logger.error(`Cleanup failed: ${error.message}`);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      logger.info('Database connection closed');
    }
  }
}

// Run the cleanup
if (require.main === module) {
  console.log('=== IMAP Connections Cleanup Script ===');
  console.log('This script will clean old and simulated IMAP connection records');
  console.log('');

  cleanImapConnections().then(() => {
    console.log('\n=== Cleanup completed successfully ===');
    process.exit(0);
  }).catch((error) => {
    console.error('\n=== Cleanup failed ===');
    console.error(error);
    process.exit(1);
  });
}

module.exports = { cleanImapConnections };
