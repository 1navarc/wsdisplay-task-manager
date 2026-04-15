/**
 * Rep Roster Service
 *
 * Maps raw email addresses (anna@sdsign.com) to display names ("Anna B."),
 * per-rep SLA overrides, and an opt-in flag for receiving real-time alerts.
 *
 * Used by:
 *   - email-metrics.js  (decorate rep_stats with display names)
 *   - daily-report.js   (render names instead of emails)
 *   - realtime-alerts.js (find who to ping on high-severity flags)
 */

const { pool } = require('../config/database');

async function list({ activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE is_active = true' : '';
  const r = await pool.query(
    `SELECT id, email, display_name, role, is_active, sla_hours_override,
            receives_alerts, notes, created_at, updated_at
       FROM rep_roster ${where}
       ORDER BY display_name ASC`
  );
  return r.rows;
}

async function getByEmail(email) {
  if (!email) return null;
  const r = await pool.query(
    `SELECT * FROM rep_roster WHERE lower(email) = lower($1)`,
    [email]
  );
  return r.rows[0] || null;
}

async function upsert(rep) {
  const email = (rep.email || '').trim().toLowerCase();
  if (!email) throw new Error('email required');
  const display_name = (rep.display_name || '').trim() || email;
  const role = rep.role || 'rep';
  const is_active = rep.is_active !== false;
  const sla = rep.sla_hours_override == null || rep.sla_hours_override === '' ? null : Number(rep.sla_hours_override);
  const receives_alerts = !!rep.receives_alerts;
  const notes = rep.notes || null;

  const r = await pool.query(
    `INSERT INTO rep_roster (email, display_name, role, is_active, sla_hours_override, receives_alerts, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (email) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        is_active = EXCLUDED.is_active,
        sla_hours_override = EXCLUDED.sla_hours_override,
        receives_alerts = EXCLUDED.receives_alerts,
        notes = EXCLUDED.notes,
        updated_at = NOW()
     RETURNING *`,
    [email, display_name, role, is_active, sla, receives_alerts, notes]
  );
  return r.rows[0];
}

async function deleteById(id) {
  await pool.query(`DELETE FROM rep_roster WHERE id = $1`, [id]);
}

async function getDisplayNameMap() {
  const r = await pool.query(`SELECT lower(email) AS email, display_name FROM rep_roster WHERE is_active = true`);
  const map = {};
  for (const row of r.rows) map[row.email] = row.display_name;
  return map;
}

async function getAlertRecipients() {
  const r = await pool.query(
    `SELECT email, display_name FROM rep_roster
      WHERE is_active = true AND receives_alerts = true`
  );
  return r.rows;
}

/**
 * Decorate a rep_stats array (from email-metrics) with display_name fields.
 * Non-destructive: copies each row and adds display_name.
 */
async function decorateRepStats(repStats) {
  if (!Array.isArray(repStats) || !repStats.length) return repStats || [];
  const map = await getDisplayNameMap();
  return repStats.map(r => ({
    ...r,
    display_name: map[(r.rep_email || '').toLowerCase()] || r.rep_email,
  }));
}

module.exports = {
  list,
  getByEmail,
  upsert,
  deleteById,
  getDisplayNameMap,
  getAlertRecipients,
  decorateRepStats,
};
