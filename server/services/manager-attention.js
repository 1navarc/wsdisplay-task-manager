/**
 * Manager Attention service
 *
 * Scans the classification + grading tables and surfaces items into
 * manager_attention_items. Dedupe is enforced via a `dedupe_key` UNIQUE
 * column so re-runs are idempotent.
 *
 * Item types:
 *   complaint          - inbound message classified is_complaint=true
 *   escalation         - inbound message classified asks_for_manager=true
 *   damage_claim       - inbound message classified is_damage_claim=true
 *   repeat_complaint   - same customer with >=2 complaints in N days
 *   sla_breach         - thread with no rep reply within SLA
 *   low_quality_reply  - rep reply with overall_score below threshold
 *
 * Severity is computed from the signals (e.g. damage_claim+escalation -> high).
 */

const { pool } = require('../config/database');

async function getConfig() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key='email_intelligence_config'`);
  return r.rows[0]?.value || {};
}

function snippetOf(text, n = 240) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().slice(0, n);
}

/** Insert one attention item if its dedupe_key is unique. */
async function upsertItem(item) {
  const sql = `INSERT INTO manager_attention_items
    (item_type, severity, mailbox_email, customer_email, customer_domain,
     rep_email, rep_name, thread_id, message_id, gmail_thread_id,
     title, summary, snippet, status, dedupe_key, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open',$14,$15)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id`;
  const params = [
    item.item_type, item.severity || 'medium',
    item.mailbox_email || null, item.customer_email || null, item.customer_domain || null,
    item.rep_email || null, item.rep_name || null,
    item.thread_id || null, item.message_id || null, item.gmail_thread_id || null,
    item.title, item.summary || null, item.snippet || null,
    item.dedupe_key, item.metadata || null,
  ];
  try {
    const r = await pool.query(sql, params);
    return r.rows[0]?.id || null;
  } catch (e) {
    console.warn('[attention] upsert failed:', e.message);
    return null;
  }
}

/* ----------------------------- detectors ----------------------------- */

/** Complaints / escalations / damage claims based on classifications. */
async function detectFromClassifications(sinceDays = 30) {
  const r = await pool.query(`
    SELECT c.message_id, c.mailbox_email, c.is_complaint, c.asks_for_manager,
           c.is_damage_claim, c.canonical_question, c.sentiment,
           m.subject, m.from_email, m.thread_id, m.body_text_clean,
           t.gmail_thread_id, t.customer_email, t.customer_domain
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
      JOIN email_archive_threads t ON t.id = m.thread_id AND t.junk_status IS DISTINCT FROM 'blocked'
     WHERE m.sent_at >= NOW() - ($1 || ' days')::interval
       AND (c.is_complaint OR c.asks_for_manager OR c.is_damage_claim)
       AND m.direction = 'inbound'`,
    [String(sinceDays)]
  );

  let inserted = 0;
  for (const row of r.rows) {
    const sigs = [];
    if (row.is_damage_claim)   sigs.push({ type: 'damage_claim',  title: 'Damage claim',                 sev: 'high'    });
    if (row.asks_for_manager)  sigs.push({ type: 'escalation',    title: 'Customer asked for a manager', sev: 'high'    });
    if (row.is_complaint)      sigs.push({ type: 'complaint',     title: 'Customer complaint',           sev: 'medium'  });

    for (const sig of sigs) {
      const dedupe = `${sig.type}:msg:${row.message_id}`;
      const id = await upsertItem({
        item_type: sig.type,
        severity: sig.sev,
        mailbox_email: row.mailbox_email,
        customer_email: row.customer_email || row.from_email,
        customer_domain: row.customer_domain,
        thread_id: row.thread_id,
        message_id: row.message_id,
        gmail_thread_id: row.gmail_thread_id,
        title: sig.title + (row.subject ? ` — ${row.subject.slice(0, 80)}` : ''),
        summary: row.canonical_question || null,
        snippet: snippetOf(row.body_text_clean),
        dedupe_key: dedupe,
        metadata: { sentiment: row.sentiment },
      });
      if (id) inserted++;
    }
  }
  return inserted;
}

/** Repeat complaints from the same customer within N days. */
async function detectRepeatComplaints(windowDays = 60) {
  const r = await pool.query(`
    SELECT t.customer_email,
           COUNT(*) AS n,
           ARRAY_AGG(c.message_id ORDER BY m.sent_at DESC) AS msg_ids,
           MAX(m.sent_at) AS last_at,
           (ARRAY_AGG(t.gmail_thread_id ORDER BY m.sent_at DESC))[1] AS gmail_thread_id,
           (ARRAY_AGG(t.id ORDER BY m.sent_at DESC))[1] AS thread_id,
           (ARRAY_AGG(m.mailbox_email ORDER BY m.sent_at DESC))[1] AS mailbox_email,
           (ARRAY_AGG(c.canonical_question ORDER BY m.sent_at DESC))[1] AS last_question,
           (ARRAY_AGG(m.id ORDER BY m.sent_at DESC))[1] AS last_message_id,
           (ARRAY_AGG(t.customer_domain ORDER BY m.sent_at DESC))[1] AS customer_domain
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
      JOIN email_archive_threads t ON t.id = m.thread_id AND t.junk_status IS DISTINCT FROM 'blocked'
     WHERE c.is_complaint = true
       AND m.direction = 'inbound'
       AND m.sent_at >= NOW() - ($1 || ' days')::interval
       AND t.customer_email IS NOT NULL
     GROUP BY t.customer_email
    HAVING COUNT(*) >= 2`,
    [String(windowDays)]
  );

  let inserted = 0;
  for (const row of r.rows) {
    const dedupe = `repeat_complaint:${row.customer_email}:${row.last_at?.toISOString?.() || row.last_at}`;
    const id = await upsertItem({
      item_type: 'repeat_complaint',
      severity: row.n >= 3 ? 'critical' : 'high',
      mailbox_email: row.mailbox_email,
      customer_email: row.customer_email,
      customer_domain: row.customer_domain,
      thread_id: row.thread_id,
      message_id: row.last_message_id,
      gmail_thread_id: row.gmail_thread_id,
      title: `Repeat complaint (${row.n}×) — ${row.customer_email}`,
      summary: row.last_question || `Customer ${row.customer_email} has complained ${row.n} times in the last ${windowDays} days.`,
      dedupe_key: dedupe,
      metadata: { count: Number(row.n), window_days: windowDays, message_ids: row.msg_ids },
    });
    if (id) inserted++;
  }
  return inserted;
}

/**
 * SLA breach: inbound messages with no outbound reply within SLA hours.
 * Uses simple 24h threshold by default (can be extended to use sla_engine).
 */
async function detectSlaBreaches(thresholdHours = 24, lookbackDays = 14) {
  const r = await pool.query(`
    SELECT m.id AS message_id, m.mailbox_email, m.thread_id, m.subject,
           m.body_text_clean, m.sent_at, m.from_email,
           t.gmail_thread_id, t.customer_email, t.customer_domain
      FROM email_archive_messages m
      JOIN email_archive_threads t ON t.id = m.thread_id AND t.junk_status IS DISTINCT FROM 'blocked'
     WHERE m.direction='inbound'
       AND m.sent_at >= NOW() - ($1 || ' days')::interval
       AND m.sent_at <  NOW() - ($2 || ' hours')::interval
       AND NOT EXISTS (
         SELECT 1 FROM email_archive_messages m2
          WHERE m2.thread_id = m.thread_id
            AND m2.direction = 'outbound'
            AND m2.sent_at > m.sent_at
       )
     ORDER BY m.sent_at DESC
     LIMIT 500`,
    [String(lookbackDays), String(thresholdHours)]
  );

  let inserted = 0;
  for (const row of r.rows) {
    const dedupe = `sla_breach:msg:${row.message_id}`;
    const ageHours = Math.round((Date.now() - new Date(row.sent_at).getTime()) / 3_600_000);
    const id = await upsertItem({
      item_type: 'sla_breach',
      severity: ageHours > 72 ? 'high' : 'medium',
      mailbox_email: row.mailbox_email,
      customer_email: row.customer_email || row.from_email,
      customer_domain: row.customer_domain,
      thread_id: row.thread_id,
      message_id: row.message_id,
      gmail_thread_id: row.gmail_thread_id,
      title: `Unanswered ${ageHours}h — ${row.subject ? row.subject.slice(0, 80) : '(no subject)'}`,
      summary: `No reply for ${ageHours} hours. Customer: ${row.customer_email || row.from_email}.`,
      snippet: snippetOf(row.body_text_clean),
      dedupe_key: dedupe,
      metadata: { age_hours: ageHours, threshold_hours: thresholdHours },
    });
    if (id) inserted++;
  }
  return inserted;
}

/** Low-quality rep replies. */
async function detectLowQualityReplies(threshold = 2.5, lookbackDays = 30) {
  const r = await pool.query(`
    SELECT g.message_id, g.mailbox_email, g.rep_email, g.rep_name,
           g.overall_score, g.weaknesses, g.coaching_note,
           m.thread_id, m.subject, m.body_text_clean, m.sent_at,
           t.gmail_thread_id, t.customer_email, t.customer_domain
      FROM email_archive_rep_grades g
      JOIN email_archive_messages m ON m.id = g.message_id
      JOIN email_archive_threads t ON t.id = m.thread_id AND t.junk_status IS DISTINCT FROM 'blocked'
     WHERE g.overall_score IS NOT NULL
       AND g.overall_score <= $1
       AND m.sent_at >= NOW() - ($2 || ' days')::interval
     ORDER BY g.overall_score ASC, m.sent_at DESC
     LIMIT 500`,
    [threshold, String(lookbackDays)]
  );

  let inserted = 0;
  for (const row of r.rows) {
    const dedupe = `low_quality_reply:msg:${row.message_id}`;
    const id = await upsertItem({
      item_type: 'low_quality_reply',
      severity: Number(row.overall_score) <= 1.75 ? 'high' : 'medium',
      mailbox_email: row.mailbox_email,
      customer_email: row.customer_email,
      customer_domain: row.customer_domain,
      rep_email: row.rep_email,
      rep_name: row.rep_name,
      thread_id: row.thread_id,
      message_id: row.message_id,
      gmail_thread_id: row.gmail_thread_id,
      title: `Low-quality reply (${Number(row.overall_score).toFixed(1)}/5) — ${row.rep_name || row.rep_email || 'rep'}`,
      summary: row.coaching_note || row.weaknesses || null,
      snippet: snippetOf(row.body_text_clean),
      dedupe_key: dedupe,
      metadata: { overall_score: row.overall_score },
    });
    if (id) inserted++;
  }
  return inserted;
}

/** Master tick: run all detectors. */
async function runAll() {
  const cfg = await getConfig();
  if (cfg.enable_attention_detection === false) return { skipped: true };

  const windowDays = cfg.repeat_complaint_window_days || 60;
  const lowThreshold = cfg.low_quality_threshold ?? 2.5;
  const slaHours = cfg.sla_breach_threshold_hours || 24;

  const out = {
    classifications: 0,
    repeat_complaints: 0,
    sla_breaches: 0,
    low_quality_replies: 0,
  };
  try { out.classifications      = await detectFromClassifications(windowDays); } catch (e) { console.warn('[attention] cls:', e.message); }
  try { out.repeat_complaints    = await detectRepeatComplaints(windowDays);    } catch (e) { console.warn('[attention] repeat:', e.message); }
  try { out.sla_breaches         = await detectSlaBreaches(slaHours);           } catch (e) { console.warn('[attention] sla:', e.message); }
  try { out.low_quality_replies  = await detectLowQualityReplies(lowThreshold); } catch (e) { console.warn('[attention] low-q:', e.message); }
  const total = out.classifications + out.repeat_complaints + out.sla_breaches + out.low_quality_replies;
  if (total > 0) console.log('[attention] new items:', JSON.stringify(out));
  return out;
}

/* ----------------------------- queries ------------------------------- */

async function listOpen({ severity, item_type, limit = 100 } = {}) {
  const params = [];
  const where = [`status='open'`];
  if (severity) { params.push(severity); where.push(`severity = $${params.length}`); }
  if (item_type) { params.push(item_type); where.push(`item_type = $${params.length}`); }
  params.push(limit);
  const r = await pool.query(
    `SELECT * FROM manager_attention_items
      WHERE ${where.join(' AND ')}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                              WHEN 'medium' THEN 2 ELSE 3 END,
               detected_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function dismissItem(id, userId, reason) {
  const r = await pool.query(
    `UPDATE manager_attention_items
        SET status='dismissed', dismissed_by=$2, dismissed_at=NOW(), dismiss_reason=$3
      WHERE id=$1
    RETURNING *`,
    [id, userId || null, reason || null]
  );
  return r.rows[0] || null;
}

async function resolveItem(id, userId) {
  const r = await pool.query(
    `UPDATE manager_attention_items
        SET status='resolved', resolved_by=$2, resolved_at=NOW()
      WHERE id=$1
    RETURNING *`,
    [id, userId || null]
  );
  return r.rows[0] || null;
}

async function snoozeItem(id, untilIso) {
  const r = await pool.query(
    `UPDATE manager_attention_items
        SET status='snoozed', snoozed_until=$2
      WHERE id=$1
    RETURNING *`,
    [id, untilIso]
  );
  return r.rows[0] || null;
}

async function summary() {
  const r = await pool.query(`
    SELECT item_type, severity, COUNT(*)::int AS n
      FROM manager_attention_items
     WHERE status='open'
     GROUP BY item_type, severity`);
  return r.rows;
}

module.exports = {
  detectFromClassifications,
  detectRepeatComplaints,
  detectSlaBreaches,
  detectLowQualityReplies,
  runAll,
  listOpen,
  dismissItem,
  resolveItem,
  snoozeItem,
  summary,
};
