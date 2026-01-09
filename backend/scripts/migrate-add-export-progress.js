// Migration script to add progress column to pst_exports table
const { connectDB, query, closeDB } = require('../src/services/database/databaseService');

async function migrate() {
  try {
    // Connect to database
    await connectDB();
    console.log('Database connected successfully.');
    
    console.log('Adding progress column to pst_exports table...');
    
    // Check if column exists first
    const checkResult = await query("SHOW COLUMNS FROM pst_exports LIKE 'progress'");
    if (checkResult && checkResult.length > 0) {
      console.log('ℹ️  Progress column already exists, migration not needed.');
      return;
    }
    
    // Add progress column
    await query('ALTER TABLE pst_exports ADD COLUMN progress INT DEFAULT 0 AFTER status');
    
    console.log('✅ Migration completed successfully!');
    console.log('Added progress column (INT, default 0) to pst_exports table.');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
  } finally {
    // Close connection
    await closeDB();
    process.exit(0);
  }
}
migrate();
