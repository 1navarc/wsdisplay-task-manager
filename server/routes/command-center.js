const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendGmailReply } = require('../services/gmail-sync');

// All Command Center routes require manager OR supervisor role
const requireManagerOrSupervisor = requireRole('manager', 'supervisor');

// ---------- helpers ----------

function asArray(v) { return Array.isArray(v) ? v : []; }

function fmtDuration(ms) {
  if (!ms && ms !== 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `${hrs}h ${remMins}m`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return `${days}d ${remHrs}h`;
}

async function getLatestCompletedRun(mailbox) {
  const q = mailbox
    ? `SELECT * FROM email_metrics_runs WHERE status = 'complete' AND mailbox_email = $1
       ORDER BY completed_at DESC LIMIT 1`
    : `SELECT * FROM email_metrics_runs WHERE status = 'complete'
       ORDER BY completed_at DESC LIMIT 1`;
  const params = mailbox ? [mailbox] : [];
  const r = await pool.query(q, params);
  return r.rows[0] || null;
}

async function getReportMailbox() {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = 'daily_email_report_config'");
    if (r.rows[0] && r.rows[0].value) {
      const cfg = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
      if (cfg.send_from_mailbox) return cfg.send_from_mailbox;
    }
  } catch(e) {}
  return 'info@sdsign.com';
}

// ---------- GET /overview ----------
// Returns all data needed to render the Command Center hero and charts.
router.get('/overview', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) {
      return res.json({
        run: null,
        mailbox,
        message: 'No completed metrics runs yet. Go to Settings > AI Settings > Metrics and run one.',
      });
    }

    const summary = run.summary || {};
    const repStats = asArray(run.rep_stats);
    const categoryStats = asArray(run.category_stats);

    // Count flags by type for the drill-down badges
    const flagCounts = await pool.query(
      `SELECT flag_type, COUNT(*)::int AS count
         FROM email_metrics_flags WHERE run_id = $1 GROUP BY flag_type`,
      [run.id]
    );
    const flagMap = {};
    flagCounts.rows.forEach(r => { flagMap[r.flag_type] = r.count; });

    res.json({
      run: {
        id: run.id,
        mailbox: run.mailbox_email,
        started_at: run.started_at,
        completed_at: run.completed_at,
        total_threads: run.total_threads,
      },
      summary,
      rep_stats: repStats,
      category_stats: categoryStats,
      flag_counts: flagMap,
      mailbox,
    });
  } catch (err) {
    console.error('overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /live-charts ----------
// Live-computed distribution + busy hours directly from messages, so the Command
// Center charts still render even if the saved run.summary predates those fields.
router.get('/live-charts', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const hoursWindow = Math.max(1, Math.min(720, parseInt(req.query.hours || '168', 10))); // default 7d, max 30d
    const slaHoursCfg = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'command_center_config'`
    );
    const slaHours = (slaHoursCfg.rows[0] && slaHoursCfg.rows[0].value && Number(slaHoursCfg.rows[0].value.sla_hours)) || 4;
    const slaMs = slaHours * 3600 * 1000;

    // Determine direction from from_email since the schema default makes
    // gmail-sync rows all 'inbound'. Customer messages = from_email NOT the
    // mailbox; rep replies = from_email IS the mailbox (or matches a known rep).
    const q = `
      WITH recent AS (
        SELECT m.conversation_id,
               m.sent_at,
               LOWER(COALESCE(m.from_email, '')) AS from_addr,
               CASE
                 WHEN LOWER(COALESCE(m.from_email, '')) = LOWER($1) THEN 'outbound'
                 WHEN EXISTS (
                   SELECT 1 FROM users u
                    WHERE LOWER(u.email) = LOWER(COALESCE(m.from_email, ''))
                 ) THEN 'outbound'
                 ELSE 'inbound'
               END AS dir
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          JOIN mailboxes mb ON mb.id = c.mailbox_id
         WHERE mb.email = $1
           AND m.sent_at >= NOW() - ($2::text || ' hours')::interval
      ),
      first_inbound AS (
        SELECT conversation_id, MIN(sent_at) AS first_in
          FROM recent WHERE dir = 'inbound'
         GROUP BY conversation_id
      ),
      first_outbound AS (
        SELECT conversation_id, MIN(sent_at) AS first_out
          FROM recent WHERE dir = 'outbound'
         GROUP BY conversation_id
      )
      SELECT fi.conversation_id,
             fi.first_in,
             fo.first_out,
             CASE WHEN fo.first_out IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (fo.first_out - fi.first_in)) * 1000
                  ELSE NULL
             END AS resp_ms,
             EXTRACT(HOUR FROM fi.first_in AT TIME ZONE 'America/Los_Angeles') AS local_hour,
             EXTRACT(DOW FROM fi.first_in AT TIME ZONE 'America/Los_Angeles') AS local_dow
        FROM first_inbound fi
        LEFT JOIN first_outbound fo
          ON fo.conversation_id = fi.conversation_id
         AND fo.first_out > fi.first_in
    `;
    const r = await pool.query(q, [mailbox, String(hoursWindow)]);

    // Distribution buckets
    const buckets = [
      { key: 'lt_15m', label: '< 15m',  max: 15 * 60 * 1000, count: 0 },
      { key: 'lt_1h',  label: '15m–1h', max: 60 * 60 * 1000, count: 0 },
      { key: 'lt_4h',  label: '1–4h',   max: 4 * 3600 * 1000, count: 0 },
      { key: 'lt_24h', label: '4–24h',  max: 24 * 3600 * 1000, count: 0 },
      { key: 'gt_24h', label: '> 24h',  max: Infinity, count: 0 },
    ];
    // Hours
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    let peakCount = 0, peakHour = 0, afterHours = 0, weekendCount = 0;
    let totalResponded = 0, slaBreach = 0, sumMs = 0;

    for (const row of r.rows) {
      const ms = row.resp_ms != null ? Number(row.resp_ms) : null;
      if (ms != null && ms >= 0) {
        totalResponded++;
        sumMs += ms;
        if (ms > slaMs) slaBreach++;
        for (const b of buckets) { if (ms <= b.max) { b.count++; break; } }
      }
      const h = Math.floor(Number(row.local_hour));
      if (h >= 0 && h < 24) hours[h].count++;
      const dow = Number(row.local_dow);
      if (dow === 0 || dow === 6) weekendCount++;
      const inBiz = dow >= 1 && dow <= 5 && h >= 9 && h < 17;
      if (!inBiz) afterHours++;
    }
    for (const hr of hours) if (hr.count > peakCount) { peakCount = hr.count; peakHour = hr.hour; }

    const totalForPct = totalResponded || 1;
    res.json({
      mailbox,
      hours_window: hoursWindow,
      sla_hours: slaHours,
      total_conversations: r.rows.length,
      distribution: {
        total_responded: totalResponded,
        buckets: buckets.map(b => ({ key: b.key, label: b.label, count: b.count, pct: Math.round((b.count / totalForPct) * 100) })),
      },
      busy_hours: {
        hours,
        total: r.rows.length,
        peak_hour: peakHour,
        peak_count: peakCount,
        after_hours_count: afterHours,
        weekend_count: weekendCount,
        business_hours_start: 9,
        business_hours_end: 17,
        timezone: 'America/Los_Angeles',
      },
      sla: {
        compliance_pct: totalResponded ? Math.round(((totalResponded - slaBreach) / totalResponded) * 100) : null,
        breaches: slaBreach,
        responded: totalResponded,
      },
      avg_first_response_ms: totalResponded ? Math.round(sumMs / totalResponded) : null,
    });
  } catch (err) {
    console.error('live-charts error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /sla-breaches ----------
// Returns the list of slow-first-response flagged threads from the latest run.
router.get('/sla-breaches', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.json({ run: null, items: [] });

    const items = await pool.query(
      `SELECT f.id, f.gmail_thread_id, f.thread_subject, f.thread_date, f.rep_email,
              f.customer_email, f.reason, f.severity, f.details,
              c.id AS conversation_id, c.mailbox_id, c.assignee_id, c.status AS conv_status,
              mb.email AS mailbox_email
         FROM email_metrics_flags f
         LEFT JOIN conversations c ON c.gmail_thread_id = f.gmail_thread_id
         LEFT JOIN mailboxes mb ON mb.id = c.mailbox_id
        WHERE f.run_id = $1 AND f.flag_type = 'slow_first_response'
        ORDER BY f.severity DESC, f.thread_date DESC
        LIMIT 200`,
      [run.id]
    );

    res.json({
      run: { id: run.id, completed_at: run.completed_at },
      items: items.rows.map(r => ({
        ...r,
        age_label: r.details && r.details.time_to_first_response_ms
          ? fmtDuration(r.details.time_to_first_response_ms)
          : null,
      })),
    });
  } catch (err) {
    console.error('sla-breaches error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /unanswered ----------
router.get('/unanswered', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.json({ run: null, items: [] });

    const items = await pool.query(
      `SELECT f.id, f.gmail_thread_id, f.thread_subject, f.thread_date, f.rep_email,
              f.customer_email, f.reason, f.severity, f.details,
              c.id AS conversation_id, c.mailbox_id, c.assignee_id, c.status AS conv_status,
              mb.email AS mailbox_email
         FROM email_metrics_flags f
         LEFT JOIN conversations c ON c.gmail_thread_id = f.gmail_thread_id
         LEFT JOIN mailboxes mb ON mb.id = c.mailbox_id
        WHERE f.run_id = $1 AND f.flag_type = 'unanswered'
        ORDER BY f.thread_date ASC
        LIMIT 200`,
      [run.id]
    );

    res.json({
      run: { id: run.id, completed_at: run.completed_at },
      items: items.rows.map(r => ({
        ...r,
        wait_label: r.thread_date
          ? fmtDuration(Date.now() - new Date(r.thread_date).getTime())
          : null,
      })),
    });
  } catch (err) {
    console.error('unanswered error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /thread/:gmail_thread_id ----------
// Pulls the full Gmail thread (all messages, headers, decoded bodies) so the
// Command Center can render an inline detail view for a flagged item even
// when that thread was never synced into the inbox UI. Uses the metrics
// mailbox's stored refresh_token to talk to Gmail.
router.get('/thread/:gid', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const gid = (req.params.gid || '').trim();
    if (!gid) return res.status(400).json({ error: 'gmail_thread_id required' });

    const mailbox = req.query.mailbox || await getReportMailbox();
    if (!mailbox) return res.status(400).json({ error: 'No mailbox configured' });

    const em = require('../services/email-metrics');
    const gmail = await em.getGmailClientForMailbox(mailbox);
    let thread;
    try {
      const r = await gmail.users.threads.get({ userId: 'me', id: gid, format: 'full' });
      thread = r.data;
    } catch (e) {
      // Thread might be in trash or have been deleted from this mailbox.
      return res.status(404).json({
        error: 'Could not load thread from Gmail: ' + e.message,
        gmail_link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gid)}`,
      });
    }

    const msgs = (thread.messages || []).slice().sort(
      (a, b) => parseInt(a.internalDate || '0') - parseInt(b.internalDate || '0')
    );
    const subject = em.headerValue((msgs[0] && msgs[0].payload?.headers) || [], 'Subject') || '(no subject)';

    // Local conversation_id if we synced this thread already, so the
    // "Open in inbox" button can deep-link properly.
    let conversation_id = null;
    try {
      const cv = await pool.query(
        `SELECT id FROM conversations WHERE gmail_thread_id = $1 LIMIT 1`,
        [gid]
      );
      conversation_id = cv.rows[0] ? cv.rows[0].id : null;
    } catch {}

    const messages = msgs.map(m => {
      const headers = m.payload?.headers || [];
      const fromRaw = em.headerValue(headers, 'From');
      const toRaw   = em.headerValue(headers, 'To');
      const ccRaw   = em.headerValue(headers, 'Cc');
      let body = '';
      try { body = em.decodeBody(m.payload || {}); } catch {}
      return {
        id: m.id,
        snippet: m.snippet || '',
        from: fromRaw,
        from_email: em.extractEmailAddr(fromRaw),
        to: toRaw,
        cc: ccRaw,
        date_iso: m.internalDate ? new Date(parseInt(m.internalDate)).toISOString() : null,
        body_full: body,                         // full text incl. quoted history
        body_clean: em.stripQuotedText(body),    // quoted history removed
        label_ids: m.labelIds || [],
      };
    });

    res.json({
      gmail_thread_id: gid,
      subject,
      message_count: messages.length,
      conversation_id,
      gmail_link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gid)}`,
      messages,
    });
  } catch (err) {
    console.error('thread detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /reps ----------
// Returns rep stats from the latest run plus WoW delta from the previous week run.
router.get('/reps', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.json({ run: null, reps: [] });

    // Find previous run (same mailbox) roughly 7 days earlier for trend comparison
    const prev = await pool.query(
      `SELECT rep_stats FROM email_metrics_runs
        WHERE status = 'complete' AND mailbox_email = $1
          AND completed_at < $2
        ORDER BY completed_at DESC LIMIT 1`,
      [mailbox, run.completed_at]
    );
    const prevStats = prev.rows[0] ? asArray(prev.rows[0].rep_stats) : [];
    const prevByEmail = Object.fromEntries(prevStats.map(r => [r.rep_email, r]));

    const currStats = asArray(run.rep_stats);
    const reps = currStats.map(r => {
      const p = prevByEmail[r.rep_email] || null;
      const deltaMs = p && p.avg_first_response_ms != null && r.avg_first_response_ms != null
        ? r.avg_first_response_ms - p.avg_first_response_ms : null;
      return {
        rep_email: r.rep_email,
        name: r.name || r.rep_email,
        responded_count: r.responded_count || 0,
        breach_count: r.breach_count || 0,
        avg_first_response_ms: r.avg_first_response_ms || null,
        median_first_response_ms: r.median_first_response_ms || null,
        delta_vs_previous_ms: deltaMs,
        avg_label: fmtDuration(r.avg_first_response_ms),
        median_label: fmtDuration(r.median_first_response_ms),
        delta_label: deltaMs != null ? (deltaMs > 0 ? `+${fmtDuration(deltaMs)}` : `-${fmtDuration(Math.abs(deltaMs))}`) : null,
        trending: deltaMs == null ? 'flat' : (deltaMs < -60000 ? 'improving' : deltaMs > 60000 ? 'degrading' : 'flat'),
      };
    }).sort((a, b) => (b.responded_count || 0) - (a.responded_count || 0));

    res.json({ run: { id: run.id, completed_at: run.completed_at }, reps });
  } catch (err) {
    console.error('reps error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /reps/:email ----------
router.get('/reps/:email', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.json({ run: null, rep: null, flags: [] });

    const stats = asArray(run.rep_stats).find(r => (r.rep_email || '').toLowerCase() === email);
    if (!stats) return res.json({ run, rep: null, flags: [] });

    const flags = await pool.query(
      `SELECT id, flag_type, severity, gmail_thread_id, thread_subject, thread_date,
              customer_email, reason, details
         FROM email_metrics_flags
        WHERE run_id = $1 AND LOWER(rep_email) = $2
        ORDER BY severity DESC, thread_date DESC LIMIT 50`,
      [run.id, email]
    );

    // Trend: last 8 completed runs for this mailbox
    const trendRows = await pool.query(
      `SELECT id, completed_at, rep_stats FROM email_metrics_runs
        WHERE status = 'complete' AND mailbox_email = $1
        ORDER BY completed_at DESC LIMIT 8`,
      [mailbox]
    );
    const trend = trendRows.rows.reverse().map(r => {
      const s = asArray(r.rep_stats).find(x => (x.rep_email || '').toLowerCase() === email);
      return {
        run_id: r.id,
        completed_at: r.completed_at,
        avg_first_response_ms: s ? s.avg_first_response_ms : null,
        breach_count: s ? s.breach_count : 0,
        responded_count: s ? s.responded_count : 0,
      };
    });

    res.json({
      run: { id: run.id, completed_at: run.completed_at },
      rep: {
        ...stats,
        avg_label: fmtDuration(stats.avg_first_response_ms),
        median_label: fmtDuration(stats.median_first_response_ms),
      },
      flags: flags.rows,
      trend,
    });
  } catch (err) {
    console.error('rep detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- POST /reps/:email/report-card ----------
// Generate an AI coaching report card for a rep from their recent flagged threads.
router.post('/reps/:email/report-card', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.status(400).json({ error: 'No completed run to generate from' });

    const stats = asArray(run.rep_stats).find(r => (r.rep_email || '').toLowerCase() === email);
    if (!stats) return res.status(404).json({ error: 'Rep not found in latest run' });

    const flags = await pool.query(
      `SELECT flag_type, severity, thread_subject, reason, details
         FROM email_metrics_flags
        WHERE run_id = $1 AND LOWER(rep_email) = $2
        ORDER BY severity DESC, thread_date DESC LIMIT 15`,
      [run.id, email]
    );

    const { getGenAI } = require('../services/ai-service');
    const ai = getGenAI();
    const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const contextText = `You are a customer-support coach writing a 1:1 prep note for a manager about their rep.

REP: ${stats.name || stats.rep_email}
PERIOD: latest metrics run (completed ${run.completed_at})

PERFORMANCE SNAPSHOT:
- Threads responded to: ${stats.responded_count || 0}
- Avg first response: ${fmtDuration(stats.avg_first_response_ms) || 'n/a'}
- Median first response: ${fmtDuration(stats.median_first_response_ms) || 'n/a'}
- SLA breaches: ${stats.breach_count || 0}

FLAGGED THREADS (most severe first):
${flags.rows.map((f, i) => `${i+1}. [${f.flag_type}/${f.severity}] "${f.thread_subject}" — ${f.reason || 'no reason recorded'}`).join('\n') || '(none)'}

Respond in strict JSON with this shape:
{
  "summary": "2-3 sentence plain-language assessment",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "coachable_threads": [{"subject": "...", "why": "one-line reason this is teachable"}],
  "suggested_1on1_questions": ["..."]
}

Keep it specific, kind, and actionable. Avoid generic advice.`;

    const result = await model.generateContent(contextText);
    const text = result.response.text();
    // Strip possible ```json fences
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch(e) {
      return res.status(500).json({ error: 'AI response was not valid JSON', raw: text });
    }

    // Persist to cache
    const saved = await pool.query(
      `INSERT INTO coaching_report_cards
         (rep_email, period_start, period_end, strengths, weaknesses, coachable_threads, summary, raw_prompt, generated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
       RETURNING id, generated_at`,
      [
        email,
        run.started_at,
        run.completed_at,
        JSON.stringify(parsed.strengths || []),
        JSON.stringify(parsed.weaknesses || []),
        JSON.stringify(parsed.coachable_threads || []),
        parsed.summary || '',
        contextText,
        req.user ? req.user.id : null,
      ]
    );

    res.json({
      id: saved.rows[0].id,
      generated_at: saved.rows[0].generated_at,
      rep_email: email,
      ...parsed,
    });
  } catch (err) {
    console.error('report-card error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- POST /reps/:email/send-report-card ----------
router.post('/reps/:email/send-report-card', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const { card_id } = req.body || {};
    const mailbox = await getReportMailbox();

    let card;
    if (card_id) {
      const r = await pool.query('SELECT * FROM coaching_report_cards WHERE id = $1', [card_id]);
      if (r.rows[0]) card = r.rows[0];
    } else {
      const r = await pool.query(
        'SELECT * FROM coaching_report_cards WHERE rep_email = $1 ORDER BY generated_at DESC LIMIT 1',
        [email]
      );
      if (r.rows[0]) card = r.rows[0];
    }
    if (!card) return res.status(404).json({ error: 'No report card found for this rep' });

    const strengths = asArray(card.strengths);
    const weaknesses = asArray(card.weaknesses);
    const coachable = asArray(card.coachable_threads);

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
  <div style="max-width:640px;margin:0 auto;padding:32px 24px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px;color:#fff">
        <div style="font-size:12px;opacity:0.85;letter-spacing:1px;text-transform:uppercase;font-weight:600">Personal Coaching Note</div>
        <div style="font-size:24px;font-weight:700;margin-top:6px">Your report card</div>
      </div>
      <div style="padding:28px;line-height:1.6;font-size:15px">
        <p style="margin:0 0 16px">${(card.summary || '').replace(/</g, '&lt;')}</p>
        ${strengths.length ? `<h3 style="color:#059669;margin:20px 0 8px">What you're doing well</h3><ul style="margin:0;padding-left:20px">${strengths.map(s => `<li>${String(s).replace(/</g,'&lt;')}</li>`).join('')}</ul>` : ''}
        ${weaknesses.length ? `<h3 style="color:#d97706;margin:20px 0 8px">Areas to work on</h3><ul style="margin:0;padding-left:20px">${weaknesses.map(s => `<li>${String(s).replace(/</g,'&lt;')}</li>`).join('')}</ul>` : ''}
        ${coachable.length ? `<h3 style="color:#4f46e5;margin:20px 0 8px">Threads worth reviewing together</h3><ul style="margin:0;padding-left:20px">${coachable.map(c => `<li><strong>${String(c.subject || '').replace(/</g,'&lt;')}</strong><br><span style="color:#64748b;font-size:13px">${String(c.why || '').replace(/</g,'&lt;')}</span></li>`).join('')}</ul>` : ''}
        <p style="margin:24px 0 0;color:#64748b;font-size:13px">Let's discuss at our next 1:1. No action needed before then.</p>
      </div>
    </div>
  </div>
</body></html>`;

    await sendGmailReply(pool, mailbox, email, 'Your coaching report card', html, null);
    await pool.query(
      'UPDATE coaching_report_cards SET sent_at = NOW(), sent_to_rep = TRUE WHERE id = $1',
      [card.id]
    );
    res.json({ ok: true, sent_to: email, from: mailbox });
  } catch (err) {
    console.error('send-report-card error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /patterns ----------
// AI clusters of repeat questions and trending topics
router.get('/patterns', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.json({ run: null, patterns: [] });

    // Pull all flagged threads + category stats
    const flagsRow = await pool.query(
      `SELECT thread_subject, reason, customer_email FROM email_metrics_flags
        WHERE run_id = $1 AND thread_subject IS NOT NULL LIMIT 60`,
      [run.id]
    );
    const subjects = flagsRow.rows.map(r => r.thread_subject).filter(Boolean);
    const categoryStats = asArray(run.category_stats);

    const { getGenAI } = require('../services/ai-service');
    const ai = getGenAI();
    const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are analyzing customer-support email subjects for a daily operations digest.

SUBJECTS FROM TODAY (${subjects.length} flagged threads):
${subjects.slice(0, 60).map((s, i) => `${i+1}. ${s}`).join('\n')}

CATEGORIES:
${categoryStats.map(c => `- ${c.category}: ${c.count || 0} threads${c.angry_count ? ' ('+c.angry_count+' angry)' : ''}`).join('\n')}

Identify:
1) REPEAT QUESTIONS — clusters of 2+ subjects that are clearly the same underlying customer question. For each, suggest a canned reply OR an FAQ entry.
2) TRENDING TOPICS — keywords/themes that jump out as unusually frequent or new.

Return strict JSON:
{
  "repeat_questions": [{"theme": "...", "example_subjects": ["..."], "suggested_canned_reply_topic": "...", "count": N}],
  "trending_topics": [{"keyword": "...", "why_it_matters": "...", "example_subjects": ["..."]}]
}

If nothing noteworthy, return empty arrays. Be conservative — only surface genuine patterns.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch(e) { parsed = { repeat_questions: [], trending_topics: [], raw: text }; }

    res.json({
      run: { id: run.id, completed_at: run.completed_at },
      ...parsed,
    });
  } catch (err) {
    console.error('patterns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /anomalies ----------
router.get('/anomalies', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const mailbox = req.query.mailbox || await getReportMailbox();
    const run = await getLatestCompletedRun(mailbox);
    if (!run) return res.json({ run: null, anomalies: [] });

    const summary = run.summary || {};
    const prev = summary.previous_period || {};
    const busy = summary.busy_hours || {};

    const { getGenAI } = require('../services/ai-service');
    const ai = getGenAI();
    const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are writing operational anomaly callouts for a customer-support manager.

CURRENT PERIOD METRICS:
- Total threads: ${run.total_threads}
- Avg first response: ${fmtDuration(summary.overall_first_response_avg_ms)}
- Median first response: ${fmtDuration(summary.overall_first_response_median_ms)}
- SLA breaches: ${summary.sla_breach_count || 0}
- SLA compliance: ${summary.sla_compliance_pct != null ? summary.sla_compliance_pct + '%' : 'n/a'}
- Unanswered: ${summary.unanswered_threads || 0}
- Negative sentiment: ${summary.negative_sentiment_count || 0}
- Peak hour: ${busy.peak_hour != null ? busy.peak_hour + ':00' : 'n/a'}
- After-hours threads: ${busy.after_hours_count || 0}

PREVIOUS PERIOD METRICS (if available):
- Avg first response: ${fmtDuration(prev.overall_first_response_avg_ms)}
- SLA breaches: ${prev.sla_breach_count || 0}
- SLA compliance: ${prev.sla_compliance_pct != null ? prev.sla_compliance_pct + '%' : 'n/a'}
- Total threads: ${prev.total_threads || 0}

Identify up to 4 noteworthy anomalies. For each: describe WHAT changed, HOW MUCH, and a LIKELY CAUSE hypothesis (speculative is ok, but label it).

Return strict JSON:
{
  "anomalies": [{"title": "...", "severity": "high|medium|low", "what": "...", "hypothesis": "..."}]
}

If nothing unusual, return an empty array. Be concise and specific.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch(e) { parsed = { anomalies: [], raw: text }; }

    res.json({
      run: { id: run.id, completed_at: run.completed_at },
      ...parsed,
    });
  } catch (err) {
    console.error('anomalies error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Manager notes ----------
router.get('/notes', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await pool.query(
      `SELECT n.id, n.author_id, n.author_email, n.note_date, n.body, n.pinned,
              n.created_at, n.updated_at, u.name AS author_name
         FROM manager_notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.note_date >= CURRENT_DATE - ($1::int || ' days')::interval
        ORDER BY n.pinned DESC, n.note_date DESC, n.created_at DESC`,
      [days]
    );
    res.json({ notes: result.rows });
  } catch (err) {
    console.error('notes GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/notes', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { body, note_date, pinned } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'Note body is required' });
    const result = await pool.query(
      `INSERT INTO manager_notes (author_id, author_email, note_date, body, pinned)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, COALESCE($5, FALSE))
       RETURNING id, author_id, author_email, note_date, body, pinned, created_at`,
      [req.user.id, req.user.email, note_date || null, body.trim(), !!pinned]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('notes POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/notes/:id', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { id } = req.params;
    const { body, pinned } = req.body || {};
    const result = await pool.query(
      `UPDATE manager_notes SET
         body = COALESCE($1, body),
         pinned = COALESCE($2, pinned),
         updated_at = NOW()
        WHERE id = $3 RETURNING *`,
      [body != null ? body.trim() : null, pinned != null ? !!pinned : null, id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Note not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('notes PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/notes/:id', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    await pool.query('DELETE FROM manager_notes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('notes DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Alert snoozes ----------
router.get('/snoozes', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.name AS snoozed_by_name FROM alert_snoozes s
       LEFT JOIN users u ON u.id = s.snoozed_by
       WHERE s.snoozed_until > NOW() ORDER BY s.snoozed_until DESC`
    );
    res.json({ snoozes: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/snoozes', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { alert_key, minutes, reason } = req.body || {};
    if (!alert_key) return res.status(400).json({ error: 'alert_key is required' });
    const mins = Math.max(1, parseInt(minutes) || 60);
    const result = await pool.query(
      `INSERT INTO alert_snoozes (alert_key, snoozed_until, snoozed_by, reason)
       VALUES ($1, NOW() + ($2::int || ' minutes')::interval, $3, $4)
       RETURNING *`,
      [alert_key, mins, req.user.id, reason || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/snoozes/:id', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    await pool.query('DELETE FROM alert_snoozes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Thread actions (used by drill-downs) ----------
router.post('/thread-action', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { action, gmail_thread_id, assignee_id, reply_body, mailbox_email } = req.body || {};
    if (!action || !gmail_thread_id) return res.status(400).json({ error: 'action and gmail_thread_id are required' });

    // Look up conversation
    const conv = await pool.query(
      `SELECT c.id, c.mailbox_id, c.gmail_thread_id, c.subject, mb.email AS mailbox_email
         FROM conversations c LEFT JOIN mailboxes mb ON mb.id = c.mailbox_id
        WHERE c.gmail_thread_id = $1 LIMIT 1`,
      [gmail_thread_id]
    );
    const c = conv.rows[0];

    if (action === 'assign') {
      if (!c) return res.status(404).json({ error: 'Conversation not found' });
      await pool.query('UPDATE conversations SET assignee_id = $1 WHERE id = $2', [assignee_id || null, c.id]);
      return res.json({ ok: true });
    }

    if (action === 'reply' || action === 'apology') {
      if (!c) return res.status(404).json({ error: 'Conversation not found' });
      // Find the customer email (last non-rep message's sender)
      const lastMsg = await pool.query(
        `SELECT from_email, from_name FROM messages WHERE conversation_id = $1 AND direction = 'inbound'
          ORDER BY sent_at DESC LIMIT 1`,
        [c.id]
      );
      const to = lastMsg.rows[0] ? lastMsg.rows[0].from_email : null;
      if (!to) return res.status(400).json({ error: 'Could not find customer email for this thread' });

      const body = action === 'apology'
        ? `<p>Hi,</p><p>I'm reaching out to apologize for the slow response on your recent request (${(c.subject || '').replace(/</g,'&lt;')}). We should have gotten back to you faster, and I'm personally making sure we follow up from here.</p><p>${reply_body ? reply_body.replace(/\n/g,'<br>') : 'Let me know if there is anything else you need.'}</p>`
        : (reply_body || '').replace(/\n/g, '<br>');

      if (!body || !body.trim()) return res.status(400).json({ error: 'reply_body is required' });

      const sender = mailbox_email || c.mailbox_email;
      await sendGmailReply(pool, sender, to, `Re: ${c.subject || ''}`, body, c.gmail_thread_id);
      return res.json({ ok: true, sent_to: to, from: sender });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('thread-action error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
