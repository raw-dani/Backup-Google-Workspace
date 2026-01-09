/**
 * Migration script to add file_path column to attachments table
 * Run this script to update existing databases
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/database.sqlite');
const BACKUP_DIR = process.env.BACKUP_DIR || './backup';

async function migrate() {
  console.log('🔄 Starting attachments migration...');
  console.log(`📁 Database: ${DB_PATH}`);
  console.log(`📁 Backup dir: ${BACKUP_DIR}`);

  let db;

  try {
    db = new Database(DB_PATH);

    // Check if file_path column already exists
    const tableInfo = db.prepare("PRAGMA table_info(attachments)").all();
    const hasFilePath = tableInfo.some(col => col.name === 'file_path');

    if (hasFilePath) {
      console.log('✅ file_path column already exists, skipping migration');
      return;
    }

    // Add file_path column
    console.log('📝 Adding file_path column to attachments table...');
    db.exec('ALTER TABLE attachments ADD COLUMN file_path VARCHAR(500)');
    console.log('✅ file_path column added successfully');

    // Now let's try to populate file_path for existing attachments
    console.log('📝 Populating file_path for existing attachments...');

    const attachments = db.prepare('SELECT a.id, a.email_id, e.eml_path FROM attachments a JOIN emails e ON a.email_id = e.id WHERE a.file_path IS NULL').all();

    console.log(`Found ${attachments.length} attachments without file_path`);

    let populated = 0;
    for (const att of attachments) {
      try {
        // Get email directory
        const emlDir = path.dirname(att.eml_path);
        const attachmentsDir = path.join(emlDir, 'attachments');

        // Try to find the attachment file
        if (fs.existsSync(attachmentsDir)) {
          const files = fs.readdirSync(attachmentsDir);
          // Try to match by filename or use first file if only one
          const matchingFile = files.find(f => f.includes(att.id.toString()) || f === att.id + '.bin');

          if (matchingFile) {
            const filePath = path.join(attachmentsDir, matchingFile);
            db.prepare('UPDATE attachments SET file_path = ? WHERE id = ?').run(filePath, att.id);
            populated++;
            continue;
          }
        }
      } catch (error) {
        // Continue even if we can't find the file
      }
    }

    console.log(`✅ Populated file_path for ${populated} attachments`);

    // Verify migration
    const verifyInfo = db.prepare("PRAGMA table_info(attachments)").all();
    const verifyHasFilePath = verifyInfo.some(col => col.name === 'file_path');

    if (verifyHasFilePath) {
      console.log('✅ Migration completed successfully!');
    } else {
      console.log('❌ Migration failed - column not found');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

// Run migration
migrate();
