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

// Small helpers used only by the template.
function formatPctDelta(now, prev, goodIsDown) {
  if (prev == null || prev === 0 || now == null) return '';
  const diff = now - prev;
  const pct = Math.round((diff / prev) * 100);
  if (pct === 0) return `<span style="font-size:11px;color:#94a3b8;margin-left:6px;">→ 0%</span>`;
  // goodIsDown === true means: "down is good" (response times, breaches)
  // goodIsDown === false means: "up is good" (threads answered)
  const isGood = goodIsDown ? diff < 0 : diff > 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const color = isGood ? '#059669' : '#b91c1c';
  return `<span style="font-size:11px;color:${color};margin-left:6px;font-weight:600;">${arrow} ${Math.abs(pct)}%</span>`;
}

function renderBar(pct, color, widthPx) {
  const w = widthPx || 240;
  return `
    <div style="background:#f1f5f9;border-radius:6px;height:10px;width:${w}px;max-width:100%;overflow:hidden;">
      <div style="background:${color};height:10px;width:${Math.max(0, Math.min(100, pct))}%;"></div>
    </div>`;
}

function renderEmailHtml({ run, repStats, categoryStats, summary, flags, reportConfig, periodHours }) {
  const dateStr = new Date().toLocaleString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: reportConfig.timezone,
  });

  const prev = summary.previous_period || null;
  const kpi = (label, value, sub, delta) => `
    <td style="padding:14px 14px;background:#f8fafc;border-radius:10px;text-align:center;min-width:110px;border:1px solid #e2e8f0;">
      <div style="font-size:24px;font-weight:700;color:#0f172a;line-height:1;">${esc(value)}${delta || ''}</div>
      <div style="font-size:11px;color:#64748b;margin-top:6px;text-transform:uppercase;letter-spacing:.05em;">${esc(label)}</div>
      ${sub ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${esc(sub)}</div>` : ''}
    </td>`;

  // Rep leaderboard with CSS bars: bar width scaled against the fastest rep.
  const repsForBar = (repStats || []).slice(0, 10);
  const fastest = repsForBar
    .map(r => r.first_response_ms_avg)
    .filter(x => x != null && x > 0);
  const minMs = fastest.length ? Math.min(...fastest) : 0;
  const maxMs = fastest.length ? Math.max(...fastest) : 1;
  const slaMs = (summary.sla_hours || 4) * 3600 * 1000;

  const repRows = repsForBar.map(r => {
    const avgMs = r.first_response_ms_avg;
    // Relative bar: 100% = slowest avg. Empty for reps with no first responses.
    const pct = avgMs != null && maxMs > 0 ? Math.round((avgMs / maxMs) * 100) : 0;
    const overSla = avgMs != null && avgMs > slaMs;
    const color = overSla ? '#b91c1c' : avgMs != null && avgMs === minMs ? '#059669' : '#2563eb';
    return `
    <tr>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:13px;color:#0f172a;vertical-align:top;">
        <div style="font-weight:600;">${esc(r.display_name || r.rep_email || '—')}</div>
        ${r.display_name && r.display_name !== r.rep_email ? `<div style="font-size:11px;color:#94a3b8;">${esc(r.rep_email)}</div>` : ''}
      </td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:12px;color:#64748b;text-align:right;white-space:nowrap;">${r.threads_first_responder}</td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;vertical-align:middle;">
        ${avgMs != null ? renderBar(pct, color, 240) : '<span style="color:#cbd5e1;font-size:11px;">—</span>'}
      </td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:13px;color:${overSla ? '#b91c1c' : '#0f172a'};text-align:right;white-space:nowrap;font-weight:600;">${msToHuman(avgMs)}</td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:12px;color:#64748b;text-align:right;white-space:nowrap;">${msToHuman(r.ongoing_response_ms_avg)}</td>
    </tr>`;
  }).join('');

  // Categories with CSS bar (proportional to max unique_customer_count).
  const topN = reportConfig.top_n_categories || 8;
  const cats = (categoryStats || []).slice(0, topN);
  const maxCustCount = cats.reduce((m, c) => Math.max(m, c.unique_customer_count || 0), 0) || 1;
  const catRows = cats.map(c => {
    const pct = Math.round(((c.unique_customer_count || 0) / maxCustCount) * 100);
    return `
    <tr>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:13px;color:#0f172a;vertical-align:middle;">${esc((c.category || '').replace(/_/g, ' '))}</td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;vertical-align:middle;">
        ${renderBar(pct, c.negative_count > 0 ? '#ea580c' : '#7c3aed', 220)}
      </td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#0f172a;text-align:right;white-space:nowrap;">${c.unique_customer_count}</td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:12px;color:#64748b;text-align:right;white-space:nowrap;">${c.thread_count}</td>
      <td style="padding:10px;border-top:1px solid #f1f5f9;font-size:12px;color:${c.negative_count > 0 ? '#b91c1c' : '#cbd5e1'};text-align:right;white-space:nowrap;">${c.negative_count}</td>
    </tr>`;
  }).join('');

  // Response-time distribution (histogram)
  const dist = summary.response_distribution;
  const distRows = dist && dist.buckets ? dist.buckets.map(b => {
    // Color ramp from green (fast) to red (slow)
    const colors = { lt_15m: '#059669', lt_1h: '#16a34a', lt_4h: '#ca8a04', lt_24h: '#ea580c', gt_24h: '#b91c1c' };
    return `
    <tr>
      <td style="padding:6px 10px;font-size:12px;color:#0f172a;white-space:nowrap;width:70px;">${esc(b.label)}</td>
      <td style="padding:6px 10px;vertical-align:middle;">${renderBar(b.pct, colors[b.key] || '#2563eb', 300)}</td>
      <td style="padding:6px 10px;font-size:12px;color:#0f172a;text-align:right;white-space:nowrap;font-weight:600;">${b.count}</td>
      <td style="padding:6px 10px;font-size:11px;color:#94a3b8;text-align:right;white-space:nowrap;">${b.pct}%</td>
    </tr>`;
  }).join('') : '';

  // Busy hours heatmap (bars for each hour 0-23)
  const busy = summary.busy_hours;
  let busySection = '';
  if (busy && busy.hours) {
    const peak = busy.peak_count || 1;
    const bhStart = busy.business_hours_start || 9;
    const bhEnd = busy.business_hours_end || 17;
    const hourRows = busy.hours.map(h => {
      const pct = Math.round((h.count / peak) * 100);
      const inBiz = h.hour >= bhStart && h.hour < bhEnd;
      const color = inBiz ? '#2563eb' : '#94a3b8';
      const hourLabel = h.hour === 0 ? '12a' : h.hour < 12 ? `${h.hour}a` : h.hour === 12 ? '12p' : `${h.hour - 12}p`;
      return `
      <tr>
        <td style="padding:3px 10px;font-size:11px;color:${inBiz ? '#0f172a' : '#94a3b8'};white-space:nowrap;width:50px;text-align:right;">${hourLabel}</td>
        <td style="padding:3px 10px;vertical-align:middle;">${renderBar(pct, color, 300)}</td>
        <td style="padding:3px 10px;font-size:11px;color:#64748b;text-align:right;white-space:nowrap;width:40px;">${h.count || ''}</td>
      </tr>`;
    }).join('');
    const peakHourLabel = busy.peak_hour == null ? '—' : busy.peak_hour === 0 ? '12 AM' : busy.peak_hour < 12 ? `${busy.peak_hour} AM` : busy.peak_hour === 12 ? '12 PM' : `${busy.peak_hour - 12} PM`;
    busySection = `
      <h3 style="margin:28px 0 4px;font-size:15px;color:#0f172a;">When customers email</h3>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px;">Local time (${esc(busy.timezone)}). Blue = business hours (${bhStart}:00–${bhEnd}:00), gray = after-hours.</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">${hourRows}</table>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:#475569;padding:10px;background:#f8fafc;border-radius:8px;">
        <div><b style="color:#0f172a;">Peak hour:</b> ${peakHourLabel} (${busy.peak_count} msgs)</div>
        <div><b style="color:${busy.after_hours_count > 0 ? '#b91c1c' : '#0f172a'};">After-hours:</b> ${busy.after_hours_count} / ${busy.total} (${busy.total ? Math.round((busy.after_hours_count / busy.total) * 100) : 0}%)</div>
        ${busy.weekend_count > 0 ? `<div><b style="color:#0f172a;">Weekend:</b> ${busy.weekend_count}</div>` : ''}
      </div>`;
  }

  // Distribution section
  let distSection = '';
  if (dist && dist.total_responded > 0) {
    distSection = `
      <h3 style="margin:28px 0 4px;font-size:15px;color:#0f172a;">How fast we respond</h3>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px;">First-response time distribution across ${dist.total_responded} answered threads.</div>
      <table style="width:100%;border-collapse:collapse;">${distRows}</table>`;
  }

  const flagRows = (flags || []).slice(0, 15).map(f => {
    const sevColor = f.severity === 'high' ? '#b91c1c' : f.severity === 'medium' ? '#b45309' : '#64748b';
    const sevBg   = f.severity === 'high' ? '#fee2e2' : f.severity === 'medium' ? '#fef3c7' : '#f1f5f9';
    const typeLabel = (f.flag_type || '').replace(/_/g, ' ');
    return `
      <tr>
        <td style="padding:10px;border-top:1px solid #f1f5f9;vertical-align:top;width:120px;">
          <div style="display:inline-block;padding:3px 8px;background:${sevBg};color:${sevColor};font-size:10px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">${esc(typeLabel)}</div>
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

  // KPI row with deltas
  const deltaThreads = prev ? formatPctDelta(summary.total_threads, prev.total_threads, false) : '';
  const deltaUnans   = prev ? formatPctDelta(summary.unanswered_threads, prev.unanswered_threads, true) : '';
  const deltaSla     = prev ? formatPctDelta(summary.sla_breach_count, prev.sla_breach_count, true) : '';
  const deltaNeg     = prev ? formatPctDelta(summary.negative_sentiment_count, prev.negative_sentiment_count, true) : '';
  const deltaAvg     = prev ? formatPctDelta(summary.overall_first_response_avg_ms, prev.overall_first_response_avg_ms, true) : '';
  const deltaMed     = prev ? formatPctDelta(summary.overall_first_response_median_ms, prev.overall_first_response_median_ms, true) : '';

  return `
<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap;">
      <div>
        <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Email Performance Report</div>
        <div style="font-size:24px;font-weight:700;color:#0f172a;margin-top:4px;">${esc(dateStr)}</div>
        <div style="font-size:13px;color:#64748b;margin-top:4px;">Mailbox: ${esc(run.mailbox_email)} &middot; Last ${periodHours}h${prev ? ` &middot; vs ${new Date(prev.started_at).toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone: reportConfig.timezone })}` : ''}</div>
      </div>
      ${summary.sla_compliance_pct != null ? `
      <div style="padding:14px 16px;border-radius:10px;background:${summary.sla_compliance_pct >= 90 ? '#dcfce7' : summary.sla_compliance_pct >= 70 ? '#fef3c7' : '#fee2e2'};text-align:center;min-width:120px;">
        <div style="font-size:28px;font-weight:700;color:${summary.sla_compliance_pct >= 90 ? '#065f46' : summary.sla_compliance_pct >= 70 ? '#92400e' : '#991b1b'};line-height:1;">${summary.sla_compliance_pct}%</div>
        <div style="font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.04em;">SLA compliance</div>
        <div style="font-size:11px;color:#94a3b8;">≤ ${summary.sla_hours || 4}h</div>
      </div>` : ''}
    </div>

    <!-- Command Center CTA -->
    <div style="margin-top:20px;padding:16px 18px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
      <div>
        <div style="color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Take action</div>
        <div style="color:#fff;font-size:15px;font-weight:600;margin-top:4px;">Open the Command Center</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:2px;">Drill into SLA breaches, unanswered threads, coach reps & set alerts.</div>
      </div>
      <a href="https://wsmail.ws/?tab=commandcenter" style="display:inline-block;padding:11px 20px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;">Command Center →</a>
    </div>

    <table style="width:100%;border-collapse:separate;border-spacing:8px;margin-top:20px;">
      <tr>
        ${kpi('Threads', summary.total_threads || 0, null, deltaThreads)}
        ${kpi('Answered', summary.answered_threads || 0)}
        ${kpi('Unanswered', summary.unanswered_threads || 0, (summary.unanswered_threads > 0 ? 'needs follow-up' : ''), deltaUnans)}
        ${kpi('SLA breach', summary.sla_breach_count || 0, `> ${summary.sla_hours || 4}h`, deltaSla)}
        ${kpi('Angry', summary.negative_sentiment_count || 0, null, deltaNeg)}
      </tr>
      <tr>
        ${kpi('First-response avg', msToHuman(summary.overall_first_response_avg_ms), null, deltaAvg)}
        ${kpi('First-response median', msToHuman(summary.overall_first_response_median_ms), null, deltaMed)}
        ${kpi('90th pct', msToHuman(summary.overall_first_response_p90_ms))}
      </tr>
    </table>

    ${distSection}

    ${reportConfig.include_rep_leaderboard ? `
    <h3 style="margin:28px 0 4px;font-size:15px;color:#0f172a;">Rep Leaderboard</h3>
    <div style="font-size:12px;color:#64748b;margin-bottom:8px;">Bar width = first-response avg, relative to slowest. Green = fastest, red = over SLA.</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Rep</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Threads</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">First-response</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Avg</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Ongoing avg</th>
        </tr>
      </thead>
      <tbody>${repRows || '<tr><td colspan="5" style="padding:14px;color:#94a3b8;font-size:13px;">No reps responded in this window.</td></tr>'}</tbody>
    </table>
    ` : ''}

    ${reportConfig.include_categories ? `
    <h3 style="margin:28px 0 4px;font-size:15px;color:#0f172a;">What customers asked about</h3>
    <div style="font-size:12px;color:#64748b;margin-bottom:8px;">Counted by unique customer — bar = customers, orange if anyone was upset.</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Topic</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;"></th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Customers</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Threads</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Angry</th>
        </tr>
      </thead>
      <tbody>${catRows || '<tr><td colspan="5" style="padding:14px;color:#94a3b8;font-size:13px;">No categorized threads.</td></tr>'}</tbody>
    </table>
    ` : ''}

    ${busySection}

    ${reportConfig.include_flags ? `
    <h3 style="margin:28px 0 8px;font-size:15px;color:#0f172a;">Needs management attention</h3>
    ${flagRows ? `<table style="width:100%;border-collapse:collapse;">${flagRows}</table>` : '<div style="padding:14px;color:#94a3b8;font-size:13px;">Nothing flagged in this window.</div>'}
    ` : ''}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center;">
      Generated by wsmail.ws &middot; <a href="https://wsmail.ws" style="color:#64748b;text-decoration:none;">Open dashboard</a>
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
    reschedulePeriodic('weekly').catch(err => console.error('rescheduleWeekly:', err.message));
    reschedulePeriodic('monthly').catch(err => console.error('rescheduleMonthly:', err.message));
  }, 5000);
}

// ---------- Weekly + Monthly digests ----------
//
// Same template as the daily report, but a longer period_hours window and a
// different cron expression. Config keys: weekly_report_config, monthly_report_config.

const PERIODIC_DEFAULTS = {
  weekly: {
    enabled: false,
    recipients: [],
    send_from_mailbox: 'info@sdsign.com',
    send_time: '08:00',
    timezone: 'America/Los_Angeles',
    day_of_week: 1,      // 0=Sun … 6=Sat (node-cron)
    period_hours: 168,   // 7 days
    include_rep_leaderboard: true,
    include_categories: true,
    include_flags: true,
    top_n_categories: 10,
  },
  monthly: {
    enabled: false,
    recipients: [],
    send_from_mailbox: 'info@sdsign.com',
    send_time: '08:00',
    timezone: 'America/Los_Angeles',
    day_of_month: 1,     // 1-28
    period_hours: 720,   // 30 days
    include_rep_leaderboard: true,
    include_categories: true,
    include_flags: true,
    top_n_categories: 15,
  },
};

function periodicKey(kind) { return `${kind}_report_config`; }

async function getPeriodicConfig(kind) {
  const def = PERIODIC_DEFAULTS[kind];
  if (!def) throw new Error(`unknown periodic kind: ${kind}`);
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [periodicKey(kind)]
    );
    if (!r.rows.length) return { ...def };
    return { ...def, ...(r.rows[0].value || {}) };
  } catch {
    return { ...def };
  }
}

async function savePeriodicConfig(kind, patch) {
  const current = await getPeriodicConfig(kind);
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [periodicKey(kind), JSON.stringify(next)]
  );
  reschedulePeriodic(kind);
  return next;
}

async function sendPeriodicReport(kind, { dryRun = false } = {}) {
  const cfg = await getPeriodicConfig(kind);
  if (!cfg.enabled && !dryRun) return { skipped: true, reason: 'disabled' };
  if (!cfg.recipients || !cfg.recipients.length) {
    throw new Error(`No recipients configured for ${kind} report`);
  }

  const periodHours = cfg.period_hours || (kind === 'weekly' ? 168 : 720);
  const filterOverrides = {
    date_from: new Date(Date.now() - periodHours * 3600 * 1000).toISOString(),
    date_to: new Date().toISOString(),
  };

  const runId = await emailMetrics.startRun({
    startedByUserId: null,
    filterOverrides,
  });

  const maxWaitMs = 20 * 60 * 1000;
  const start = Date.now();
  let run;
  while (Date.now() - start < maxWaitMs) {
    run = await emailMetrics.getRunStatus(runId);
    if (run && (run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled')) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!run || run.status !== 'complete') {
    throw new Error(`${kind} metrics run did not complete (status=${run && run.status})`);
  }

  const flags = await emailMetrics.getRunFlags(runId, { limit: 80 });

  const html = renderEmailHtml({
    run,
    repStats: run.rep_stats || [],
    categoryStats: run.category_stats || [],
    summary: run.summary || {},
    flags,
    reportConfig: cfg,
    periodHours,
  });

  const periodLabel = kind === 'weekly' ? 'Weekly' : 'Monthly';
  const subject = `[wsmail] ${periodLabel} report — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: cfg.timezone })}`;

  const sent = [];
  const errors = [];
  for (const to of cfg.recipients) {
    try {
      await sendGmailReply(pool, cfg.send_from_mailbox, to, subject, html, null);
      sent.push(to);
    } catch (err) {
      console.error(`${kind} report send to ${to} failed:`, err.message);
      errors.push({ to, error: err.message });
    }
  }

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [`${kind}_report_last`, JSON.stringify({
      sent_at: new Date().toISOString(),
      run_id: runId,
      sent_to: sent,
      errors,
      period_hours: periodHours,
    })]
  );

  return { run_id: runId, sent, errors, subject };
}

const periodicTasks = { weekly: null, monthly: null };

function toWeeklyCronExpr(hhmm, dow) {
  const [h, m] = (hhmm || '08:00').split(':').map(s => parseInt(s, 10));
  const safeH = isNaN(h) ? 8 : h;
  const safeM = isNaN(m) ? 0 : m;
  const safeDow = Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 1;
  return `${safeM} ${safeH} * * ${safeDow}`;
}

function toMonthlyCronExpr(hhmm, dom) {
  const [h, m] = (hhmm || '08:00').split(':').map(s => parseInt(s, 10));
  const safeH = isNaN(h) ? 8 : h;
  const safeM = isNaN(m) ? 0 : m;
  const safeDom = Number.isInteger(dom) && dom >= 1 && dom <= 28 ? dom : 1;
  return `${safeM} ${safeH} ${safeDom} * *`;
}

async function reschedulePeriodic(kind) {
  if (!PERIODIC_DEFAULTS[kind]) return;
  const cfg = await getPeriodicConfig(kind);
  if (periodicTasks[kind]) {
    try { periodicTasks[kind].stop(); } catch { /* ignore */ }
    periodicTasks[kind] = null;
  }
  if (!cfg.enabled) {
    console.log(`${kind} report: disabled`);
    return;
  }
  const expr = kind === 'weekly'
    ? toWeeklyCronExpr(cfg.send_time, cfg.day_of_week)
    : toMonthlyCronExpr(cfg.send_time, cfg.day_of_month);
  try {
    periodicTasks[kind] = cron.schedule(expr, async () => {
      try {
        console.log(`${kind} report: firing…`);
        const r = await sendPeriodicReport(kind, { dryRun: false });
        console.log(`${kind} report: sent to`, r.sent, 'errors:', r.errors);
      } catch (err) {
        console.error(`${kind} report failed:`, err.message);
      }
    }, { timezone: cfg.timezone || 'America/Los_Angeles' });
    console.log(`${kind} report: scheduled (${expr}) ${cfg.timezone}`);
  } catch (err) {
    console.error(`${kind} report: failed to schedule:`, err.message);
  }
}

// ---------- Preview ----------

/**
 * Render the report HTML for the given report kind without sending an email.
 * Uses the most recent completed metrics run for the configured mailbox.
 * If no completed run exists yet, returns a placeholder HTML telling the user
 * to run the analysis first.
 */
async function renderPreviewHtml({ kind = 'daily' } = {}) {
  const cfg = kind === 'daily' ? await getReportConfig() : await getPeriodicConfig(kind);
  const periodHours = cfg.period_hours || (kind === 'weekly' ? 168 : kind === 'monthly' ? 720 : 24);
  const mailbox = cfg.send_from_mailbox || 'info@sdsign.com';

  // Find the most recent completed run for this mailbox
  const recent = await pool.query(
    `SELECT id, mailbox_email, rep_stats, category_stats, summary, started_at, completed_at
       FROM email_metrics_runs
      WHERE status = 'complete' AND mailbox_email = $1
      ORDER BY completed_at DESC
      LIMIT 1`,
    [mailbox]
  );

  if (!recent.rows.length) {
    return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;padding:40px;max-width:600px;margin:40px auto;background:#f1f5f9;">
      <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0;text-align:center;">
        <div style="font-size:32px;margin-bottom:12px;">📊</div>
        <h2 style="margin:0 0 8px;color:#0f172a;">No metrics run yet</h2>
        <p style="color:#64748b;">Run an email metrics analysis first, then come back to preview the ${esc(kind)} report.</p>
        <a href="/" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Open dashboard</a>
      </div>
    </body></html>`;
  }

  const run = recent.rows[0];
  const flags = await emailMetrics.getRunFlags(run.id, { limit: 80 });
  const html = renderEmailHtml({
    run,
    repStats: run.rep_stats || [],
    categoryStats: run.category_stats || [],
    summary: run.summary || {},
    flags,
    reportConfig: cfg,
    periodHours,
  });

  // Add a preview banner above the email itself so the user knows this is a preview
  const ageMin = Math.round((Date.now() - new Date(run.completed_at).getTime()) / 60000);
  const banner = `<div style="background:#1e293b;color:#fff;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
    <div>
      <b>Preview</b> — ${esc(kind)} report · using run from ${ageMin < 60 ? `${ageMin} min ago` : new Date(run.completed_at).toLocaleString()}
    </div>
    <div style="font-size:12px;color:#94a3b8;">This is what recipients will see. To refresh, run a new metrics analysis.</div>
  </div>`;
  // Inject the banner after <body> tag
  return html.replace(/<body([^>]*)>/, `<body$1>${banner}`);
}

module.exports = {
  DEFAULT_REPORT_CONFIG,
  getReportConfig,
  saveReportConfig,
  sendDailyReport,
  rescheduleDaily,
  initDailyReportScheduler,
  // Periodic (weekly/monthly)
  PERIODIC_DEFAULTS,
  getPeriodicConfig,
  savePeriodicConfig,
  sendPeriodicReport,
  reschedulePeriodic,
  // Preview
  renderPreviewHtml,
};
