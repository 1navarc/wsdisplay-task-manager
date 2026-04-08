// Quick script to trigger Gmail sync directly
const { Pool } = require('pg');
const { syncAllMailboxes } = require('./server/services/gmail-sync');

const pool = new Pool({
  host: '127.0.0.1',
  port: 9470,
  database: 'wsdisplay_email',
  user: 'postgres',
  password: 'WSDisplay2026Secure!'
});

async function run() {
  try {
    // Check mailboxes
    const mbs = await pool.query('SELECT * FROM mailboxes');
    console.log('Mailboxes:', JSON.stringify(mbs.rows, null, 2));
    
    // Run sync
    console.log('Starting Gmail sync...');
    const result = await syncAllMailboxes(pool);
    console.log('Sync result:', result);
    
    // Check conversations
    const convs = await pool.query('SELECT count(*) FROM conversations');
    console.log('Conversations after sync:', convs.rows[0].count);
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
}
run();
