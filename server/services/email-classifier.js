/**
 * Email Classifier Service
 *
 * Runs every few minutes (or as a one-shot backfill). For every archived
 * INBOUND message that does not yet have a row in email_archive_classifications,
 * sends it through Gemini 2.5 Flash for structured classification:
 *   - product_line   (free-form normalized slug)
 *   - question_type  (fixed taxonomy)
 *   - sentiment      (positive | neutral | negative)
 *   - is_complaint   (boolean)
 *   - asks_for_manager (boolean)
 *   - is_damage_claim (boolean)
 *   - canonical_question (1-2 sentence rewording)
 *   - keywords[]      (small bag of words for grouping)
 *   - confidence      (0..1)
 *
 * Batch model: we ship N messages in a single prompt and parse a JSON array
 * back. This is dramatically cheaper/faster than one call per message.
 *
 * Progress is tracked on email_archive_runs (run_type = 'classify_backfill').
 */

const { pool } = require('../config/database');
const { getGenAI } = require('./ai-service');

const MODEL = 'gemini-2.5-flash';

// Approx pricing (USD per 1M tokens) — adjust if Google changes prices.
const PRICE_INPUT_PER_M = 0.30;
const PRICE_OUTPUT_PER_M = 2.50;

const ALLOWED_QUESTION_TYPES = [
  'pricing_quote',
  'turnaround_time',
  'file_specs',
  'shipping',
  'design_help',
  'customization',
  'returns',
  'installation',
  'sample_request',
  'order_status',
  'reorder',
  'product_question',
  'complaint',
  'damage_claim',
  'other',
];

const ALLOWED_SENTIMENT = ['positive', 'neutral', 'negative'];

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

/** Build the JSON-array prompt for a batch of messages. */
function buildBatchPrompt(items) {
  const guidance = `You are an expert customer-service analyst for a sign / display / banner-stand
manufacturer (wsmail / WSDisplay / SDSign). For each customer email below,
return a structured classification.

Return STRICT JSON only — an array with the same length and order as the input.
Each element MUST have this exact shape:
{
  "id": "<echo back the id>",
  "product_line": "<short snake_case slug, e.g. retractable_banner_stand, table_throw, x_stand, hardware_replacement_part, custom_print, unknown>",
  "question_type": "<one of: ${ALLOWED_QUESTION_TYPES.join(', ')}>",
  "sentiment": "<one of: ${ALLOWED_SENTIMENT.join(', ')}>",
  "is_complaint": <true|false>,
  "asks_for_manager": <true|false>,
  "is_damage_claim": <true|false>,
  "canonical_question": "<1-2 sentence rewording of the customer's actual question>",
  "keywords": ["<3-6 short keywords>"],
  "confidence": <0..1>
}

Rules:
- product_line should be a normalized slug. If the email mentions multiple
  products, pick the primary one. If unclear, return "unknown".
- question_type MUST be one of the allowed values exactly.
- "is_complaint" is true only for actual complaint signal (frustration,
  problem with product/service). Negative sentiment alone is NOT a complaint.
- "asks_for_manager" is true if the customer requests escalation, a
  supervisor, manager, owner, or threatens reviews/chargebacks.
- "is_damage_claim" is true if customer reports product arrived damaged,
  broken, or defective on arrival.
- "canonical_question" should be the QUESTION the customer is actually asking,
  rewritten in clean plain English. If they're not asking a question, write
  a 1-sentence summary of their need.
- keywords are short (1-3 words each). No duplicates.

Emails to classify:
${items.map((it, i) => `--- EMAIL ${i + 1} (id: ${it.id}) ---
Subject: ${it.subject || '(no subject)'}
From: ${it.from_email || ''}
Body:
${(it.body || '').slice(0, 3500)}
`).join('\n')}

Output: a JSON array of ${items.length} objects, in the same order.`;

  return guidance;
}

function safeLower(s) { return (s || '').toString().toLowerCase().trim(); }

function normalizeRow(raw, expectedId) {
  const out = {
    id: expectedId,
    product_line: safeLower(raw.product_line) || 'unknown',
    question_type: ALLOWED_QUESTION_TYPES.includes(safeLower(raw.question_type))
      ? safeLower(raw.question_type) : 'other',
    sentiment: ALLOWED_SENTIMENT.includes(safeLower(raw.sentiment))
      ? safeLower(raw.sentiment) : 'neutral',
    is_complaint: !!raw.is_complaint,
    asks_for_manager: !!raw.asks_for_manager,
    is_damage_claim: !!raw.is_damage_claim,
    canonical_question: (raw.canonical_question || '').toString().slice(0, 500),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(k => safeLower(k)).filter(Boolean).slice(0, 8) : [],
    confidence: typeof raw.confidence === 'number'
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.5,
  };
  return out;
}

/** Call Gemini for a batch and return parsed objects + token usage. */
async function classifyBatch(items) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });

  const prompt = buildBatchPrompt(items);

  const result = await withTimeout(model.generateContent(prompt), 90_000, 'classify-batch');
  const text = result.response.text();

  let parsed = [];
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) parsed = [];
  } catch (e) {
    // Try to recover: find first '[' and last ']' and parse
    const lb = text.indexOf('[');
    const rb = text.lastIndexOf(']');
    if (lb >= 0 && rb > lb) {
      try { parsed = JSON.parse(text.slice(lb, rb + 1)); } catch { parsed = []; }
    }
  }

  // Map by echoed id; fall back to positional alignment
  const byId = new Map();
  for (const r of parsed) {
    if (r && r.id) byId.set(String(r.id), r);
  }
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

/** Insert classification rows. Idempotent via PRIMARY KEY on message_id. */
async function persistClassifications(rows, perRowTokens) {
  if (!rows.length) return;
  const values = [];
  const placeholders = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    values.push(
      r.message_id,
      r.mailbox_email,
      r.product_line,
      r.question_type,
      r.sentiment,
      r.is_complaint,
      r.asks_for_manager,
      r.is_damage_claim,
      r.canonical_question,
      r.keywords,
      r.confidence,
      MODEL,
      perRowTokens.input,
      perRowTokens.output,
    );
  }
  const sql = `INSERT INTO email_archive_classifications
    (message_id, mailbox_email, product_line, question_type, sentiment,
     is_complaint, asks_for_manager, is_damage_claim, canonical_question,
     keywords, confidence, model, input_tokens, output_tokens)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (message_id) DO UPDATE SET
      product_line       = EXCLUDED.product_line,
      question_type      = EXCLUDED.question_type,
      sentiment          = EXCLUDED.sentiment,
      is_complaint       = EXCLUDED.is_complaint,
      asks_for_manager   = EXCLUDED.asks_for_manager,
      is_damage_claim    = EXCLUDED.is_damage_claim,
      canonical_question = EXCLUDED.canonical_question,
      keywords           = EXCLUDED.keywords,
      confidence         = EXCLUDED.confidence,
      classified_at      = NOW(),
      model              = EXCLUDED.model`;
  await pool.query(sql, values);
}

/**
 * Pull a batch of unclassified inbound messages and classify them.
 * Returns counts. Used both by the cron and by the run-loop.
 */
async function processOneBatch({ batchSize = 30, mailbox = null, skipSubjects = [] } = {}) {
  const params = [];
  const conds = [
    'm.direction = $1',
    'm.body_text_clean IS NOT NULL',
    "length(m.body_text_clean) > 5",
    'NOT EXISTS (SELECT 1 FROM email_archive_classifications c WHERE c.message_id = m.id)',
  ];
  params.push('inbound');

  if (mailbox) {
    params.push(mailbox);
    conds.push(`m.mailbox_email = $${params.length}`);
  }
  if (skipSubjects && skipSubjects.length) {
    const ors = [];
    for (const s of skipSubjects) {
      params.push(`%${s}%`);
      ors.push(`LOWER(COALESCE(m.subject,'')) LIKE LOWER($${params.length})`);
    }
    if (ors.length) conds.push(`NOT (${ors.join(' OR ')})`);
  }

  const sql = `SELECT m.id, m.mailbox_email, m.subject, m.from_email, m.body_text_clean
                 FROM email_archive_messages m
                WHERE ${conds.join(' AND ')}
                ORDER BY m.sent_at DESC
                LIMIT ${batchSize}`;
  const r = await pool.query(sql, params);
  if (!r.rows.length) return { processed: 0, errors: 0, input_tokens: 0, output_tokens: 0 };

  const items = r.rows.map(row => ({
    id: row.id,
    mailbox_email: row.mailbox_email,
    subject: row.subject,
    from_email: row.from_email,
    body: row.body_text_clean,
  }));

  let result;
  try {
    result = await classifyBatch(items);
  } catch (e) {
    console.warn('[classifier] batch failed:', e.message);
    return { processed: 0, errors: items.length, input_tokens: 0, output_tokens: 0, error: e.message };
  }

  const perRow = {
    input: Math.round((result.input_tokens || 0) / Math.max(items.length, 1)),
    output: Math.round((result.output_tokens || 0) / Math.max(items.length, 1)),
  };

  // Build persistence rows by zipping with the source items (so we have mailbox_email)
  const persistRows = result.rows.map((c, i) => ({
    message_id: items[i].id,
    mailbox_email: items[i].mailbox_email,
    ...c,
  }));

  try {
    await persistClassifications(persistRows, perRow);
  } catch (e) {
    console.warn('[classifier] persist failed:', e.message);
    return { processed: 0, errors: items.length, input_tokens: result.input_tokens, output_tokens: result.output_tokens, error: e.message };
  }

  return {
    processed: items.length,
    errors: 0,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
  };
}

/** How many messages still need classification? */
async function pendingCount(mailbox = null) {
  const params = [];
  let where = `m.direction = 'inbound' AND m.body_text_clean IS NOT NULL AND length(m.body_text_clean) > 5
               AND NOT EXISTS (SELECT 1 FROM email_archive_classifications c WHERE c.message_id = m.id)`;
  if (mailbox) {
    params.push(mailbox);
    where += ` AND m.mailbox_email = $${params.length}`;
  }
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM email_archive_messages m WHERE ${where}`, params);
  return r.rows[0].n || 0;
}

/**
 * Long-running backfill: keep processing batches until none are left.
 * Tracks progress on email_archive_runs (run_type='classify_backfill').
 */
async function runBackfill({ mailbox = null, userId = null } = {}) {
  const cfg = await getConfig();
  const batchSize = cfg.classifier_batch_size || 30;
  const skipSubjects = cfg.skip_subjects || [];

  const total = await pendingCount(mailbox);
  if (total === 0) {
    return { run_id: null, processed: 0, total: 0, message: 'Nothing to classify' };
  }

  const r0 = await pool.query(
    `INSERT INTO email_archive_runs
       (mailbox_email, run_type, status, total_threads, current_status_line,
        started_by_user_id)
     VALUES ($1, 'classify_backfill', 'running', $2, $3, $4)
     RETURNING *`,
    [mailbox || 'multi', total, `Classifying ${total} messages…`, userId]
  );
  const run = r0.rows[0];
  const runId = run.id;

  // Background loop
  (async () => {
    let processed = 0;
    let errors = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const start = Date.now();
    try {
      while (true) {
        const cancelCheck = await pool.query(`SELECT cancel_requested FROM email_archive_runs WHERE id = $1`, [runId]);
        if (cancelCheck.rows[0]?.cancel_requested) {
          await pool.query(
            `UPDATE email_archive_runs
                SET status='cancelled', completed_at=NOW(),
                    current_status_line=$2
              WHERE id=$1`,
            [runId, `Cancelled at ${processed}/${total}`]
          );
          return;
        }

        const res = await processOneBatch({ batchSize, mailbox, skipSubjects });
        if (res.processed === 0 && res.errors === 0) break; // empty
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
                  classify_input_tokens=COALESCE(classify_input_tokens,0)+$6,
                  classify_output_tokens=COALESCE(classify_output_tokens,0)+$7,
                  classify_cost_usd=COALESCE(classify_cost_usd,0)+$8,
                  current_status_line=$9
            WHERE id=$1`,
          [
            runId, processed, errors, Number(pct.toFixed(2)),
            eta,
            res.input_tokens || 0, res.output_tokens || 0,
            Number(((res.input_tokens / 1_000_000) * PRICE_INPUT_PER_M
                  + (res.output_tokens / 1_000_000) * PRICE_OUTPUT_PER_M).toFixed(6)),
            `Classified ${processed}/${total}  ($${cost.toFixed(4)} so far)`,
          ]
        );

        if (res.processed === 0) break; // nothing left
      }

      const totalCost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_M
                      + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
      await pool.query(
        `UPDATE email_archive_runs
            SET status='complete', completed_at=NOW(),
                processed_count=$2, error_count=$3, progress_percent=100,
                current_status_line=$4
          WHERE id=$1`,
        [runId, processed, errors, `Done · ${processed} classified · $${totalCost.toFixed(4)}`]
      );
    } catch (e) {
      console.error('[classifier] backfill error:', e);
      await pool.query(
        `UPDATE email_archive_runs SET status='failed', completed_at=NOW(), last_error=$2 WHERE id=$1`,
        [runId, e.message]
      );
    }
  })().catch(e => console.error('[classifier] background error:', e));

  return { run_id: runId, total, processed: 0 };
}

/** Lightweight cron tick: process up to batch_size messages and stop. */
async function cronTick() {
  const cfg = await getConfig();
  if (cfg.enable_classifier === false) return { skipped: true };
  const batchSize = cfg.classifier_batch_size || 30;
  const skipSubjects = cfg.skip_subjects || [];
  try {
    const res = await processOneBatch({ batchSize, skipSubjects });
    if (res.processed > 0) {
      console.log(`[classifier] tick: ${res.processed} classified (${res.errors} errors)`);
    }
    return res;
  } catch (e) {
    console.warn('[classifier] cron tick error:', e.message);
    return { error: e.message };
  }
}

module.exports = {
  MODEL,
  ALLOWED_QUESTION_TYPES,
  ALLOWED_SENTIMENT,
  classifyBatch,
  processOneBatch,
  pendingCount,
  runBackfill,
  cronTick,
};
