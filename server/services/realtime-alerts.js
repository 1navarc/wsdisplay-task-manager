/**
 * Real-time Alerts
 *
 * When an email-metrics run produces flags of sufficient severity, email
 * the configured alert recipients immediately. Recipients come from two places:
 *   1. rep_roster rows where receives_alerts = true
 *   2. extra_recipients list in realtime_alerts_config
 *
 * A cooldown per (flag_type, gmail_thread_id) prevents the same issue from
 * paging multiple times if a run is re-kicked or the cron double-fires.
 */

const { pool } = require('../config/database');
const { sendGmailReply } = require('./gmail-sync');
const repRoster = require('./rep-roster');

const DEFAULT_ALERT_CONFIG = {
  enabled: false,
  severities: ['high'],
  flag_types: ['slow_first_response', 'unanswered', 'negative_sentiment', 'repeat_problem'],
  extra_recipients: [],
  send_from_mailbox: 'info@sdsign.com',
  cooldown_minutes: 30,
  use_rep_roster_alert_list: true,
};

async function getAlertConfig() {
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'realtime_alerts_config'`
    );
    if (!r.rows.length) return { ...DEFAULT_ALERT_CONFIG };
    return { ...DEFAULT_ALERT_CONFIG, ...(r.rows[0].value || {}) };
  } catch {
    return { ...DEFAULT_ALERT_CONFIG };
  }
}

async function saveAlertConfig(patch) {
  const current = await getAlertConfig();
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    ['realtime_alerts_config', JSON.stringify(next)]
  );
  return next;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFlagEmail(flag, run) {
  const sev = flag.severity || 'medium';
  const sevColor = sev === 'high' ? '#b91c1c' : '#b45309';
  const sevBg = sev === 'high' ? '#fee2e2' : '#fef3c7';
  return `
<!doctype html>
<html><body style="margin:0;padding:20px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e2e8f0;">
    <div style="display:inline-block;padding:4px 10px;background:${sevBg};color:${sevColor};font-size:11px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;font-weight:700;">${esc(sev)} · ${esc((flag.flag_type || '').replace(/_/g, ' '))}</div>
    <h2 style="margin:12px 0 8px;font-size:18px;color:#0f172a;">${esc(flag.thread_subject || flag.reason || '(no subject)')}</h2>
    <div style="font-size:13px;color:#334155;margin-bottom:12px;">${esc(flag.reason || '')}</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#475569;">
      ${flag.customer_email ? `<tr><td style="padding:4px 0;color:#94a3b8;width:110px;">Customer</td><td style="padding:4px 0;">${esc(flag.customer_email)}</td></tr>` : ''}
      ${flag.rep_email ? `<tr><td style="padding:4px 0;color:#94a3b8;">Rep</td><td style="padding:4px 0;">${esc(flag.rep_email)}</td></tr>` : ''}
      ${flag.thread_date ? `<tr><td style="padding:4px 0;color:#94a3b8;">Thread date</td><td style="padding:4px 0;">${esc(new Date(flag.thread_date).toLocaleString())}</td></tr>` : ''}
      ${flag.gmail_thread_id ? `<tr><td style="padding:4px 0;color:#94a3b8;">Gmail thread</td><td style="padding:4px 0;font-family:monospace;font-size:11px;">${esc(flag.gmail_thread_id)}</td></tr>` : ''}
      <tr><td style="padding:4px 0;color:#94a3b8;">Mailbox</td><td style="padding:4px 0;">${esc(run.mailbox_email || '')}</td></tr>
    </table>
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
      Real-time alert from wsmail.ws · Disable in AI Settings → Real-time Alerts
    </div>
  </div>
</body></html>`;
}

/**
 * Check a flag against the cooldown window. Returns true if we should send.
 */
async function shouldAlert(flag, cooldownMinutes) {
  if (!cooldownMinutes || cooldownMinutes <= 0) return true;
  const threadId = flag.gmail_thread_id || flag.details?.category || '(none)';
  const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  const r = await pool.query(
    `SELECT 1 FROM metrics_alert_log
      WHERE flag_type = $1
        AND (gmail_thread_id = $2 OR ($2 IS NULL AND gmail_thread_id IS NULL))
        AND sent_at > $3
        AND send_error IS NULL
      LIMIT 1`,
    [flag.flag_type, flag.gmail_thread_id || null, cutoff]
  );
  return r.rows.length === 0;
}

async function resolveRecipients(cfg) {
  const list = new Set();
  if (cfg.use_rep_roster_alert_list) {
    const roster = await repRoster.getAlertRecipients();
    for (const r of roster) list.add((r.email || '').toLowerCase());
  }
  for (const e of cfg.extra_recipients || []) {
    const v = (e || '').trim().toLowerCase();
    if (v) list.add(v);
  }
  return [...list];
}

/**
 * Fire alerts for a completed run. Called by email-metrics at end of processRun.
 */
async function fireAlertsForRun(runId) {
  const cfg = await getAlertConfig();
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

  const recipients = await resolveRecipients(cfg);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };

  const runRow = await pool.query(`SELECT * FROM email_metrics_runs WHERE id = $1`, [runId]);
  if (!runRow.rows.length) return { skipped: true, reason: 'run not found' };
  const run = runRow.rows[0];

  const severities = cfg.severities || ['high'];
  const flagTypes = cfg.flag_types || [];
  const flagsRes = await pool.query(
    `SELECT * FROM email_metrics_flags
      WHERE run_id = $1
        AND severity = ANY($2::text[])
        AND (array_length($3::text[], 1) IS NULL OR flag_type = ANY($3::text[]))
      ORDER BY created_at DESC`,
    [runId, severities, flagTypes]
  );

  const sent = [], skipped = [], errors = [];
  for (const flag of flagsRes.rows) {
    try {
      if (!(await shouldAlert(flag, cfg.cooldown_minutes))) {
        skipped.push({ flag_id: flag.id, reason: 'cooldown' });
        continue;
      }
      const subject = `[wsmail ALERT · ${flag.severity}] ${(flag.flag_type || '').replace(/_/g, ' ')} — ${(flag.thread_subject || flag.reason || '').slice(0, 80)}`;
      const html = renderFlagEmail(flag, run);
      const perRecipientErrors = [];
      for (const to of recipients) {
        try {
          await sendGmailReply(pool, cfg.send_from_mailbox, to, subject, html, null);
        } catch (e) {
          perRecipientErrors.push({ to, error: e.message });
        }
      }
      await pool.query(
        `INSERT INTO metrics_alert_log (run_id, flag_id, flag_type, severity, gmail_thread_id, subject, recipients, send_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          runId, flag.id, flag.flag_type, flag.severity,
          flag.gmail_thread_id || null, subject,
          recipients,
          perRecipientErrors.length ? JSON.stringify(perRecipientErrors) : null,
        ]
      );
      sent.push(flag.id);
    } catch (err) {
      errors.push({ flag_id: flag.id, error: err.message });
    }
  }
  return { sent, skipped, errors, recipients };
}

async function listRecentAlerts(limit = 50) {
  const r = await pool.query(
    `SELECT * FROM metrics_alert_log ORDER BY sent_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

module.exports = {
  DEFAULT_ALERT_CONFIG,
  getAlertConfig,
  saveAlertConfig,
  fireAlertsForRun,
  listRecentAlerts,
};
