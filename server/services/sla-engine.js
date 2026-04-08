const { pool } = require('../config/database');

const checkSLAs = async (io) => {
  try {
    const breaches = await pool.query(
      "SELECT * FROM conversations WHERE sla_deadline IS NOT NULL AND sla_deadline < NOW() AND status != 'closed' AND sla_breached = false"
    );
    for (const conv of breaches.rows) {
      await pool.query('UPDATE conversations SET sla_breached=true WHERE id=$1', [conv.id]);
      if (io) io.emit('sla:breach', conv);
    }
  } catch (err) { console.error('SLA check error:', err); }
};

module.exports = { checkSLAs };
