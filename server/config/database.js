const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || '/cloudsql/' + process.env.CLOUD_SQL_CONNECTION_NAME,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'wsdisplay_email',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20
});
pool.on('error', (err) => console.error('Database pool error:', err));

const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

module.exports = { pool, transaction };
