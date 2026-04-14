/**
 * Daily Email Report
 *
 * Runs a short email-metrics analysis for the previous 24h and emails a
 * formatted HTML summary to a list of recipients. Driven by node-cron and a
 * configurable schedule stored in app_settings.
 *
 * The report reuses email-metrics.js for all aggregation, so any filter
 * changes (SLA threshold, excluded domains, etc.) apply to the daily report
 * too.
 */

const cron = require('node-cron');
const { pool } = require('../config/database');
const emailMetrics = require('./email-metrics');
const { sendGmailReply } = require('./gmail-sync');

const DEFAULT_REPORT_CONFIG = {
  enabled: false,
  recipients: [],                 // ["manager@sdsign.com", ...]
  send_from_mailbox: 'info@sdsign.com', // Gmail account used as From:
  send_time: '08:00',             // HH:MM in server local time
  timezone: 'America/Los_Angeles',
  include_rep_leaderboard: true,
  include_categories: true,
  include_flags: true,
  top_n_categories: 8,
  period_hours: 24,               // window the report covers
};

async function getReportConfig() {
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'daily_email_report_config'`
    );
    if (!r.rows.length) return { ...DEFAULT_REPORT_CONFIG };
    return { ...DEFAULT_REPORT_CONFIG, ...(r.rows[0].value || {}) };
  } catch {
    return { ...DEFAULT_REPORT_CONFIG };
  }
}

async function saveReportConfig(patch) {
  const current = await getReportConfig();
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    ['daily_email_report_config', JSON.stringify(next)]
  );
  // Rebuild the cron schedule whenever the time or enabled flag changes
  rescheduleDaily();
  return next;
}

// ---------- Formatting helpers ----------

function msToHuman(ms) {
  if (!ms || ms <= 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEmailHtml({ run, repStats, categoryStats, summary, flags, reportConfig, periodHours }) {
  const dateStr = new Date().toLocaleString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: reportConfig.timezone,
  });

  const kpi = (label, value, sub) => `
    <td style="padding:12px 16px;background:#f8fafc;border-radius:8px;text-align:center;min-width:120px;">
      <div style="font-size:22px;font-weight:700;color:#0f172a;">${esc(value)}</div>
      <div style="font-size:11px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
      ${sub ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${esc(sub)}</div>` : ''}
    </td>`;

  const repRows = (repStats || []).slice(0, 10).map(r => `
    <tr>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;color:#0f172a;">${esc(r.rep_email || '—')}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;">${r.threads_first_responder}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;color:${r.first_response_ms_avg && r.first_response_ms_avg > (reportConfig.sla_ms || 14400000) ? '#b91c1c' : '#0f172a'};">${msToHuman(r.first_response_ms_avg)}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;">${msToHuman(r.first_response_ms_median)}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;">${msToHuman(r.ongoing_response_ms_avg)}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;color:#64748b;">${r.ongoing_reply_count}</td>
    </tr>`).join('');

  const topN = reportConfig.top_n_categories || 8;
  const catRows = (categoryStats || []).slice(0, topN).map(c => `
    <tr>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;color:#0f172a;">${esc((c.category || '').replace(/_/g, ' '))}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;font-weight:600;color:#0f172a;">${c.unique_customer_count}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;color:#64748b;">${c.thread_count}</td>
      <td style="padding:8px 10px;border-top:1px solid #f1f5f9;font-size:13px;text-align:right;color:${c.negative_count > 0 ? '#b91c1c' : '#94a3b8'};">${c.negative_count}</td>
    </tr>`).join('');

  const flagRows = (flags || []).slice(0, 15).map(f => {
    const sevColor = f.severity === 'high' ? '#b91c1c' : f.severity === 'medium' ? '#b45309' : '#64748b';
    const sevBg   = f.severity === 'high' ? '#fee2e2' : f.severity === 'medium' ? '#fef3c7' : '#f1f5f9';
    const typeLabel = (f.flag_type || '').replace(/_/g, ' ');
    return `
      <tr>
        <td style="padding:10px;border-top:1px solid #f1f5f9;vertical-align:top;">
          <div style="display:inline-block;padding:2px 8px;background:${sevBg};color:${sevColor};font-size:11px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">${esc(typeLabel)}</div>
        </td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;vertical-align:top;font-size:13px;color:#0f172a;">
          <div style="font-weight:600;">${esc(f.thread_subject || f.reason || '(no subject)')}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(f.reason || '')}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
            ${f.customer_email ? 'Customer: ' + esc(f.customer_email) : ''}
            ${f.rep_email ? ' &middot; Rep: ' + esc(f.rep_email) : ''}
          </div>
        </td>
      </tr>`;
  }).join('');

  return `
<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;">
    <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Daily Email Report</div>
    <div style="font-size:22px;font-weight:700;color:#0f172a;margin-top:4px;">${esc(dateStr)}</div>
    <div style="font-size:13px;color:#64748b;margin-top:4px;">Mailbox: ${esc(run.mailbox_email)} &middot; Last ${periodHours}h</div>

    <table style="width:100%;border-collapse:separate;border-spacing:8px;margin-top:20px;">
      <tr>
        ${kpi('Threads', summary.total_threads || 0)}
        ${kpi('Answered', summary.answered_threads || 0)}
        ${kpi('Unanswered', summary.unanswered_threads || 0, (summary.unanswered_threads > 0 ? 'needs follow-up' : ''))}
        ${kpi('SLA breach', summary.sla_breach_count || 0, `> ${summary.sla_hours || 4}h`)}
        ${kpi('Angry', summary.negative_sentiment_count || 0)}
      </tr>
      <tr>
        ${kpi('First-response avg', msToHuman(summary.overall_first_response_avg_ms))}
        ${kpi('First-response median', msToHuman(summary.overall_first_response_median_ms))}
        ${kpi('90th pct', msToHuman(summary.overall_first_response_p90_ms))}
      </tr>
    </table>

    ${reportConfig.include_rep_leaderboard ? `
    <h3 style="margin:28px 0 8px;font-size:15px;color:#0f172a;">Rep Leaderboard</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Rep</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Threads</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">First avg</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">First median</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Ongoing avg</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Replies</th>
        </tr>
      </thead>
      <tbody>${repRows || '<tr><td colspan="6" style="padding:14px;color:#94a3b8;font-size:13px;">No reps responded in this window.</td></tr>'}</tbody>
    </table>
    ` : ''}

    ${reportConfig.include_categories ? `
    <h3 style="margin:28px 0 4px;font-size:15px;color:#0f172a;">What customers asked about</h3>
    <div style="font-size:12px;color:#64748b;margin-bottom:8px;">Counted by unique customer — one customer asking five times counts once.</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Topic</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Customers</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Threads</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Angry</th>
        </tr>
      </thead>
      <tbody>${catRows || '<tr><td colspan="4" style="padding:14px;color:#94a3b8;font-size:13px;">No categorized threads.</td></tr>'}</tbody>
    </table>
    ` : ''}

    ${reportConfig.include_flags ? `
    <h3 style="margin:28px 0 8px;font-size:15px;color:#0f172a;">Needs management attention</h3>
    ${flagRows ? `<table style="width:100%;border-collapse:collapse;">${flagRows}</table>` : '<div style="padding:14px;color:#94a3b8;font-size:13px;">Nothing flagged in this window.</div>'}
    ` : ''}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center;">
      Generated by wsmail.ws &middot; Adjust filters in AI Settings
    </div>
  </div>
</body>
</html>`;
}

// ---------- Runner ----------

/**
 * Run a metrics analysis for the last N hours and email the report.
 * Called by the cron scheduler and by the "Send Test" button.
 */
async function sendDailyReport({ dryRun = false } = {}) {
  const cfg = await getReportConfig();
  if (!cfg.enabled && !dryRun) {
    return { skipped: true, reason: 'reports disabled' };
  }
  if (!cfg.recipients || !cfg.recipients.length) {
    throw new Error('No recipients configured for daily report');
  }

  const periodHours = cfg.period_hours || 24;
  const filterOverrides = {
    date_from: new Date(Date.now() - periodHours * 3600 * 1000).toISOString(),
    date_to: new Date().toISOString(),
  };

  // Start a run and wait for it to complete
  const runId = await emailMetrics.startRun({
    startedByUserId: null,
    filterOverrides,
  });

  // Poll for completion (runs are short — a day's worth of threads)
  const maxWaitMs = 10 * 60 * 1000; // 10 min ceiling
  const start = Date.now();
  let run;
  while (Date.now() - start < maxWaitMs) {
    run = await emailMetrics.getRunStatus(runId);
    if (run && (run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled')) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!run || run.status !== 'complete') {
    throw new Error(`Metrics run did not complete in time (status=${run && run.status})`);
  }

  // Fetch flags (already summarized counts live on the run row)
  const flags = await emailMetrics.getRunFlags(runId, { limit: 50 });

  const html = renderEmailHtml({
    run,
    repStats: run.rep_stats || [],
    categoryStats: run.category_stats || [],
    summary: run.summary || {},
    flags,
    reportConfig: cfg,
    periodHours,
  });

  const subject = `[wsmail] Daily report — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: cfg.timezone })}`;

  const sent = [];
  const errors = [];
  for (const to of cfg.recipients) {
    try {
      await sendGmailReply(pool, cfg.send_from_mailbox, to, subject, html, null);
      sent.push(to);
    } catch (err) {
      console.error(`Daily report send to ${to} failed:`, err.message);
      errors.push({ to, error: err.message });
    }
  }

  // Log to app_settings so UI can show "last sent at"
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    ['daily_email_report_last', JSON.stringify({
      sent_at: new Date().toISOString(),
      run_id: runId,
      sent_to: sent,
      errors,
      period_hours: periodHours,
    })]
  );

  return { run_id: runId, sent, errors, subject };
}

// ---------- Cron scheduling ----------

let cronTask = null;

function toCronExpr(hhmm) {
  const [h, m] = (hhmm || '08:00').split(':').map(s => parseInt(s, 10));
  const safeH = isNaN(h) ? 8 : h;
  const safeM = isNaN(m) ? 0 : m;
  return `${safeM} ${safeH} * * *`;
}

async function rescheduleDaily() {
  const cfg = await getReportConfig();
  if (cronTask) {
    try { cronTask.stop(); } catch { /* ignore */ }
    cronTask = null;
  }
  if (!cfg.enabled) {
    console.log('Daily email report: disabled');
    return;
  }
  const expr = toCronExpr(cfg.send_time);
  try {
    cronTask = cron.schedule(expr, async () => {
      try {
        console.log('Daily email report: firing…');
        const r = await sendDailyReport({ dryRun: false });
        console.log('Daily email report: sent to', r.sent, 'errors:', r.errors);
      } catch (err) {
        console.error('Daily email report failed:', err.message);
      }
    }, { timezone: cfg.timezone || 'America/Los_Angeles' });
    console.log(`Daily email report: scheduled at ${cfg.send_time} ${cfg.timezone}`);
  } catch (err) {
    console.error('Daily email report: failed to schedule:', err.message);
  }
}

function initDailyReportScheduler() {
  // Wait a tick so app_settings is guaranteed to exist
  setTimeout(() => {
    rescheduleDaily().catch(err => console.error('rescheduleDaily:', err.message));
  }, 5000);
}

module.exports = {
  DEFAULT_REPORT_CONFIG,
  getReportConfig,
  saveReportConfig,
  sendDailyReport,
  rescheduleDaily,
  initDailyReportScheduler,
};
