/**
 * Rep Quality Grader
 *
 * For every OUTBOUND archived message (rep reply), grade the response on
 * four axes from 1-5 each:
 *   - tone            (warm, professional, empathetic vs. terse/cold)
 *   - completeness    (did they fully answer the customer's question?)
 *   - accuracy        (did the answer look correct given context?)
 *   - followthrough   (clear next step, ETAs, links, attachments where needed)
 *
 * Plus free text strengths/weaknesses and a short coaching_note.
 *
 * Each grading call sends:
 *   - the most recent customer (inbound) message in the same thread
 *     (truncated)
 *   - the rep reply being graded
 *
 * Persists into email_archive_rep_grades. Tracks progress on
 * email_archive_runs (run_type='grade_backfill').
 */

const { pool } = require('../config/database');
const { getGenAI } = require('./ai-service');

const MODEL = 'gemini-2.5-flash';
const PRICE_INPUT_PER_M = 0.30;
const PRICE_OUTPUT_PER_M = 2.50;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'op'} timeout ${ms}ms`)), ms)),
  ]);
}

async function getConfig() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key='email_intelligence_config'`);
  return r.rows[0]?.value || {};
}

function buildBatchPrompt(items) {
  return `You are a customer-service quality coach for a sign / display / banner-stand
manufacturer. For each rep reply below, score it on FOUR axes from 1 (poor)
to 5 (excellent):

  - tone           : warm, professional, empathetic, customer-first
  - completeness   : does it actually answer the customer's question?
  - accuracy       : does the information look correct and consistent?
  - followthrough  : are next steps clear (ETA, link, attachment, owner)?

Also write strengths (what they did well), weaknesses (what to improve),
and a single-sentence coaching_note that a manager could send to the rep.

Return STRICT JSON ONLY: an array with the same length and order as the input.
Each element MUST be:
{
  "id": "<echo back the id>",
  "tone_score": 1-5,
  "completeness_score": 1-5,
  "accuracy_score": 1-5,
  "followthrough_score": 1-5,
  "strengths": "<1 sentence>",
  "weaknesses": "<1 sentence>",
  "coaching_note": "<1 sentence the rep can act on>"
}

Replies to grade:
${items.map((it, i) => `--- REPLY ${i + 1} (id: ${it.id}) ---
Rep: ${it.rep_name || it.rep_email || '(unknown rep)'}
Subject: ${it.subject || '(no subject)'}
Customer's prior message (most recent inbound on this thread, may be empty):
${(it.customer_text || '').slice(0, 1500)}

Rep's reply:
${(it.rep_text || '').slice(0, 2500)}
`).join('\n')}

Output: a JSON array of ${items.length} objects, in the same order.`;
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(5, v));
}

function normalizeRow(raw, expectedId) {
  const tone = clampScore(raw.tone_score);
  const comp = clampScore(raw.completeness_score);
  const acc = clampScore(raw.accuracy_score);
  const ft = clampScore(raw.followthrough_score);
  const overall = Number(((tone + comp + acc + ft) / 4).toFixed(2));
  return {
    id: expectedId,
    tone_score: tone,
    completeness_score: comp,
    accuracy_score: acc,
    followthrough_score: ft,
    overall_score: overall,
    strengths: (raw.strengths || '').toString().slice(0, 500),
    weaknesses: (raw.weaknesses || '').toString().slice(0, 500),
    coaching_note: (raw.coaching_note || '').toString().slice(0, 500),
  };
}

async function gradeBatch(items) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  const prompt = buildBatchPrompt(items);

  const result = await withTimeout(model.generateContent(prompt), 90_000, 'grade-batch');
  const text = result.response.text();
  let parsed = [];
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    const lb = text.indexOf('[');
    const rb = text.lastIndexOf(']');
    if (lb >= 0 && rb > lb) {
      try { parsed = JSON.parse(text.slice(lb, rb + 1)); } catch { parsed = []; }
    }
  }
  const byId = new Map();
  for (const r of parsed) if (r && r.id) byId.set(String(r.id), r);
  const normalized = items.map((it, i) => {
    const raw = byId.get(String(it.id)) || parsed[i] || {};
    return normalizeRow(raw, it.id);
  });
  const usage = result.response?.usageMetadata || {};
  return {
    rows: normalized,
    input_tokens: usage.promptTokenCount || 0,
    output_tokens: usage.candidatesTokenCount || 0,
  };
}

/** Pull a batch of ungraded outbound messages along with their thread context. */
async function fetchBatch({ batchSize = 30, mailbox = null } = {}) {
  const params = [];
  const conds = [
    "m.direction = 'outbound'",
    'm.body_text_clean IS NOT NULL',
    "length(m.body_text_clean) > 5",
    'NOT EXISTS (SELECT 1 FROM email_archive_rep_grades g WHERE g.message_id = m.id)',
  ];
  if (mailbox) {
    params.push(mailbox);
    conds.push(`m.mailbox_email = $${params.length}`);
  }
  // Find the most-recent inbound message on the same thread that came BEFORE this rep reply.
  const sql = `
    SELECT m.id, m.mailbox_email, m.subject, m.thread_id, m.sent_at,
           m.rep_email, m.rep_key, m.rep_name, m.body_text_clean AS rep_text,
           ( SELECT mi.body_text_clean
               FROM email_archive_messages mi
              WHERE mi.thread_id = m.thread_id
                AND mi.direction = 'inbound'
                AND mi.sent_at <= m.sent_at
              ORDER BY mi.sent_at DESC
              LIMIT 1 ) AS customer_text
      FROM email_archive_messages m
     WHERE ${conds.join(' AND ')}
     ORDER BY m.sent_at DESC
     LIMIT ${batchSize}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function persistGrades(rows, perRowTokens) {
  if (!rows.length) return;
  const placeholders = [];
  const values = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    values.push(
      r.message_id,
      r.mailbox_email,
      r.rep_email || null,
      r.rep_key || null,
      r.rep_name || null,
      r.tone_score,
      r.completeness_score,
      r.accuracy_score,
      r.followthrough_score,
      r.overall_score,
      r.strengths,
      r.weaknesses,
      r.coaching_note,
      MODEL,
      perRowTokens.input,
      perRowTokens.output,
    );
  }
  const sql = `INSERT INTO email_archive_rep_grades
    (message_id, mailbox_email, rep_email, rep_key, rep_name,
     tone_score, completeness_score, accuracy_score, followthrough_score,
     overall_score, strengths, weaknesses, coaching_note, model,
     input_tokens, output_tokens)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (message_id) DO UPDATE SET
      tone_score          = EXCLUDED.tone_score,
      completeness_score  = EXCLUDED.completeness_score,
      accuracy_score      = EXCLUDED.accuracy_score,
      followthrough_score = EXCLUDED.followthrough_score,
      overall_score       = EXCLUDED.overall_score,
      strengths           = EXCLUDED.strengths,
      weaknesses          = EXCLUDED.weaknesses,
      coaching_note       = EXCLUDED.coaching_note,
      graded_at           = NOW(),
      model               = EXCLUDED.model`;
  await pool.query(sql, values);
}

async function processOneBatch({ batchSize = 30, mailbox = null } = {}) {
  const rows = await fetchBatch({ batchSize, mailbox });
  if (!rows.length) return { processed: 0, errors: 0, input_tokens: 0, output_tokens: 0 };

  const items = rows.map(r => ({
    id: r.id,
    mailbox_email: r.mailbox_email,
    subject: r.subject,
    rep_name: r.rep_name,
    rep_email: r.rep_email,
    rep_text: r.rep_text,
    customer_text: r.customer_text,
  }));

  let result;
  try {
    result = await gradeBatch(items);
  } catch (e) {
    console.warn('[grader] batch failed:', e.message);
    return { processed: 0, errors: items.length, input_tokens: 0, output_tokens: 0, error: e.message };
  }

  const perRow = {
    input: Math.round((result.input_tokens || 0) / Math.max(items.length, 1)),
    output: Math.round((result.output_tokens || 0) / Math.max(items.length, 1)),
  };

  const persistRows = result.rows.map((g, i) => ({
    message_id: rows[i].id,
    mailbox_email: rows[i].mailbox_email,
    rep_email: rows[i].rep_email,
    rep_key: rows[i].rep_key,
    rep_name: rows[i].rep_name,
    ...g,
  }));

  try {
    await persistGrades(persistRows, perRow);
  } catch (e) {
    console.warn('[grader] persist failed:', e.message);
    return { processed: 0, errors: items.length, input_tokens: result.input_tokens, output_tokens: result.output_tokens, error: e.message };
  }

  return { processed: items.length, errors: 0, input_tokens: result.input_tokens, output_tokens: result.output_tokens };
}

async function pendingCount(mailbox = null) {
  const params = [];
  let where = `m.direction='outbound' AND m.body_text_clean IS NOT NULL AND length(m.body_text_clean) > 5
               AND NOT EXISTS (SELECT 1 FROM email_archive_rep_grades g WHERE g.message_id = m.id)`;
  if (mailbox) {
    params.push(mailbox);
    where += ` AND m.mailbox_email = $${params.length}`;
  }
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM email_archive_messages m WHERE ${where}`, params);
  return r.rows[0].n || 0;
}

async function runBackfill({ mailbox = null, userId = null } = {}) {
  const cfg = await getConfig();
  const batchSize = cfg.grader_batch_size || 30;

  const total = await pendingCount(mailbox);
  if (total === 0) {
    return { run_id: null, processed: 0, total: 0, message: 'Nothing to grade' };
  }

  const r0 = await pool.query(
    `INSERT INTO email_archive_runs
       (mailbox_email, run_type, status, total_threads, current_status_line,
        started_by_user_id)
     VALUES ($1, 'grade_backfill', 'running', $2, $3, $4)
     RETURNING *`,
    [mailbox || 'multi', total, `Grading ${total} rep replies…`, userId]
  );
  const runId = r0.rows[0].id;

  (async () => {
    let processed = 0, errors = 0, inputTokens = 0, outputTokens = 0;
    const start = Date.now();
    try {
      while (true) {
        const cancelCheck = await pool.query(`SELECT cancel_requested FROM email_archive_runs WHERE id=$1`, [runId]);
        if (cancelCheck.rows[0]?.cancel_requested) {
          await pool.query(
            `UPDATE email_archive_runs SET status='cancelled', completed_at=NOW(),
                current_status_line=$2 WHERE id=$1`,
            [runId, `Cancelled at ${processed}/${total}`]
          );
          return;
        }

        const res = await processOneBatch({ batchSize, mailbox });
        if (res.processed === 0 && res.errors === 0) break;
        processed += res.processed;
        errors += res.errors;
        inputTokens += res.input_tokens || 0;
        outputTokens += res.output_tokens || 0;

        const pct = total ? (processed / total) * 100 : 100;
        const elapsed = (Date.now() - start) / 1000;
        const rate = processed / Math.max(elapsed, 1);
        const eta = rate > 0 ? Math.round((total - processed) / rate) : null;
        const cost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_M
                   + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;

        await pool.query(
          `UPDATE email_archive_runs
              SET processed_count=$2, error_count=$3, progress_percent=$4,
                  eta_seconds=$5,
                  grade_input_tokens=COALESCE(grade_input_tokens,0)+$6,
                  grade_output_tokens=COALESCE(grade_output_tokens,0)+$7,
                  grade_cost_usd=COALESCE(grade_cost_usd,0)+$8,
                  current_status_line=$9
            WHERE id=$1`,
          [
            runId, processed, errors, Number(pct.toFixed(2)),
            eta,
            res.input_tokens || 0, res.output_tokens || 0,
            Number(((res.input_tokens / 1_000_000) * PRICE_INPUT_PER_M
                  + (res.output_tokens / 1_000_000) * PRICE_OUTPUT_PER_M).toFixed(6)),
            `Graded ${processed}/${total}  ($${cost.toFixed(4)} so far)`,
          ]
        );
        if (res.processed === 0) break;
      }
      const totalCost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_M
                      + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
      await pool.query(
        `UPDATE email_archive_runs
            SET status='complete', completed_at=NOW(),
                processed_count=$2, error_count=$3, progress_percent=100,
                current_status_line=$4
          WHERE id=$1`,
        [runId, processed, errors, `Done · ${processed} graded · $${totalCost.toFixed(4)}`]
      );
    } catch (e) {
      console.error('[grader] backfill error:', e);
      await pool.query(
        `UPDATE email_archive_runs SET status='failed', completed_at=NOW(), last_error=$2 WHERE id=$1`,
        [runId, e.message]
      );
    }
  })().catch(e => console.error('[grader] background error:', e));

  return { run_id: runId, total, processed: 0 };
}

async function cronTick() {
  const cfg = await getConfig();
  if (cfg.enable_quality_grader === false) return { skipped: true };
  const batchSize = cfg.grader_batch_size || 30;
  try {
    const res = await processOneBatch({ batchSize });
    if (res.processed > 0) {
      console.log(`[grader] tick: ${res.processed} graded (${res.errors} errors)`);
    }
    return res;
  } catch (e) {
    console.warn('[grader] cron tick error:', e.message);
    return { error: e.message };
  }
}

module.exports = {
  MODEL,
  gradeBatch,
  processOneBatch,
  pendingCount,
  runBackfill,
  cronTick,
};
