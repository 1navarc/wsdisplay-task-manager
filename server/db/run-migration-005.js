const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'migrations', '005_manager_tables.sql'),
    'utf8'
  );
  try {
    await pool.query(sql);
    console.log('Migration 005_manager_tables.sql completed successfully');
  } catch (err) {
    console.error('Migration error:', err.message);
    // Don't exit with error - tables might already exist
  }
  await pool.end();
}

runMigration();
