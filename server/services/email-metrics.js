/**
 * Email Metrics Service
 *
 * Analyzes a mailbox's threads for a configurable time window and produces:
 *   - Per-rep response time stats (first-response + ongoing follow-up)
 *   - Per-rep thread counts
 *   - AI-assigned problem-category breakdown
 *   - Management-attention flags:
 *       * slow_first_response (> SLA hours)
 *       * unanswered (no rep reply after N hours)
 *       * negative_sentiment (angry customer)
 *       * repeat_problem (same category >= threshold occurrences)
 *
 * Run-based model identical in shape to training-ingestion: configure filter,
 * POST /runs, poll /runs/:id for progress, fetch flags separately.
 *
 * See: server/db/migrations/019_email_metrics.sql
 */

const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pool } = require('../config/database');

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

// ---------- Filter config ----------

const DEFAULT_FILTERS = {
  mailbox_email: 'info@sdsign.com',
  date_range_days: 7,
  date_from: null,
  date_to: null,
  excluded_domains: ['wsdisplay.com', 'modco.com'],
  rep_whitelist: [],
  first_response_sla_hours: 4,
  unanswered_alert_hours: 24,
  business_hours_only: false,
  business_hours_start: '08:00',
  business_hours_end: '18:00',
  repeat_problem_threshold: 3,
  max_threads: 1000,
  enable_ai_categorization: true,
  enable_sentiment_analysis: true,
  subject_exclude_keywords: ['out of office', 'auto-reply', 'automatic reply'],
};

async function getFilterConfig() {
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'email_metrics_config'`
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
    ['email_metrics_config', JSON.stringify(next)]
  );
  return next;
}

// ---------- Gmail helpers ----------

async function getGmailClientForMailbox(mailboxEmail) {
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
  // Prefer explicit date_from/date_to if set, else date_range_days
  let afterSec, beforeSec;
  if (filters.date_from) {
    afterSec = Math.floor(new Date(filters.date_from).getTime() / 1000);
  } else {
    afterSec = Math.floor((Date.now() - (filters.date_range_days || 7) * 864e5) / 1000);
  }
  if (filters.date_to) {
    beforeSec = Math.floor(new Date(filters.date_to).getTime() / 1000);
  }
  if (!isNaN(afterSec)) parts.push(`after:${afterSec}`);
  if (beforeSec && !isNaN(beforeSec)) parts.push(`before:${beforeSec}`);
  parts.push('-in:chats');
  parts.push('-in:drafts');
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
  const cut = body.search(/(^|\n)(On .+wrote:|From:\s.+\n)/);
  return (cut >= 0 ? body.slice(0, cut) : body).trim();
}

// ---------- Business-hours math ----------

/**
 * Return ms of elapsed time between startMs and endMs, counting only
 * business hours (Mon-Fri, bhStart..bhEnd in server local time).
 * Simple algorithm: step by day, accumulate intersection of each day's
 * business window with [start, end].
 */
function businessHoursMs(startMs, endMs, bhStart, bhEnd) {
  if (endMs <= startMs) return 0;
  const [sh, sm] = (bhStart || '08:00').split(':').map(Number);
  const [eh, em] = (bhEnd || '18:00').split(':').map(Number);
  let total = 0;
  let cursor = new Date(startMs);
  while (cursor.getTime() < endMs) {
    const dayStart = new Date(cursor);
    dayStart.setHours(sh, sm, 0, 0);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(eh, em, 0, 0);
    const dow = cursor.getDay(); // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6) {
      const from = Math.max(startMs, dayStart.getTime(), cursor.getTime());
      const to = Math.min(endMs, dayEnd.getTime());
      if (to > from) total += (to - from);
    }
    // advance to next day 00:00
    const nextDay = new Date(cursor);
    nextDay.setHours(0, 0, 0, 0);
    nextDay.setDate(nextDay.getDate() + 1);
    cursor = nextDay;
  }
  return total;
}

function elapsedMs(startMs, endMs, filters) {
  if (filters.business_hours_only) {
    return businessHoursMs(startMs, endMs, filters.business_hours_start, filters.business_hours_end);
  }
  return Math.max(0, endMs - startMs);
}

// ---------- Stats helpers ----------

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[idx];
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

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

// ---------- AI categorization/sentiment ----------

const ANALYSIS_PROMPT = `You are analyzing a customer-service email thread for a print/sign company.

Classify the thread by:
1. "category": a short lowercase topic tag (1-3 words, snake_case) describing what the customer is asking about. Use consistent tags when possible. Examples:
   "shipping_delay", "shipping_question", "artwork_proof", "artwork_revision",
   "pricing_question", "quote_request", "order_status", "install_question",
   "install_problem", "warranty_claim", "refund_request", "damage_report",
   "product_question", "billing_question", "complaint", "general_question".
   If none fit, invent a concise snake_case tag.
2. "sentiment": "positive" | "neutral" | "negative".
   "negative" = angry, frustrated, threatening to cancel, refund-demanding, complaining about the rep or delay.
   "positive" = thankful, happy with service.
   Default to "neutral".
3. "summary": one sentence (max 140 chars) describing what the customer wanted.

Return ONLY JSON of this shape:
{
  "category": "...",
  "sentiment": "positive|neutral|negative",
  "summary": "..."
}`;

async function analyzeThreadContent({ subject, customerBody, enabled }) {
  // If categorization disabled, skip AI call entirely — save cost.
  if (!enabled) {
    return {
      parsed: { category: 'uncategorized', sentiment: 'neutral', summary: '' },
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
  }
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  const prompt = `${ANALYSIS_PROMPT}

Subject: ${subject || '(no subject)'}
Customer:
${(customerBody || '').slice(0, 3000)}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const usage = result.response.usageMetadata || {};
  const input_tokens = usage.promptTokenCount || 0;
  const output_tokens = usage.candidatesTokenCount || 0;
  const cost_usd =
    (input_tokens / 1e6) * GEMINI_FLASH_IN_PER_M +
    (output_tokens / 1e6) * GEMINI_FLASH_OUT_PER_M;

  let parsed = { category: 'uncategorized', sentiment: 'neutral', summary: '' };
  try {
    const raw = JSON.parse(text);
    parsed.category = (raw.category || 'uncategorized').toString().toLowerCase().replace(/\s+/g, '_');
    parsed.sentiment = ['positive', 'neutral', 'negative'].includes(raw.sentiment)
      ? raw.sentiment : 'neutral';
    parsed.summary = (raw.summary || '').toString().slice(0, 200);
  } catch {
    // keep defaults
  }
  return { parsed, input_tokens, output_tokens, cost_usd };
}

// ---------- Thread analysis ----------

/**
 * Parse a Gmail thread and compute response-time metrics and message flow.
 * Returns a shape used for aggregation and flagging.
 */
function analyzeThreadTimings(thread, filters, mailboxEmail) {
  const mbox = mailboxEmail.toLowerCase();
  const msgs = (thread.messages || []).slice().sort((a, b) => {
    return (parseInt(a.internalDate || '0')) - (parseInt(b.internalDate || '0'));
  });
  if (!msgs.length) return null;

  const subject = headerValue(msgs[0].payload?.headers, 'Subject') || '(no subject)';
  const threadDate = parseInt(msgs[0].internalDate || '0');

  // Classify each message as customer or rep
  const parsed = msgs.map(m => {
    const fromRaw = headerValue(m.payload?.headers, 'From');
    const addr = extractEmailAddr(fromRaw);
    return {
      id: m.id,
      at: parseInt(m.internalDate || '0'),
      from: addr,
      isRep: addr === mbox,
      fromRaw,
    };
  });

  // Customer = first non-rep sender's address (main customer on thread)
  const firstCustomer = parsed.find(m => !m.isRep && m.from);
  const customerEmail = firstCustomer ? firstCustomer.from : '';
  const customerDomain = domainOf(customerEmail);

  // Skip if customer domain excluded
  if (customerDomain && (filters.excluded_domains || []).some(d => d && customerDomain.endsWith(d))) {
    return { skipped: true, skip_reason: `customer domain excluded (${customerDomain})` };
  }

  // Walk to compute first-response + ongoing pairs
  let firstCustomerIdx = -1;
  let firstRepIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (!parsed[i].isRep && parsed[i].from && firstCustomerIdx === -1) firstCustomerIdx = i;
    if (firstCustomerIdx !== -1 && parsed[i].isRep && firstRepIdx === -1) {
      firstRepIdx = i;
      break;
    }
  }

  let firstResponseMs = null;
  let firstResponderEmail = null;
  if (firstCustomerIdx !== -1 && firstRepIdx !== -1) {
    firstResponseMs = elapsedMs(parsed[firstCustomerIdx].at, parsed[firstRepIdx].at, filters);
    firstResponderEmail = parsed[firstRepIdx].from;
  }

  // Ongoing: every (customer -> rep) transition after the first pair
  const ongoingByRep = {}; // rep -> [ms,...]
  for (let i = firstRepIdx + 1; i < parsed.length; i++) {
    // Look back for most recent customer message after the prior rep reply
    if (parsed[i].isRep) {
      // find nearest prior non-rep message (stop if rep before it)
      let j = i - 1;
      while (j >= 0 && parsed[j].isRep) j--;
      if (j >= 0 && parsed[j].from) {
        const ms = elapsedMs(parsed[j].at, parsed[i].at, filters);
        if (!ongoingByRep[parsed[i].from]) ongoingByRep[parsed[i].from] = [];
        ongoingByRep[parsed[i].from].push(ms);
      }
    }
  }

  // Unanswered: last message was from customer, and now - last_msg > unanswered_hours
  const lastMsg = parsed[parsed.length - 1];
  const isUnanswered =
    lastMsg &&
    !lastMsg.isRep &&
    lastMsg.from &&
    (Date.now() - lastMsg.at) > (filters.unanswered_alert_hours || 24) * 3600 * 1000;

  // Text for categorization (customer body)
  const customerMsgObj = msgs[firstCustomerIdx >= 0 ? firstCustomerIdx : 0];
  const customerBody = stripQuotedText(decodeBody(customerMsgObj.payload || {}));

  return {
    skipped: false,
    gmail_thread_id: thread.id,
    subject,
    threadDate,
    customerEmail,
    customerDomain,
    firstResponseMs,
    firstResponderEmail,
    ongoingByRep,                    // per-rep arrays of ms
    allRepAddrs: [...new Set(parsed.filter(m => m.isRep && m.from).map(m => m.from))],
    messageCount: msgs.length,
    isUnanswered,
    lastMsgAt: lastMsg ? lastMsg.at : null,
    customerBody,
  };
}

// ---------- Aggregation ----------

function aggregateRepStats(threadResults) {
  // rep -> stats accumulator
  const byRep = {};
  for (const t of threadResults) {
    if (!t || t.skipped || !t.firstResponderEmail) continue;
    const r = t.firstResponderEmail;
    if (!byRep[r]) {
      byRep[r] = {
        rep_email: r,
        threads_first_responder: 0,
        first_response_ms_list: [],
        ongoing_ms_list: [],
        threads_touched: new Set(),
      };
    }
    byRep[r].threads_first_responder++;
    if (t.firstResponseMs != null) byRep[r].first_response_ms_list.push(t.firstResponseMs);
    byRep[r].threads_touched.add(t.gmail_thread_id);
    // ongoing from each rep
    for (const [repAddr, msList] of Object.entries(t.ongoingByRep || {})) {
      if (!byRep[repAddr]) {
        byRep[repAddr] = {
          rep_email: repAddr,
          threads_first_responder: 0,
          first_response_ms_list: [],
          ongoing_ms_list: [],
          threads_touched: new Set(),
        };
      }
      byRep[repAddr].ongoing_ms_list.push(...msList);
      byRep[repAddr].threads_touched.add(t.gmail_thread_id);
    }
  }

  return Object.values(byRep)
    .map(r => ({
      rep_email: r.rep_email,
      threads_first_responder: r.threads_first_responder,
      threads_touched: r.threads_touched.size,
      first_response_count: r.first_response_ms_list.length,
      first_response_ms_avg: avg(r.first_response_ms_list),
      first_response_ms_median: median(r.first_response_ms_list),
      first_response_ms_p90: percentile(r.first_response_ms_list, 0.9),
      ongoing_reply_count: r.ongoing_ms_list.length,
      ongoing_response_ms_avg: avg(r.ongoing_ms_list),
      ongoing_response_ms_median: median(r.ongoing_ms_list),
    }))
    .sort((a, b) => {
      // fastest first-response first, then most-responsive, then most threads
      if (a.first_response_ms_avg !== b.first_response_ms_avg) {
        return (a.first_response_ms_avg || Infinity) - (b.first_response_ms_avg || Infinity);
      }
      return b.threads_first_responder - a.threads_first_responder;
    });
}

function aggregateCategoryStats(threadResults) {
  const byCat = {};
  for (const t of threadResults) {
    if (!t || t.skipped) continue;
    const c = t.category || 'uncategorized';
    if (!byCat[c]) {
      byCat[c] = {
        category: c,
        thread_count: 0,
        unique_customers: new Set(),  // dedupe: one loud customer != widespread issue
        example_thread_ids: [],
        example_subjects: [],
        first_response_ms_list: [],
        negative_count: 0,
      };
    }
    byCat[c].thread_count++;
    if (t.customerEmail) byCat[c].unique_customers.add(t.customerEmail);
    if (byCat[c].example_thread_ids.length < 5) {
      byCat[c].example_thread_ids.push(t.gmail_thread_id);
      byCat[c].example_subjects.push(t.subject);
    }
    if (t.firstResponseMs != null) byCat[c].first_response_ms_list.push(t.firstResponseMs);
    if (t.sentiment === 'negative') byCat[c].negative_count++;
  }
  return Object.values(byCat)
    .map(c => ({
      category: c.category,
      thread_count: c.thread_count,
      unique_customer_count: c.unique_customers.size,  // primary "how common" metric
      example_thread_ids: c.example_thread_ids,
      example_subjects: c.example_subjects,
      avg_first_response_ms: avg(c.first_response_ms_list),
      negative_count: c.negative_count,
    }))
    // Sort by unique customers desc (widespread > one noisy customer), tiebreak by threads
    .sort((a, b) => {
      if (b.unique_customer_count !== a.unique_customer_count) {
        return b.unique_customer_count - a.unique_customer_count;
      }
      return b.thread_count - a.thread_count;
    });
}

function buildSummary(threadResults, filters) {
  const ok = threadResults.filter(t => t && !t.skipped);
  const firstResponses = ok.map(t => t.firstResponseMs).filter(x => x != null);
  const negative = ok.filter(t => t.sentiment === 'negative').length;
  const unanswered = ok.filter(t => t.isUnanswered).length;
  const answered = ok.filter(t => t.firstResponseMs != null).length;
  const slaMs = (filters.first_response_sla_hours || 4) * 3600 * 1000;
  const slaBreach = firstResponses.filter(ms => ms > slaMs).length;
  return {
    total_threads: ok.length,
    answered_threads: answered,
    unanswered_threads: unanswered,
    negative_sentiment_count: negative,
    sla_breach_count: slaBreach,
    sla_hours: filters.first_response_sla_hours,
    overall_first_response_avg_ms: avg(firstResponses),
    overall_first_response_median_ms: median(firstResponses),
    overall_first_response_p90_ms: percentile(firstResponses, 0.9),
  };
}

// ---------- Flag writer ----------

async function writeFlag(runId, flag) {
  await pool.query(
    `INSERT INTO email_metrics_flags
       (run_id, flag_type, severity, gmail_thread_id, thread_subject, thread_date,
        rep_email, customer_email, reason, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      runId,
      flag.flag_type,
      flag.severity || 'medium',
      flag.gmail_thread_id || null,
      (flag.thread_subject || '').slice(0, 500),
      flag.thread_date || null,
      flag.rep_email || null,
      flag.customer_email || null,
      flag.reason || null,
      flag.details ? JSON.stringify(flag.details) : null,
    ]
  );
}

function computeFlagsForThread(t, filters) {
  const flags = [];
  if (!t || t.skipped) return flags;

  const slaMs = (filters.first_response_sla_hours || 4) * 3600 * 1000;
  if (t.firstResponseMs != null && t.firstResponseMs > slaMs) {
    const hrs = (t.firstResponseMs / 3600 / 1000).toFixed(1);
    flags.push({
      flag_type: 'slow_first_response',
      severity: t.firstResponseMs > slaMs * 2 ? 'high' : 'medium',
      gmail_thread_id: t.gmail_thread_id,
      thread_subject: t.subject,
      thread_date: t.threadDate ? new Date(t.threadDate) : null,
      rep_email: t.firstResponderEmail,
      customer_email: t.customerEmail,
      reason: `First reply took ${hrs}h (SLA ${filters.first_response_sla_hours}h)`,
      details: { first_response_ms: t.firstResponseMs, sla_ms: slaMs },
    });
  }

  if (t.isUnanswered) {
    const hrs = t.lastMsgAt ? ((Date.now() - t.lastMsgAt) / 3600 / 1000).toFixed(1) : '?';
    flags.push({
      flag_type: 'unanswered',
      severity: 'high',
      gmail_thread_id: t.gmail_thread_id,
      thread_subject: t.subject,
      thread_date: t.threadDate ? new Date(t.threadDate) : null,
      rep_email: null,
      customer_email: t.customerEmail,
      reason: `No reply for ${hrs}h (alert threshold ${filters.unanswered_alert_hours}h)`,
      details: { last_msg_at: t.lastMsgAt, threshold_hours: filters.unanswered_alert_hours },
    });
  }

  if (t.sentiment === 'negative') {
    flags.push({
      flag_type: 'negative_sentiment',
      severity: 'high',
      gmail_thread_id: t.gmail_thread_id,
      thread_subject: t.subject,
      thread_date: t.threadDate ? new Date(t.threadDate) : null,
      rep_email: t.firstResponderEmail,
      customer_email: t.customerEmail,
      reason: `Customer appears frustrated — ${t.summary || ''}`.slice(0, 300),
      details: { category: t.category, summary: t.summary },
    });
  }

  return flags;
}

function computeRepeatProblemFlags(categoryStats, filters) {
  const threshold = filters.repeat_problem_threshold || 3;
  const flags = [];
  for (const c of categoryStats) {
    // Flag only when DIFFERENT customers raise the same issue.
    // One customer replying many times shouldn't look like a widespread problem.
    if (c.unique_customer_count >= threshold) {
      flags.push({
        flag_type: 'repeat_problem',
        severity: c.unique_customer_count >= threshold * 2 ? 'high' : 'medium',
        gmail_thread_id: null,
        thread_subject: null,
        thread_date: null,
        rep_email: null,
        customer_email: null,
        reason: `${c.unique_customer_count} different customers asked about "${c.category}" (threshold ${threshold})`,
        details: {
          category: c.category,
          unique_customer_count: c.unique_customer_count,
          thread_count: c.thread_count,
          example_thread_ids: c.example_thread_ids,
          example_subjects: c.example_subjects,
          negative_count: c.negative_count,
          avg_first_response_ms: c.avg_first_response_ms,
        },
      });
    }
  }
  return flags;
}

// ---------- Run orchestrator ----------

const activeRuns = new Map(); // runId -> { cancel: boolean }

async function startRun({ startedByUserId, filterOverrides }) {
  const filters = { ...(await getFilterConfig()), ...(filterOverrides || {}) };
  const mailboxEmail = filters.mailbox_email;
  if (!mailboxEmail) throw new Error('No mailbox_email configured for email metrics');

  const created = await pool.query(
    `INSERT INTO email_metrics_runs
       (mailbox_email, status, filter_snapshot, started_by_user_id, current_status_line)
     VALUES ($1, 'running', $2, $3, 'Starting…')
     RETURNING id`,
    [mailboxEmail, JSON.stringify(filters), startedByUserId || null]
  );
  const runId = created.rows[0].id;
  activeRuns.set(runId, { cancel: false });

  processRun(runId, filters).catch(async err => {
    console.error(`Metrics run ${runId} failed:`, err);
    await pool.query(
      `UPDATE email_metrics_runs
          SET status='failed', completed_at=NOW(), last_error=$2, current_status_line=$3
        WHERE id=$1`,
      [runId, err.message, 'Failed: ' + err.message]
    ).catch(() => {});
    activeRuns.delete(runId);
  });

  return runId;
}

async function processRun(runId, filters) {
  const mailboxEmail = filters.mailbox_email;
  const gmail = await getGmailClientForMailbox(mailboxEmail);
  const q = buildGmailQuery(filters);

  await updateRunStatus(runId, { current_status_line: `Listing threads (${q})…` });

  const threadIds = [];
  let pageToken;
  while (threadIds.length < filters.max_threads) {
    const resp = await gmail.users.threads.list({
      userId: 'me',
      q,
      maxResults: Math.min(100, filters.max_threads - threadIds.length),
      pageToken,
    });
    const page = resp.data.threads || [];
    if (!page.length) break;
    for (const t of page) threadIds.push(t.id);
    pageToken = resp.data.nextPageToken;
    if (!pageToken) break;
  }

  await pool.query(
    `UPDATE email_metrics_runs SET total_threads=$2 WHERE id=$1`,
    [runId, threadIds.length]
  );

  const results = [];
  let processed = 0, skipped = 0, errors = 0;
  let totIn = 0, totOut = 0, totCost = 0;

  for (let i = 0; i < threadIds.length; i++) {
    const state = activeRuns.get(runId);
    if (!state || state.cancel) {
      await pool.query(
        `UPDATE email_metrics_runs
            SET status='cancelled', completed_at=NOW(), current_status_line=$2
          WHERE id=$1`,
        [runId, `Cancelled after ${i} of ${threadIds.length} threads`]
      );
      activeRuns.delete(runId);
      return;
    }

    const tid = threadIds[i];
    await updateRunStatus(runId, {
      current_status_line: `Thread ${i + 1}/${threadIds.length}`,
    });

    try {
      const thread = (await gmail.users.threads.get({ userId: 'me', id: tid, format: 'full' })).data;
      const t = analyzeThreadTimings(thread, filters, mailboxEmail);
      if (!t) {
        skipped++;
        continue;
      }
      if (t.skipped) {
        skipped++;
        results.push(t);
        continue;
      }

      // Subject keyword filter
      const subjLower = (t.subject || '').toLowerCase();
      const blocked = (filters.subject_exclude_keywords || []).find(k => k && subjLower.includes(k.toLowerCase()));
      if (blocked) {
        skipped++;
        results.push({ ...t, skipped: true, skip_reason: `subject blocked: "${blocked}"` });
        continue;
      }

      // AI categorization + sentiment
      const { parsed, input_tokens, output_tokens, cost_usd } = await analyzeThreadContent({
        subject: t.subject,
        customerBody: t.customerBody,
        enabled: filters.enable_ai_categorization,
      });
      t.category = parsed.category;
      t.sentiment = filters.enable_sentiment_analysis ? parsed.sentiment : 'neutral';
      t.summary = parsed.summary;
      totIn += input_tokens;
      totOut += output_tokens;
      totCost += cost_usd;

      results.push(t);
      processed++;

      if (processed % 10 === 0 || i === threadIds.length - 1) {
        await pool.query(
          `UPDATE email_metrics_runs
              SET processed_count=$2, skipped_count=$3, error_count=$4,
                  total_input_tokens=$5, total_output_tokens=$6, total_cost_usd=$7
            WHERE id=$1`,
          [runId, processed, skipped, errors, totIn, totOut, totCost]
        );
      }
    } catch (err) {
      errors++;
      console.error(`Metrics thread ${tid} error:`, err.message);
    }
  }

  // Aggregate
  await updateRunStatus(runId, { current_status_line: 'Aggregating…' });
  const repStats = aggregateRepStats(results);
  const categoryStats = aggregateCategoryStats(results);
  const summary = buildSummary(results, filters);

  // Flags
  await updateRunStatus(runId, { current_status_line: 'Computing flags…' });
  let flagCount = 0;
  for (const t of results) {
    for (const f of computeFlagsForThread(t, filters)) {
      await writeFlag(runId, f);
      flagCount++;
    }
  }
  for (const f of computeRepeatProblemFlags(categoryStats, filters)) {
    await writeFlag(runId, f);
    flagCount++;
  }

  await pool.query(
    `UPDATE email_metrics_runs
        SET status='complete', completed_at=NOW(),
            processed_count=$2, skipped_count=$3, error_count=$4,
            flags_created=$5,
            total_input_tokens=$6, total_output_tokens=$7, total_cost_usd=$8,
            rep_stats=$9, category_stats=$10, summary=$11,
            current_status_line=$12
      WHERE id=$1`,
    [
      runId, processed, skipped, errors, flagCount,
      totIn, totOut, totCost,
      JSON.stringify(repStats), JSON.stringify(categoryStats), JSON.stringify(summary),
      `Done — ${processed} processed, ${flagCount} flags, ${skipped} skipped, ${errors} errors`,
    ]
  );
  activeRuns.delete(runId);
}

async function updateRunStatus(runId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE email_metrics_runs SET ${sets} WHERE id = $1`,
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
    `SELECT * FROM email_metrics_runs WHERE id = $1`,
    [runId]
  );
  return r.rows[0] || null;
}

async function listRuns(limit = 20) {
  const r = await pool.query(
    `SELECT id, mailbox_email, started_at, completed_at, status,
            total_threads, processed_count, skipped_count, error_count,
            flags_created, total_cost_usd, current_status_line
       FROM email_metrics_runs
      ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getRunFlags(runId, opts = {}) {
  const wheres = ['run_id = $1'];
  const params = [runId];
  if (opts.flag_type) {
    wheres.push(`flag_type = $${params.length + 1}`);
    params.push(opts.flag_type);
  }
  if (opts.acknowledged === false) {
    wheres.push('acknowledged_at IS NULL');
  }
  const r = await pool.query(
    `SELECT id, run_id, flag_type, severity, gmail_thread_id, thread_subject, thread_date,
            rep_email, customer_email, reason, details, acknowledged_at, created_at
       FROM email_metrics_flags
      WHERE ${wheres.join(' AND ')}
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               created_at DESC
      LIMIT ${parseInt(opts.limit) || 500}`,
    params
  );
  return r.rows;
}

async function acknowledgeFlag(flagId, userId) {
  await pool.query(
    `UPDATE email_metrics_flags
        SET acknowledged_at = NOW(), acknowledged_by = $2
      WHERE id = $1`,
    [flagId, userId || null]
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
  getRunFlags,
  acknowledgeFlag,
  msToHuman,
};
