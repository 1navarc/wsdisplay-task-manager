/**
 * Email Intelligence — aggregations + suggesters
 *
 * Phase 4: top-questions aggregator (read-only queries)
 * Phase 5: faq-suggester (clusters similar canonical_questions per
 *          product/question_type and asks Gemini to draft a Q/A pair from
 *          the actual rep replies)
 * Phase 6: training-suggester (drafts canned-response templates with
 *          {{placeholders}} for the AI training mailbox)
 * Phase 7: heatmap (read-only product × hour-of-day matrix)
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

/* ---------------------------------------------------------------------------
 * Phase 4 — Top questions
 * ------------------------------------------------------------------------- */

/** Top question_type rows with counts and sample subject lines. */
async function topQuestions({ days = 30, productLine = null, mailbox = null, limit = 20 } = {}) {
  const params = [String(days)];
  const conds = [`m.sent_at >= NOW() - ($1 || ' days')::interval`, `m.direction='inbound'`];
  if (productLine) { params.push(productLine); conds.push(`c.product_line = $${params.length}`); }
  if (mailbox)     { params.push(mailbox);     conds.push(`m.mailbox_email = $${params.length}`); }
  params.push(limit);
  const r = await pool.query(`
    SELECT c.product_line,
           c.question_type,
           COUNT(*)::int AS volume,
           SUM(CASE WHEN c.is_complaint THEN 1 ELSE 0 END)::int AS complaint_count,
           SUM(CASE WHEN c.sentiment='negative' THEN 1 ELSE 0 END)::int AS negative_count,
           (ARRAY_AGG(c.canonical_question ORDER BY m.sent_at DESC))[1:5] AS sample_questions,
           (ARRAY_AGG(m.subject ORDER BY m.sent_at DESC))[1:5] AS sample_subjects,
           (ARRAY_AGG(m.id ORDER BY m.sent_at DESC))[1:10] AS sample_message_ids,
           MAX(m.sent_at) AS last_seen
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE ${conds.join(' AND ')}
     GROUP BY c.product_line, c.question_type
     ORDER BY volume DESC
     LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

/** Heatmap: product_line × hour-of-day for the last N days. */
async function productHourHeatmap({ days = 30, mailbox = null } = {}) {
  const params = [String(days)];
  const conds = [`m.sent_at >= NOW() - ($1 || ' days')::interval`, `m.direction='inbound'`];
  if (mailbox) { params.push(mailbox); conds.push(`m.mailbox_email = $${params.length}`); }
  const r = await pool.query(`
    SELECT c.product_line,
           EXTRACT(HOUR FROM m.sent_at)::int AS hour,
           COUNT(*)::int AS volume
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE ${conds.join(' AND ')}
     GROUP BY c.product_line, hour
     ORDER BY c.product_line, hour`, params);
  return r.rows;
}

/** Day-of-week × hour heatmap (overall volume). */
async function dowHourHeatmap({ days = 30, mailbox = null } = {}) {
  const params = [String(days)];
  const conds = [`m.sent_at >= NOW() - ($1 || ' days')::interval`, `m.direction='inbound'`];
  if (mailbox) { params.push(mailbox); conds.push(`m.mailbox_email = $${params.length}`); }
  const r = await pool.query(`
    SELECT EXTRACT(DOW FROM m.sent_at)::int AS dow,
           EXTRACT(HOUR FROM m.sent_at)::int AS hour,
           COUNT(*)::int AS volume
      FROM email_archive_messages m
     WHERE ${conds.join(' AND ')}
     GROUP BY dow, hour
     ORDER BY dow, hour`, params);
  return r.rows;
}

/* ---------------------------------------------------------------------------
 * Phase 5 — FAQ suggester
 *
 * Strategy: group inbound messages by (product_line, question_type) over the
 * last N days. For each group with >= min cluster size, pull up to K sample
 * (question, rep_reply) pairs and ask Gemini to synthesize one canonical
 * Q/A. Insert into faq_candidates (status='pending') for human review.
 * ------------------------------------------------------------------------- */

async function fetchFaqClusters({ days = 90, minCluster = 5, limit = 50 }) {
  const r = await pool.query(`
    SELECT c.product_line, c.question_type,
           COUNT(*)::int AS volume,
           ARRAY_AGG(c.message_id ORDER BY m.sent_at DESC) AS message_ids
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE m.sent_at >= NOW() - ($1 || ' days')::interval
       AND m.direction='inbound'
       AND c.product_line IS NOT NULL AND c.product_line <> 'unknown'
       AND c.question_type IS NOT NULL AND c.question_type <> 'other'
       AND NOT EXISTS (
         SELECT 1 FROM faq_candidates fc
          WHERE fc.product_line = c.product_line
            AND fc.question_type = c.question_type
            AND fc.status IN ('pending','approved','exported')
            AND fc.drafted_at >= NOW() - INTERVAL '14 days'
       )
     GROUP BY c.product_line, c.question_type
    HAVING COUNT(*) >= $2
     ORDER BY volume DESC
     LIMIT $3`,
    [String(days), minCluster, limit]
  );
  return r.rows;
}

/** For a single cluster, pick K (customer-question, rep-reply) sample pairs. */
async function clusterSamples(messageIds, k = 8) {
  const r = await pool.query(`
    SELECT m.id, m.subject, m.body_text_clean AS customer_text,
           ( SELECT mo.body_text_clean
               FROM email_archive_messages mo
              WHERE mo.thread_id = m.thread_id
                AND mo.direction = 'outbound'
                AND mo.sent_at > m.sent_at
              ORDER BY mo.sent_at ASC
              LIMIT 1 ) AS rep_reply
      FROM email_archive_messages m
     WHERE m.id = ANY($1::uuid[])
     ORDER BY m.sent_at DESC
     LIMIT $2`, [messageIds.slice(0, k * 2), k]);
  return r.rows.filter(row => (row.rep_reply || '').length > 20);
}

async function draftFaqForCluster(cluster) {
  const samples = await clusterSamples(cluster.message_ids, 8);
  if (!samples.length) return null;

  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  });

  const prompt = `You are drafting a website FAQ entry for a sign / display / banner-stand
manufacturer. Below are real customer questions about the product line
"${cluster.product_line}" of question type "${cluster.question_type}", with
how our reps actually answered them.

Synthesize ONE canonical FAQ entry that would correctly answer 80%+ of these
customers, using the real answers as ground truth. Do NOT invent facts.

Return STRICT JSON:
{
  "question": "<plain-English customer-voice question, 5-25 words>",
  "suggested_answer": "<crisp 60-200 word answer, plain text, no markdown>",
  "score": <0..100 — your confidence that this would be a good FAQ entry>,
  "notes": "<optional: anything reviewer should know>"
}

Examples:
${samples.map((s, i) => `--- EXAMPLE ${i + 1} ---
Subject: ${s.subject || '(no subject)'}
Customer: ${(s.customer_text || '').slice(0, 1200)}
Rep reply: ${(s.rep_reply || '').slice(0, 1500)}
`).join('\n')}`;

  const result = await withTimeout(model.generateContent(prompt), 60_000, 'faq-draft');
  const text = result.response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const lb = text.indexOf('{'); const rb = text.lastIndexOf('}');
    if (lb >= 0 && rb > lb) { try { parsed = JSON.parse(text.slice(lb, rb + 1)); } catch {} }
  }
  if (!parsed || !parsed.question || !parsed.suggested_answer) return null;

  const usage = result.response?.usageMetadata || {};
  const cost = (usage.promptTokenCount || 0) / 1_000_000 * PRICE_INPUT_PER_M
             + (usage.candidatesTokenCount || 0) / 1_000_000 * PRICE_OUTPUT_PER_M;

  return {
    product_line: cluster.product_line,
    question_type: cluster.question_type,
    question: String(parsed.question).slice(0, 500),
    suggested_answer: String(parsed.suggested_answer).slice(0, 4000),
    source_count: cluster.volume,
    source_message_ids: samples.map(s => s.id),
    score: typeof parsed.score === 'number' ? parsed.score : 50,
    cost,
    input_tokens: usage.promptTokenCount || 0,
    output_tokens: usage.candidatesTokenCount || 0,
  };
}

async function runFaqSuggester({ userId = null } = {}) {
  const cfg = await getConfig();
  const minCluster = cfg.faq_min_cluster_size || 5;

  const clusters = await fetchFaqClusters({ days: 90, minCluster });
  if (!clusters.length) return { run_id: null, drafted: 0, message: 'No new FAQ clusters' };

  const r0 = await pool.query(
    `INSERT INTO email_archive_runs
       (mailbox_email, run_type, status, total_threads, current_status_line, started_by_user_id)
     VALUES ('multi','faq_suggest','running',$1,$2,$3) RETURNING id`,
    [clusters.length, `Drafting FAQ candidates for ${clusters.length} clusters…`, userId]
  );
  const runId = r0.rows[0].id;

  (async () => {
    let drafted = 0, errors = 0, inputT = 0, outputT = 0;
    try {
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        try {
          const draft = await draftFaqForCluster(c);
          if (draft) {
            await pool.query(
              `INSERT INTO faq_candidates
                 (product_line, question_type, question, suggested_answer,
                  source_count, source_message_ids, drafted_by_model, score)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [draft.product_line, draft.question_type, draft.question,
               draft.suggested_answer, draft.source_count, draft.source_message_ids,
               MODEL, draft.score]
            );
            drafted++;
            inputT += draft.input_tokens; outputT += draft.output_tokens;
          }
        } catch (e) {
          errors++;
          console.warn('[faq] cluster failed:', e.message);
        }
        const cost = (inputT / 1_000_000) * PRICE_INPUT_PER_M
                   + (outputT / 1_000_000) * PRICE_OUTPUT_PER_M;
        await pool.query(
          `UPDATE email_archive_runs
              SET processed_count=$2, error_count=$3,
                  progress_percent=$4,
                  suggest_input_tokens=$5, suggest_output_tokens=$6,
                  suggest_cost_usd=$7,
                  current_status_line=$8
            WHERE id=$1`,
          [runId, i + 1, errors,
           Number((((i + 1) / clusters.length) * 100).toFixed(2)),
           inputT, outputT, Number(cost.toFixed(6)),
           `FAQ ${i + 1}/${clusters.length} · ${drafted} drafted · $${cost.toFixed(4)}`]
        );
      }
      const totalCost = (inputT / 1_000_000) * PRICE_INPUT_PER_M
                      + (outputT / 1_000_000) * PRICE_OUTPUT_PER_M;
      await pool.query(
        `UPDATE email_archive_runs SET status='complete', completed_at=NOW(),
            progress_percent=100, current_status_line=$2 WHERE id=$1`,
        [runId, `Done · ${drafted} FAQ drafts · $${totalCost.toFixed(4)}`]
      );
    } catch (e) {
      console.error('[faq] suggester error:', e);
      await pool.query(
        `UPDATE email_archive_runs SET status='failed', completed_at=NOW(), last_error=$2 WHERE id=$1`,
        [runId, e.message]
      );
    }
  })().catch(e => console.error('[faq] background error:', e));

  return { run_id: runId, total: clusters.length };
}

/* ---------------------------------------------------------------------------
 * Phase 6 — Training-mailbox suggester
 *
 * Same shape as FAQ but we ask Gemini for a "trigger_question" + a
 * canned-response template with {{placeholders}}. Higher cluster threshold
 * because canned responses should be high-frequency.
 * ------------------------------------------------------------------------- */

async function fetchTrainingClusters({ days = 90, minCluster = 10, limit = 30 }) {
  const r = await pool.query(`
    SELECT c.product_line, c.question_type,
           COUNT(*)::int AS volume,
           ARRAY_AGG(c.message_id ORDER BY m.sent_at DESC) AS message_ids
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE m.sent_at >= NOW() - ($1 || ' days')::interval
       AND m.direction='inbound'
       AND c.product_line IS NOT NULL AND c.product_line <> 'unknown'
       AND c.question_type IS NOT NULL AND c.question_type <> 'other'
       AND NOT EXISTS (
         SELECT 1 FROM ai_training_candidates tc
          WHERE tc.product_line = c.product_line
            AND tc.question_type = c.question_type
            AND tc.status IN ('pending','approved','applied')
            AND tc.drafted_at >= NOW() - INTERVAL '14 days'
       )
     GROUP BY c.product_line, c.question_type
    HAVING COUNT(*) >= $2
     ORDER BY volume DESC
     LIMIT $3`,
    [String(days), minCluster, limit]
  );
  return r.rows;
}

async function draftTrainingForCluster(cluster) {
  const samples = await clusterSamples(cluster.message_ids, 10);
  if (!samples.length) return null;

  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  });

  const prompt = `You are designing a CANNED RESPONSE TEMPLATE that an AI assistant can
use to reply to common customer emails about a sign / display / banner-stand
manufacturer's product.

Product line: ${cluster.product_line}
Question type: ${cluster.question_type}

Below are real examples of how customers asked, and how reps replied. Build:
1. A "trigger_question" — a generic version of the customer's question, in
   their voice, that would match similar future emails.
2. A "suggested_response" — the canned reply the AI should send. Use
   {{placeholders}} for anything that varies per customer (customer_name,
   order_number, ETA, tracking_link, attachment_filename, etc.). Plain text,
   no markdown, friendly + professional.
3. "placeholders" — array of placeholder names you used (without braces).
4. "score" — 0..100, your confidence this template would safely auto-reply.

Return STRICT JSON:
{
  "trigger_question": "...",
  "suggested_response": "...",
  "placeholders": ["customer_name","order_number"],
  "score": 75
}

Examples:
${samples.map((s, i) => `--- EXAMPLE ${i + 1} ---
Subject: ${s.subject || '(no subject)'}
Customer: ${(s.customer_text || '').slice(0, 1200)}
Rep: ${(s.rep_reply || '').slice(0, 1500)}
`).join('\n')}`;

  const result = await withTimeout(model.generateContent(prompt), 60_000, 'training-draft');
  const text = result.response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const lb = text.indexOf('{'); const rb = text.lastIndexOf('}');
    if (lb >= 0 && rb > lb) { try { parsed = JSON.parse(text.slice(lb, rb + 1)); } catch {} }
  }
  if (!parsed || !parsed.trigger_question || !parsed.suggested_response) return null;

  const usage = result.response?.usageMetadata || {};
  return {
    product_line: cluster.product_line,
    question_type: cluster.question_type,
    trigger_question: String(parsed.trigger_question).slice(0, 500),
    suggested_response: String(parsed.suggested_response).slice(0, 6000),
    placeholders: Array.isArray(parsed.placeholders)
      ? parsed.placeholders.map(p => String(p)).slice(0, 20) : [],
    matched_email_count: cluster.volume,
    source_message_ids: samples.map(s => s.id),
    score: typeof parsed.score === 'number' ? parsed.score : 50,
    input_tokens: usage.promptTokenCount || 0,
    output_tokens: usage.candidatesTokenCount || 0,
  };
}

async function runTrainingSuggester({ userId = null } = {}) {
  const cfg = await getConfig();
  const minCluster = cfg.training_min_cluster_size || 10;

  const clusters = await fetchTrainingClusters({ days: 90, minCluster });
  if (!clusters.length) return { run_id: null, drafted: 0, message: 'No new training clusters' };

  const r0 = await pool.query(
    `INSERT INTO email_archive_runs
       (mailbox_email, run_type, status, total_threads, current_status_line, started_by_user_id)
     VALUES ('multi','training_suggest','running',$1,$2,$3) RETURNING id`,
    [clusters.length, `Drafting training candidates for ${clusters.length} clusters…`, userId]
  );
  const runId = r0.rows[0].id;

  (async () => {
    let drafted = 0, errors = 0, inputT = 0, outputT = 0;
    try {
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        try {
          const draft = await draftTrainingForCluster(c);
          if (draft) {
            await pool.query(
              `INSERT INTO ai_training_candidates
                 (product_line, question_type, trigger_question, suggested_response,
                  placeholders, matched_email_count, source_message_ids,
                  drafted_by_model, score)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [draft.product_line, draft.question_type, draft.trigger_question,
               draft.suggested_response, draft.placeholders, draft.matched_email_count,
               draft.source_message_ids, MODEL, draft.score]
            );
            drafted++;
            inputT += draft.input_tokens; outputT += draft.output_tokens;
          }
        } catch (e) {
          errors++;
          console.warn('[training] cluster failed:', e.message);
        }
        const cost = (inputT / 1_000_000) * PRICE_INPUT_PER_M
                   + (outputT / 1_000_000) * PRICE_OUTPUT_PER_M;
        await pool.query(
          `UPDATE email_archive_runs
              SET processed_count=$2, error_count=$3, progress_percent=$4,
                  suggest_input_tokens=$5, suggest_output_tokens=$6, suggest_cost_usd=$7,
                  current_status_line=$8
            WHERE id=$1`,
          [runId, i + 1, errors,
           Number((((i + 1) / clusters.length) * 100).toFixed(2)),
           inputT, outputT, Number(cost.toFixed(6)),
           `Training ${i + 1}/${clusters.length} · ${drafted} drafted · $${cost.toFixed(4)}`]
        );
      }
      const totalCost = (inputT / 1_000_000) * PRICE_INPUT_PER_M
                      + (outputT / 1_000_000) * PRICE_OUTPUT_PER_M;
      await pool.query(
        `UPDATE email_archive_runs SET status='complete', completed_at=NOW(),
            progress_percent=100, current_status_line=$2 WHERE id=$1`,
        [runId, `Done · ${drafted} training drafts · $${totalCost.toFixed(4)}`]
      );
    } catch (e) {
      console.error('[training] suggester error:', e);
      await pool.query(
        `UPDATE email_archive_runs SET status='failed', completed_at=NOW(), last_error=$2 WHERE id=$1`,
        [runId, e.message]
      );
    }
  })().catch(e => console.error('[training] background error:', e));

  return { run_id: runId, total: clusters.length };
}

/* ---------------------------------------------------------------------------
 * Read-only queries for the UI
 * ------------------------------------------------------------------------- */

async function listFaqCandidates({ status = 'pending', limit = 100 } = {}) {
  const r = await pool.query(
    `SELECT * FROM faq_candidates
      WHERE status = $1
      ORDER BY score DESC NULLS LAST, drafted_at DESC
      LIMIT $2`,
    [status, limit]
  );
  return r.rows;
}

async function reviewFaqCandidate(id, action, userId, note) {
  const status = action === 'approve' ? 'approved' :
                 action === 'reject'  ? 'rejected' :
                 action === 'export'  ? 'exported' : 'pending';
  const r = await pool.query(
    `UPDATE faq_candidates
        SET status=$2, reviewed_by=$3, reviewed_at=NOW(), review_note=$4
      WHERE id=$1
    RETURNING *`,
    [id, status, userId || null, note || null]
  );
  return r.rows[0] || null;
}

async function listTrainingCandidates({ status = 'pending', limit = 100 } = {}) {
  const r = await pool.query(
    `SELECT * FROM ai_training_candidates
      WHERE status = $1
      ORDER BY score DESC NULLS LAST, drafted_at DESC
      LIMIT $2`,
    [status, limit]
  );
  return r.rows;
}

async function reviewTrainingCandidate(id, action, userId, note) {
  const status = action === 'approve' ? 'approved' :
                 action === 'reject'  ? 'rejected' :
                 action === 'apply'   ? 'applied'  : 'pending';
  const setApplied = status === 'applied' ? ', applied_at=NOW()' : '';
  const r = await pool.query(
    `UPDATE ai_training_candidates
        SET status=$2, reviewed_by=$3, reviewed_at=NOW(), review_note=$4 ${setApplied}
      WHERE id=$1
    RETURNING *`,
    [id, status, userId || null, note || null]
  );
  return r.rows[0] || null;
}

/** Per-rep quality summary (last N days). */
async function repQualitySummary({ days = 30 } = {}) {
  const r = await pool.query(`
    SELECT COALESCE(g.rep_name, g.rep_email, '(unknown)') AS rep,
           g.rep_email, g.rep_key,
           COUNT(*)::int AS replies_graded,
           ROUND(AVG(g.tone_score)::numeric, 2)          AS avg_tone,
           ROUND(AVG(g.completeness_score)::numeric, 2)  AS avg_completeness,
           ROUND(AVG(g.accuracy_score)::numeric, 2)      AS avg_accuracy,
           ROUND(AVG(g.followthrough_score)::numeric, 2) AS avg_followthrough,
           ROUND(AVG(g.overall_score)::numeric, 2)       AS avg_overall,
           SUM(CASE WHEN g.overall_score <= 2.5 THEN 1 ELSE 0 END)::int AS low_quality_count
      FROM email_archive_rep_grades g
     WHERE g.graded_at >= NOW() - ($1 || ' days')::interval
     GROUP BY rep, g.rep_email, g.rep_key
     ORDER BY avg_overall ASC NULLS LAST, replies_graded DESC`,
    [String(days)]
  );
  return r.rows;
}

/** Worst replies for drill-down. */
async function worstReplies({ days = 30, repEmail = null, limit = 50 } = {}) {
  const params = [String(days)];
  const conds = [`g.graded_at >= NOW() - ($1 || ' days')::interval`];
  if (repEmail) {
    params.push(repEmail.toLowerCase());
    conds.push(`g.rep_email = $${params.length}`);
  }
  params.push(limit);
  const r = await pool.query(`
    SELECT g.message_id, g.overall_score, g.tone_score, g.completeness_score,
           g.accuracy_score, g.followthrough_score, g.weaknesses, g.coaching_note,
           g.rep_email, g.rep_name,
           m.subject, m.sent_at, m.thread_id, m.body_text_clean,
           t.gmail_thread_id, t.customer_email
      FROM email_archive_rep_grades g
      JOIN email_archive_messages m ON m.id = g.message_id
      JOIN email_archive_threads t ON t.id = m.thread_id
     WHERE ${conds.join(' AND ')}
     ORDER BY g.overall_score ASC, m.sent_at DESC
     LIMIT $${params.length}`, params);
  return r.rows;
}

module.exports = {
  // Top questions / heatmap
  topQuestions,
  productHourHeatmap,
  dowHourHeatmap,
  // FAQ
  runFaqSuggester,
  listFaqCandidates,
  reviewFaqCandidate,
  // Training
  runTrainingSuggester,
  listTrainingCandidates,
  reviewTrainingCandidate,
  // Quality
  repQualitySummary,
  worstReplies,
};
