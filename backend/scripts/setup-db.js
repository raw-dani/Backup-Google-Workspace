const fs = require('fs').promises;
const path = require('path');
const { connectDB, query, closeDB } = require('../src/services/database/databaseService');

async function setupDatabase() {
  try {
    console.log('Setting up database...');

    // Connect to database
    await connectDB();

    // Read schema file
    const schemaPath = path.join(__dirname, '../src/config/database.sql');
    const schemaSQL = await fs.readFile(schemaPath, 'utf8');

    // Split SQL commands properly handling multi-line statements
    const commands = [];
    let currentCommand = '';
    let inTrigger = false;

    const lines = schemaSQL.split('\n');
    for (const line of lines) {
      currentCommand += line + '\n';

      // Check if we're entering a trigger definition
      if (line.trim().toUpperCase().startsWith('CREATE TRIGGER')) {
        inTrigger = true;
      }

      // Check for statement end
      if (line.trim().endsWith(';')) {
        if (inTrigger && !line.trim().toUpperCase().includes('END;')) {
          // Continue if we're in a trigger and haven't reached END;
          continue;
        }

        // Statement is complete
        commands.push(currentCommand.trim());
        currentCommand = '';
        inTrigger = false;
      }
    }

    // Add any remaining command
    if (currentCommand.trim()) {
      commands.push(currentCommand.trim());
    }

    console.log(`Executing ${commands.length} SQL commands...`);

    for (let i = 0; i < commands.length; i++) {
      const command = commands[i].trim();
      if (command) {
        try {
          await query(command);
          console.log(`✓ Executed command ${i + 1}/${commands.length}`);
        } catch (error) {
          // Ignore table/index already exists errors for SQLite
          const errorMsg = error.message.toLowerCase();
          if (!errorMsg.includes('already exists') &&
              !errorMsg.includes('duplicate') &&
              !errorMsg.includes('index') &&
              !errorMsg.includes('trigger')) {
            console.warn(`⚠ Warning on command ${i + 1}:`, error.message);
          } else {
            console.log(`✓ Command ${i + 1} already exists (skipped)`);
          }
        }
      }
    }

    console.log('Database setup completed successfully!');

    // Create default admin user for development
    try {
      const bcrypt = require('bcrypt');
      const saltRounds = 12;
      const defaultPassword = 'admin123';
      const hashedPassword = await bcrypt.hash(defaultPassword, saltRounds);

      // Use SQLite-compatible INSERT OR IGNORE
      await query(
        'INSERT OR IGNORE INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
        ['admin', hashedPassword, 'admin']
      );

      console.log('Default admin user created:');
      console.log('Username: admin');
      console.log('Password: admin123');
      console.log('⚠️  CHANGE THIS PASSWORD IN PRODUCTION!');
    } catch (error) {
      console.log('Default admin user may already exist or table not ready');
    }

  } catch (error) {
    console.error('Database setup failed:', error);
    process.exit(1);
  } finally {
    await closeDB();
  }
}

// Run setup if called directly
if (require.main === module) {
  setupDatabase();
}

module.exports = { setupDatabase };