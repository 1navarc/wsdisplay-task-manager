/**
 * Training Ingestion Service
 *
 * Reads a mailbox's Gmail history (e.g. info@sdsign.com) and extracts
 * training examples (customer email + rep reply as ideal Q/A pairs) plus
 * factual knowledge-base entries (product prices, lead times, materials,
 * policies, etc.) — subject to a configurable filter set.
 *
 * This service is intentionally decoupled from the normal inbox sync
 * (gmail-sync.js). Training mailboxes are *excluded* from the 2-minute
 * auto-sync because their job is to feed the knowledge base, not the
 * inbox. Ingestion runs are triggered manually from Settings > AI.
 *
 * See: server/db/migrations/018_training_ingestion.sql
 */

const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pool } = require('../config/database');

// Gemini Flash pricing (USD per 1M tokens) as of May 2025.
const GEMINI_FLASH_IN_PER_M = 0.075;
const GEMINI_FLASH_OUT_PER_M = 0.30;
const MODEL = 'gemini-2.5-flash';

let genAI = null;
function getGenAI() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

// ---------- Filter config helpers ----------

const DEFAULT_FILTERS = {
  mailbox_email: 'info@sdsign.com',
  date_range_days: 90,
  rep_whitelist: [],
  min_thread_messages: 2,
  min_reply_chars: 100,
  excluded_domains: ['wsdisplay.com', 'modco.com'],
  subject_include_keywords: [],
  subject_exclude_keywords: ['out of office', 'auto-reply', 'automatic reply'],
  body_include_keywords: [],
  body_exclude_keywords: [],
  closed_only: false,
  skip_ai_drafted: true,
  thumbs_up_only: false,
  max_threads_per_run: 500,
};

async function getFilterConfig() {
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'training_ingestion_config'`
    );
    if (!r.rows.length) return { ...DEFAULT_FILTERS };
    return { ...DEFAULT_FILTERS, ...(r.rows[0].value || {}) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

async function saveFilterConfig(patch) {
  const current = await getFilterConfig();
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    ['training_ingestion_config', JSON.stringify(next)]
  );
  return next;
}

// ---------- Gmail helpers ----------

async function getGmailClientForTraining(mailboxEmail) {
  const r = await pool.query(
    'SELECT refresh_token FROM mailboxes WHERE email = $1',
    [mailboxEmail]
  );
  if (!r.rows.length || !r.rows[0].refresh_token) {
    throw new Error(`No refresh_token stored for ${mailboxEmail} — connect it in Mailboxes first.`);
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: r.rows[0].refresh_token });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function buildGmailQuery(filters) {
  const parts = [];
  // Date range
  const afterDate = new Date(Date.now() - filters.date_range_days * 864e5);
  parts.push(`after:${Math.floor(afterDate.getTime() / 1000)}`);
  // Only sent threads are useful — rep replies are the training signal
  parts.push('in:sent');
  // Subject exclusions that Gmail itself can filter cheaply
  for (const kw of filters.subject_exclude_keywords || []) {
    if (kw) parts.push(`-subject:"${kw}"`);
  }
  return parts.join(' ');
}

function headerValue(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractEmailAddr(raw) {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

function domainOf(email) {
  const e = extractEmailAddr(email);
  const i = e.indexOf('@');
  return i >= 0 ? e.slice(i + 1) : '';
}

function decodeBody(part) {
  if (!part) return '';
  if (part.body && part.body.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf8');
  }
  if (part.parts) {
    // Prefer text/plain, else text/html stripped
    const plain = part.parts.find(p => p.mimeType === 'text/plain');
    if (plain) return decodeBody(plain);
    const html = part.parts.find(p => p.mimeType === 'text/html');
    if (html) return decodeBody(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const p of part.parts) {
      const v = decodeBody(p);
      if (v) return v;
    }
  }
  return '';
}

function stripQuotedText(body) {
  if (!body) return '';
  // Kill common quote patterns — good-enough, not perfect.
  const cut = body.search(/(^|\n)(On .+wrote:|From:\s.+\n)/);
  return (cut >= 0 ? body.slice(0, cut) : body).trim();
}

// ---------- Filtering logic ----------

function shouldSkipThread(thread, filters, mailboxEmail) {
  const msgs = thread.messages || [];
  if (msgs.length < filters.min_thread_messages) {
    return 'thread too short';
  }

  // Participants
  const fromAddrs = msgs.map(m => extractEmailAddr(headerValue(m.payload?.headers, 'From')));
  const repMsg = msgs.find(m => extractEmailAddr(headerValue(m.payload?.headers, 'From')) === mailboxEmail.toLowerCase());
  const customerMsg = msgs.find(m => {
    const a = extractEmailAddr(headerValue(m.payload?.headers, 'From'));
    return a && a !== mailboxEmail.toLowerCase();
  });
  if (!repMsg || !customerMsg) return 'no customer<>rep pair';

  const customerAddr = extractEmailAddr(headerValue(customerMsg.payload?.headers, 'From'));
  const customerDomain = domainOf(customerAddr);
  if ((filters.excluded_domains || []).some(d => d && customerDomain.endsWith(d))) {
    return `customer domain excluded (${customerDomain})`;
  }

  // Rep whitelist
  if (filters.rep_whitelist && filters.rep_whitelist.length > 0) {
    const repAddr = extractEmailAddr(headerValue(repMsg.payload?.headers, 'From'));
    if (!filters.rep_whitelist.map(s => s.toLowerCase()).includes(repAddr)) {
      return `rep not on whitelist (${repAddr})`;
    }
  }

  // Reply length
  const replyBody = stripQuotedText(decodeBody(repMsg.payload));
  if (replyBody.length < filters.min_reply_chars) {
    return `reply too short (${replyBody.length} chars)`;
  }

  // Subject filters
  const subject = (headerValue(msgs[0].payload?.headers, 'Subject') || '').toLowerCase();
  for (const kw of (filters.subject_exclude_keywords || [])) {
    if (kw && subject.includes(kw.toLowerCase())) return `subject blocked: "${kw}"`;
  }
  if ((filters.subject_include_keywords || []).length > 0) {
    const hit = filters.subject_include_keywords.some(k => k && subject.includes(k.toLowerCase()));
    if (!hit) return 'subject lacks required keyword';
  }

  // Body keyword filters (check customer body)
  const custBody = stripQuotedText(decodeBody(customerMsg.payload));
  for (const kw of (filters.body_exclude_keywords || [])) {
    if (kw && custBody.toLowerCase().includes(kw.toLowerCase())) return `body blocked: "${kw}"`;
  }
  if ((filters.body_include_keywords || []).length > 0) {
    const hit = filters.body_include_keywords.some(k => k && custBody.toLowerCase().includes(k.toLowerCase()));
    if (!hit) return 'body lacks required keyword';
  }

  return null; // accepted
}

// ---------- LLM extraction ----------

const EXTRACTION_PROMPT = `You are a training data extractor for a print/sign customer-service knowledge base.

You will see one email thread: a customer's question and a rep's reply. Decide what is reusable:

1) If the rep's reply is a good, self-contained answer to the customer's question, extract it as an "example" Q/A pair.
2) Extract any concrete factual claims the rep made that would belong in a product knowledge base: price, turnaround time, material, dimensions, shipping method, warranty, return policy, compatibility, etc. Tie each fact to a product/topic when one is mentioned.

Rules:
- Only extract things that are likely to be generally true, not one-off negotiations ("I'll give you 10% off this time").
- Skip greetings, small talk, signatures.
- Be terse. Facts should be single sentences.
- If nothing useful is in the thread, return empty arrays.

Return ONLY JSON of this shape:
{
  "qa": [
    { "question": "...", "answer": "...", "category": "order_status|shipping|returns|billing|product_question|complaint|general" }
  ],
  "facts": [
    { "product": "string or null", "field": "price|lead_time|material|dimensions|shipping|warranty|return_policy|compatibility|other", "value": "...", "confidence": 0.0-1.0 }
  ],
  "summary": "one-line description of what the thread was about"
}`;

async function extractFromThread({ subject, customerBody, repReply }) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  const prompt = `${EXTRACTION_PROMPT}

Subject: ${subject || '(no subject)'}
Customer:
${(customerBody || '').slice(0, 4000)}

Rep reply:
${(repReply || '').slice(0, 4000)}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const usage = result.response.usageMetadata || {};
  const input_tokens = usage.promptTokenCount || 0;
  const output_tokens = usage.candidatesTokenCount || 0;
  const cost_usd =
    (input_tokens / 1e6) * GEMINI_FLASH_IN_PER_M +
    (output_tokens / 1e6) * GEMINI_FLASH_OUT_PER_M;

  let parsed = { qa: [], facts: [], summary: '' };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parsed = { qa: [], facts: [], summary: '(parse-error)' };
  }
  return { parsed, input_tokens, output_tokens, cost_usd };
}

// ---------- Conflict detection ----------

/**
 * Look up existing KB facts for (product, field). If a value exists and
 * differs, create a pending conflict row. ERP values win automatically
 * (future-proofing: when an ERP row exists, incoming email_ingest is stored
 * as superseded instead of overwriting).
 */
async function detectConflict({ product, field, newValue, runId, sourceRef }) {
  if (!product || !field) return { conflict: false };
  const q = await pool.query(
    `SELECT id, content, source, source_ref, created_at, created_by
       FROM knowledge_base_articles
      WHERE status = 'active'
        AND category = $2
        AND lower(title) = lower($1)
      ORDER BY CASE source WHEN 'erp' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 1`,
    [product, field]
  );
  if (!q.rows.length) return { conflict: false };
  const existing = q.rows[0];
  // Normalize for comparison
  const norm = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (norm(existing.content) === norm(newValue)) return { conflict: false };

  await pool.query(
    `INSERT INTO knowledge_conflicts
       (product, field, old_value, old_source, old_source_ref, old_created_at, old_created_by,
        new_value, new_source, new_source_ref, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'email_ingest',$9,$10)`,
    [product, field, existing.content, existing.source || 'manual', existing.source_ref,
     existing.created_at, existing.created_by, newValue, sourceRef, runId]
  );
  return { conflict: true, oldValue: existing.content, existingSource: existing.source };
}

// ---------- Writers ----------

// Review-queue helpers. Read once per run via getReviewConfig().
async function getReviewConfig() {
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'review_queue_config'`
    );
    if (!r.rows.length) return { require_review_for_ingestion: true, require_review_for_facts: true, require_review_for_qa: true };
    const v = r.rows[0].value || {};
    return {
      require_review_for_ingestion: v.require_review_for_ingestion !== false,
      require_review_for_facts: v.require_review_for_facts !== false,
      require_review_for_qa: v.require_review_for_qa !== false,
    };
  } catch {
    return { require_review_for_ingestion: true, require_review_for_facts: true, require_review_for_qa: true };
  }
}

async function writeQaExample({ qa, runId, sourceRef, reviewConfig }) {
  const gated = (reviewConfig && reviewConfig.require_review_for_ingestion && reviewConfig.require_review_for_qa);
  const status = gated ? 'pending_review' : 'active';
  const isActive = !gated;
  await pool.query(
    `INSERT INTO ai_training_rules
       (rule_type, email_category, content, example_email, example_response,
        source, source_ref, status, ingestion_run_id, is_active)
     VALUES ('example', $1, $2, $3, $4, 'email_ingest', $5, $7, $6, $8)`,
    [
      qa.category || 'general',
      (qa.summary || qa.question || '').slice(0, 200),
      qa.question || '',
      qa.answer || '',
      sourceRef,
      runId,
      status,
      isActive,
    ]
  );
}

async function writeFact({ fact, runId, sourceRef, existingSource, reviewConfig }) {
  // If an ERP value already exists, store as superseded (never overwrite ERP).
  // Otherwise, use review config to decide pending_review vs active.
  let status = 'active';
  let isPublished = true;
  if (existingSource === 'erp') {
    status = 'superseded';
    isPublished = false;
  } else if (reviewConfig && reviewConfig.require_review_for_ingestion && reviewConfig.require_review_for_facts) {
    status = 'pending_review';
    isPublished = false;
  }
  await pool.query(
    `INSERT INTO knowledge_base_articles
       (title, content, category, source, source_ref, status, ingestion_run_id, is_published, created_at, updated_at)
     VALUES ($1, $2, $3, 'email_ingest', $4, $5, $6, $7, NOW(), NOW())`,
    [
      fact.product || 'general',
      fact.value || '',
      fact.field || 'other',
      sourceRef,
      status,
      runId,
      isPublished,
    ]
  );
}

// ---------- Run orchestrator ----------

const activeRuns = new Map(); // runId -> { cancel: boolean }

async function startRun({ startedByUserId, filterOverrides }) {
  const filters = { ...(await getFilterConfig()), ...(filterOverrides || {}) };
  const mailboxEmail = filters.mailbox_email;
  if (!mailboxEmail) throw new Error('No mailbox_email configured for training ingestion');

  const created = await pool.query(
    `INSERT INTO training_ingestion_runs
       (mailbox_email, status, filter_snapshot, started_by_user_id, current_status_line)
     VALUES ($1, 'running', $2, $3, 'Starting…')
     RETURNING id`,
    [mailboxEmail, JSON.stringify(filters), startedByUserId || null]
  );
  const runId = created.rows[0].id;
  activeRuns.set(runId, { cancel: false });

  // Run async — caller gets runId immediately
  processRun(runId, filters).catch(async err => {
    console.error(`Ingestion run ${runId} failed:`, err);
    await pool.query(
      `UPDATE training_ingestion_runs
          SET status = 'failed', completed_at = NOW(), last_error = $2, current_status_line = $3
        WHERE id = $1`,
      [runId, err.message, 'Failed: ' + err.message]
    ).catch(() => {});
    activeRuns.delete(runId);
  });

  return runId;
}

async function processRun(runId, filters) {
  const mailboxEmail = filters.mailbox_email;
  const gmail = await getGmailClientForTraining(mailboxEmail);
  const q = buildGmailQuery(filters);
  const reviewConfig = await getReviewConfig();

  await updateRunStatus(runId, { current_status_line: `Listing threads (${q})…` });

  // List threads in pages until we hit max_threads_per_run
  const threadIds = [];
  let pageToken;
  while (threadIds.length < filters.max_threads_per_run) {
    const resp = await gmail.users.threads.list({
      userId: 'me',
      q,
      maxResults: Math.min(100, filters.max_threads_per_run - threadIds.length),
      pageToken,
    });
    const page = resp.data.threads || [];
    if (!page.length) break;
    for (const t of page) threadIds.push(t.id);
    pageToken = resp.data.nextPageToken;
    if (!pageToken) break;
  }

  await pool.query(
    `UPDATE training_ingestion_runs SET total_threads = $2 WHERE id = $1`,
    [runId, threadIds.length]
  );

  let processed = 0, skipped = 0, errors = 0;
  let qaCreated = 0, factsCreated = 0, conflictsCreated = 0;
  let totIn = 0, totOut = 0, totCost = 0;

  for (let i = 0; i < threadIds.length; i++) {
    // Check cancel
    const state = activeRuns.get(runId);
    if (!state || state.cancel) {
      await pool.query(
        `UPDATE training_ingestion_runs
            SET status = 'cancelled', completed_at = NOW(), current_status_line = $2
          WHERE id = $1`,
        [runId, `Cancelled after ${i} of ${threadIds.length} threads`]
      );
      activeRuns.delete(runId);
      return;
    }

    const tid = threadIds[i];
    await updateRunStatus(runId, {
      current_status_line: `Thread ${i + 1}/${threadIds.length} (${tid})`,
    });

    try {
      const thread = (await gmail.users.threads.get({ userId: 'me', id: tid, format: 'full' })).data;
      const skipReason = shouldSkipThread(thread, filters, mailboxEmail);
      if (skipReason) {
        skipped++;
        await logThread(runId, thread, 'skipped', { skip_reason: skipReason });
        continue;
      }

      const msgs = thread.messages || [];
      const customerMsg = msgs.find(m => {
        const a = extractEmailAddr(headerValue(m.payload?.headers, 'From'));
        return a && a !== mailboxEmail.toLowerCase();
      });
      const repMsg = msgs.find(m => extractEmailAddr(headerValue(m.payload?.headers, 'From')) === mailboxEmail.toLowerCase());
      const subject = headerValue(msgs[0].payload?.headers, 'Subject');
      const custBody = stripQuotedText(decodeBody(customerMsg.payload));
      const repBody = stripQuotedText(decodeBody(repMsg.payload));

      const { parsed, input_tokens, output_tokens, cost_usd } = await extractFromThread({
        subject, customerBody: custBody, repReply: repBody,
      });

      totIn += input_tokens;
      totOut += output_tokens;
      totCost += cost_usd;

      const flaggedConflicts = [];
      // Write Q/A
      for (const qa of (parsed.qa || [])) {
        await writeQaExample({ qa: { ...qa, summary: parsed.summary }, runId, sourceRef: tid, reviewConfig });
        qaCreated++;
      }
      // Write facts (with conflict check)
      for (const fact of (parsed.facts || [])) {
        const c = await detectConflict({
          product: fact.product, field: fact.field, newValue: fact.value,
          runId, sourceRef: tid,
        });
        if (c.conflict) {
          conflictsCreated++;
          flaggedConflicts.push({ ...fact, oldValue: c.oldValue, oldSource: c.existingSource });
        }
        await writeFact({ fact, runId, sourceRef: tid, existingSource: c.existingSource, reviewConfig });
        factsCreated++;
      }

      processed++;
      await logThread(runId, thread, 'processed', {
        qa_extracted: parsed.qa || [],
        facts_extracted: parsed.facts || [],
        conflicts_flagged: flaggedConflicts,
        input_tokens, output_tokens, cost_usd,
      });

      // Update aggregates every ~5 threads so UI polling sees progress
      if (processed % 5 === 0 || i === threadIds.length - 1) {
        await pool.query(
          `UPDATE training_ingestion_runs
              SET processed_count=$2, skipped_count=$3, error_count=$4,
                  qa_created=$5, facts_created=$6, conflicts_created=$7,
                  total_input_tokens=$8, total_output_tokens=$9, total_cost_usd=$10
            WHERE id=$1`,
          [runId, processed, skipped, errors,
           qaCreated, factsCreated, conflictsCreated,
           totIn, totOut, totCost]
        );
      }
    } catch (err) {
      errors++;
      console.error(`Thread ${tid} error:`, err.message);
      await logThread(runId, { id: tid }, 'error', { error_message: err.message });
    }
  }

  await pool.query(
    `UPDATE training_ingestion_runs
        SET status='complete', completed_at=NOW(),
            processed_count=$2, skipped_count=$3, error_count=$4,
            qa_created=$5, facts_created=$6, conflicts_created=$7,
            total_input_tokens=$8, total_output_tokens=$9, total_cost_usd=$10,
            current_status_line=$11
      WHERE id=$1`,
    [runId, processed, skipped, errors,
     qaCreated, factsCreated, conflictsCreated,
     totIn, totOut, totCost,
     `Done — ${processed} processed, ${skipped} skipped, ${errors} errors`]
  );
  activeRuns.delete(runId);
}

async function logThread(runId, thread, action, extra = {}) {
  const msgs = thread.messages || [];
  const first = msgs[0] || { payload: { headers: [] } };
  const subject = headerValue(first.payload?.headers, 'Subject') || '';
  const fromRaw = headerValue(first.payload?.headers, 'From') || '';
  const date = headerValue(first.payload?.headers, 'Date');
  const tDate = date ? new Date(date) : null;
  const customer = extractEmailAddr(fromRaw);

  await pool.query(
    `INSERT INTO training_ingestion_log
       (run_id, gmail_thread_id, thread_subject, thread_date, rep_email, customer_email,
        action, skip_reason, qa_extracted, facts_extracted, conflicts_flagged,
        input_tokens, output_tokens, cost_usd, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      runId,
      thread.id,
      subject.slice(0, 500),
      tDate && !isNaN(tDate) ? tDate : null,
      null, // rep_email — omitted for brevity; could be mined if needed
      customer,
      action,
      extra.skip_reason || null,
      extra.qa_extracted ? JSON.stringify(extra.qa_extracted) : null,
      extra.facts_extracted ? JSON.stringify(extra.facts_extracted) : null,
      extra.conflicts_flagged ? JSON.stringify(extra.conflicts_flagged) : null,
      extra.input_tokens || 0,
      extra.output_tokens || 0,
      extra.cost_usd || 0,
      extra.error_message || null,
    ]
  );
}

async function updateRunStatus(runId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE training_ingestion_runs SET ${sets} WHERE id = $1`,
    [runId, ...keys.map(k => patch[k])]
  );
}

function requestCancel(runId) {
  const s = activeRuns.get(runId);
  if (s) s.cancel = true;
  return !!s;
}

async function getRunStatus(runId) {
  const r = await pool.query(
    `SELECT * FROM training_ingestion_runs WHERE id = $1`,
    [runId]
  );
  return r.rows[0] || null;
}

async function listRuns(limit = 20) {
  const r = await pool.query(
    `SELECT id, mailbox_email, started_at, completed_at, status,
            total_threads, processed_count, skipped_count, error_count,
            qa_created, facts_created, conflicts_created, total_cost_usd
       FROM training_ingestion_runs
      ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getRunLog(runId, limit = 500) {
  const r = await pool.query(
    `SELECT id, gmail_thread_id, thread_subject, thread_date, customer_email,
            action, skip_reason, qa_extracted, facts_extracted, conflicts_flagged,
            input_tokens, output_tokens, cost_usd, error_message, processed_at
       FROM training_ingestion_log
      WHERE run_id = $1
      ORDER BY processed_at DESC
      LIMIT $2`,
    [runId, limit]
  );
  return r.rows;
}

// ---------- Review queue ----------

async function listPendingQa(limit = 200) {
  const r = await pool.query(
    `SELECT id, rule_type, email_category, content, example_email, example_response,
            source, source_ref, ingestion_run_id, created_at
       FROM ai_training_rules
      WHERE status = 'pending_review' AND source = 'email_ingest'
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function listPendingFacts(limit = 200) {
  const r = await pool.query(
    `SELECT id, title, content, category, source, source_ref, ingestion_run_id, created_at
       FROM knowledge_base_articles
      WHERE status = 'pending_review' AND source = 'email_ingest'
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function decideQa(id, decision, userId, edit = null) {
  // decision: 'approved' | 'rejected' | 'edited'
  if (decision === 'rejected') {
    await pool.query(
      `UPDATE ai_training_rules
          SET status='rejected', is_active=false, review_decision='rejected',
              reviewed_at=NOW(), reviewed_by=$2
        WHERE id=$1`,
      [id, userId || null]
    );
  } else if (decision === 'edited' && edit) {
    await pool.query(
      `UPDATE ai_training_rules
          SET content = COALESCE($3, content),
              example_email = COALESCE($4, example_email),
              example_response = COALESCE($5, example_response),
              email_category = COALESCE($6, email_category),
              status='active', is_active=true, review_decision='edited',
              reviewed_at=NOW(), reviewed_by=$2
        WHERE id=$1`,
      [id, userId || null, edit.content || null, edit.example_email || null,
       edit.example_response || null, edit.email_category || null]
    );
  } else {
    // approved as-is
    await pool.query(
      `UPDATE ai_training_rules
          SET status='active', is_active=true, review_decision='approved',
              reviewed_at=NOW(), reviewed_by=$2
        WHERE id=$1`,
      [id, userId || null]
    );
  }
}

async function decideFact(id, decision, userId, edit = null) {
  if (decision === 'rejected') {
    await pool.query(
      `UPDATE knowledge_base_articles
          SET status='rejected', is_published=false, review_decision='rejected',
              reviewed_at=NOW(), reviewed_by=$2
        WHERE id=$1`,
      [id, userId || null]
    );
  } else if (decision === 'edited' && edit) {
    await pool.query(
      `UPDATE knowledge_base_articles
          SET title = COALESCE($3, title),
              content = COALESCE($4, content),
              category = COALESCE($5, category),
              status='active', is_published=true, review_decision='edited',
              reviewed_at=NOW(), reviewed_by=$2, updated_at=NOW()
        WHERE id=$1`,
      [id, userId || null, edit.title || null, edit.content || null, edit.category || null]
    );
  } else {
    await pool.query(
      `UPDATE knowledge_base_articles
          SET status='active', is_published=true, review_decision='approved',
              reviewed_at=NOW(), reviewed_by=$2, updated_at=NOW()
        WHERE id=$1`,
      [id, userId || null]
    );
  }
}

async function getReviewConfigPublic() {
  return await getReviewConfig();
}

async function saveReviewConfig(patch) {
  const current = await getReviewConfig();
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    ['review_queue_config', JSON.stringify(next)]
  );
  return next;
}

// ---------- Conflicts ----------

async function listConflicts({ status = 'pending', limit = 200 } = {}) {
  const r = await pool.query(
    `SELECT * FROM knowledge_conflicts WHERE status = $1 ORDER BY new_created_at DESC LIMIT $2`,
    [status, limit]
  );
  return r.rows;
}

async function resolveConflict(id, resolution, userId, customValue = null) {
  // resolution: 'keep_old' | 'keep_new' | 'custom' | 'dismissed'
  const c = await pool.query(`SELECT * FROM knowledge_conflicts WHERE id = $1`, [id]);
  if (!c.rows.length) throw new Error('Conflict not found');
  const conflict = c.rows[0];
  let resolutionValue = null;

  if (resolution === 'keep_old') {
    resolutionValue = conflict.old_value;
    // Delete the newly-ingested fact matching new_source_ref so it doesn't linger
    if (conflict.new_source_ref) {
      await pool.query(
        `UPDATE knowledge_base_articles
            SET status='rejected', is_published=false
          WHERE source_ref = $1 AND source = 'email_ingest' AND status = 'pending_review'`,
        [conflict.new_source_ref]
      );
    }
  } else if (resolution === 'keep_new') {
    resolutionValue = conflict.new_value;
    // Mark the older article as superseded
    await pool.query(
      `UPDATE knowledge_base_articles
          SET status='superseded', is_published=false
        WHERE lower(title) = lower($1) AND category = $2 AND content = $3 AND status = 'active'`,
      [conflict.product, conflict.field, conflict.old_value]
    );
    // Activate the new one if it was pending_review
    if (conflict.new_source_ref) {
      await pool.query(
        `UPDATE knowledge_base_articles
            SET status='active', is_published=true, review_decision='approved',
                reviewed_at=NOW(), reviewed_by=$2
          WHERE source_ref = $1 AND source = 'email_ingest' AND status = 'pending_review'`,
        [conflict.new_source_ref, userId || null]
      );
    }
  } else if (resolution === 'custom') {
    resolutionValue = customValue;
    // Supersede both and create a new manual entry
    await pool.query(
      `UPDATE knowledge_base_articles
          SET status='superseded', is_published=false
        WHERE lower(title) = lower($1) AND category = $2
          AND (content = $3 OR content = $4)`,
      [conflict.product, conflict.field, conflict.old_value, conflict.new_value]
    );
    await pool.query(
      `INSERT INTO knowledge_base_articles
         (title, content, category, source, status, is_published, created_at, updated_at)
       VALUES ($1, $2, $3, 'manual', 'active', true, NOW(), NOW())`,
      [conflict.product, customValue, conflict.field]
    );
  }

  await pool.query(
    `UPDATE knowledge_conflicts
        SET status = $2, resolution = $3, resolution_value = $4,
            resolved_by = $5, resolved_at = NOW()
      WHERE id = $1`,
    [id, resolution === 'dismissed' ? 'dismissed' : 'resolved', resolution, resolutionValue, userId || null]
  );
}

module.exports = {
  DEFAULT_FILTERS,
  getFilterConfig,
  saveFilterConfig,
  startRun,
  requestCancel,
  getRunStatus,
  listRuns,
  getRunLog,
  // Review queue
  listPendingQa,
  listPendingFacts,
  decideQa,
  decideFact,
  getReviewConfigPublic,
  saveReviewConfig,
  // Conflicts
  listConflicts,
  resolveConflict,
};
