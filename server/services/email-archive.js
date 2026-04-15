/**
 * Email Archive Service
 *
 * Maintains a complete local copy of every email across multiple mailboxes
 * (info@sdsign.com, graphics@sdsign.com, info@wsdisplay.com, graphics@wsdisplay.com)
 * so search and analytics don't re-hit Gmail every time. Supports:
 *
 *   - Backfill: crawls a date range chunk-by-chunk (one month at a time),
 *     stores threads + messages + raw thread JSON. Resumable via the
 *     email_archive_runs table — a run survives Cloud Run restarts and
 *     picks up where it left off.
 *   - Delta sync: uses Gmail's history.list to pull only what changed
 *     since the last cursor. Runs every hour by default.
 *   - Per-mailbox progress: each run row has processed_count / total_threads /
 *     current_status_line / eta_seconds, polled by the UI progress bar.
 *
 * Mailboxes stay separate via the mailbox_email column (denormalized on every
 * row). Search/filter/export naturally scope by mailbox without joins.
 */

const { pool } = require('../config/database');
const em = require('./email-metrics');

// ---------- helpers (some imported from email-metrics) ----------
const {
  getGmailClientForMailbox,
  decodeBody,
  stripQuotedText,
  headerValue,
  extractEmailAddr,
} = em;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'op'} timeout ${ms}ms`)), ms)),
  ]);
}

function domainOf(email) {
  const e = (email || '').toLowerCase();
  const i = e.indexOf('@');
  return i >= 0 ? e.slice(i + 1) : '';
}

/** Decode an HTML part if present, plain otherwise. Returns {html, text}. */
function decodeBodyHtmlAndText(payload) {
  let html = '';
  let text = '';
  function walk(part) {
    if (!part) return;
    if (part.body && part.body.data) {
      const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (part.mimeType === 'text/html' && !html) html = decoded;
      if (part.mimeType === 'text/plain' && !text) text = decoded;
    }
    if (part.parts) for (const p of part.parts) walk(p);
  }
  walk(payload);
  if (!text && html) {
    text = html.replace(/<style[\s\S]*?<\/style>/gi, '')
               .replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]+>/g, ' ')
               .replace(/&nbsp;/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
  }
  return { html: html || null, text: text || '' };
}

function hasAttachment(payload) {
  if (!payload) return false;
  function walk(p) {
    if (!p) return false;
    if (p.filename && p.filename.length > 0) return true;
    if (p.parts) for (const sp of p.parts) if (walk(sp)) return true;
    return false;
  }
  return walk(payload);
}

function parseHeaderEmails(rawHeader) {
  if (!rawHeader) return [];
  return rawHeader
    .split(',')
    .map(s => extractEmailAddr(s.trim()))
    .filter(Boolean);
}

function displayNameFromHeader(raw) {
  if (!raw) return '';
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : '';
}

// ---------- config ----------

const DEFAULT_CONFIG = {
  mailboxes: [
    'info@sdsign.com',
    'graphics@sdsign.com',
    'info@wsdisplay.com',
    'graphics@wsdisplay.com',
  ],
  backfill_years: 2,
  backfill_chunk_months: 1,
  auto_start_backfill_on_deploy: true,
  delta_sync_cron: '0 * * * *',
  max_messages_per_chunk: 5000,
  subject_exclude_keywords: ['out of office', 'auto-reply', 'automatic reply'],
  embedding_model: 'gemini-embedding-001',
  embedding_dimensions: 768,
  embedding_batch_size: 100,
};

async function getConfig() {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'email_archive_config'`);
    if (r.rows.length) return { ...DEFAULT_CONFIG, ...r.rows[0].value };
  } catch (e) { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

async function getConnectedMailboxes() {
  const cfg = await getConfig();
  const r = await pool.query(
    `SELECT email FROM mailboxes
      WHERE refresh_token IS NOT NULL
        AND length(refresh_token) > 0
        AND email = ANY($1::text[])`,
    [cfg.mailboxes]
  );
  return r.rows.map(x => x.email);
}

// ---------- rep resolution context (built per mailbox) ----------

async function buildRepCtx(gmail) {
  const ctx = { labelIdToName: new Map(), signatures: [] };
  try {
    const lr = await withTimeout(
      gmail.users.labels.list({ userId: 'me' }),
      15000, 'gmail.labels.list'
    );
    for (const lbl of (lr.data.labels || [])) {
      if (lbl.id && lbl.name) ctx.labelIdToName.set(lbl.id, lbl.name);
    }
  } catch (e) {
    console.warn('[archive] labels.list failed:', e.message);
  }
  try {
    const sr = await pool.query(
      `SELECT id, name, email, email_signature
         FROM users
        WHERE email_signature IS NOT NULL AND length(trim(email_signature)) > 0`
    );
    ctx.signatures = sr.rows.map(u => ({
      user_id: u.id,
      name: (u.name || '').trim(),
      email: (u.email || '').toLowerCase(),
      signature_norm: ((u.email_signature || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()).slice(0, 200),
    })).filter(s => s.signature_norm.length >= 8);
  } catch (e) {
    console.warn('[archive] signatures load failed:', e.message);
  }
  return ctx;
}

const HIVER_STATUS_TOKENS = new Set([
  'pending', 'open', 'closed', 'resolved', 'reopened',
  'done', 'todo', 'in-progress', 'inprogress', 'snoozed',
  'urgent', 'spam', 'archived', 'unassigned',
]);

function repFromHiverLabels(labelIds, labelIdToName) {
  if (!Array.isArray(labelIds) || !labelIdToName) return null;
  for (const lid of labelIds) {
    const name = labelIdToName.get(lid);
    if (!name) continue;
    if (!/^hiver/i.test(name)) continue;
    const idx = name.indexOf('/');
    if (idx === -1) continue;
    const tail = name.slice(idx + 1).trim().toLowerCase();
    if (!tail) continue;
    const first = tail.split('/')[0];
    if (HIVER_STATUS_TOKENS.has(first)) continue;
    return first;
  }
  return null;
}

function repFromSignature(body, signatures) {
  if (!body || !signatures || !signatures.length) return null;
  const tail = body.slice(-1500).toLowerCase().replace(/\s+/g, ' ');
  let best = null;
  let bestLen = 0;
  for (const s of signatures) {
    if (!s.signature_norm || s.signature_norm.length < 8) continue;
    if (tail.includes(s.signature_norm) && s.signature_norm.length > bestLen) {
      best = s;
      bestLen = s.signature_norm.length;
    }
  }
  return best;
}

function resolveRep(message, ctx) {
  const hiver = repFromHiverLabels(message.labelIds, ctx && ctx.labelIdToName);
  if (hiver) {
    let userMatch = null;
    if (ctx && ctx.signatures) {
      userMatch = ctx.signatures.find(s =>
        (s.name && s.name.toLowerCase() === hiver) ||
        (s.email && s.email.split('@')[0].toLowerCase() === hiver)
      ) || null;
    }
    return {
      rep_email: userMatch ? userMatch.email : (message.from || null),
      rep_key: userMatch ? `user:${userMatch.user_id}` : `hiver:${hiver}`,
      rep_name: userMatch ? userMatch.name : hiver,
    };
  }
  if (message.body && ctx && ctx.signatures && ctx.signatures.length) {
    const sig = repFromSignature(message.body, ctx.signatures);
    if (sig) {
      return {
        rep_email: sig.email,
        rep_key: `user:${sig.user_id}`,
        rep_name: sig.name || sig.email,
      };
    }
  }
  const dn = displayNameFromHeader(message.fromRaw).toLowerCase();
  if (dn) {
    return {
      rep_email: message.from || null,
      rep_key: `name:${dn}`,
      rep_name: dn,
    };
  }
  return {
    rep_email: message.from || null,
    rep_key: `addr:${message.from || 'unknown'}`,
    rep_name: message.from || 'unknown',
  };
}

// ---------- thread parsing ----------

/**
 * Convert a Gmail thread (format=full) into rows for upsert.
 * Returns { thread: {...}, messages: [...] }.
 */
function parseThread(thread, mailboxEmail, ctx) {
  const messages = thread.messages || [];
  if (!messages.length) return null;

  const parsedMessages = [];
  let earliest = null, latest = null;
  let customer_email = null;
  const repEmails = new Set();
  const repKeys = new Set();
  const allLabelIds = new Set();
  let threadHasAttachment = false;
  let threadSubject = '';

  for (const m of messages) {
    const headers = (m.payload && m.payload.headers) || [];
    const fromRaw = headerValue(headers, 'From');
    const from = extractEmailAddr(fromRaw);
    const fromName = displayNameFromHeader(fromRaw);
    const toRaw = headerValue(headers, 'To');
    const ccRaw = headerValue(headers, 'Cc');
    const subject = headerValue(headers, 'Subject') || '';
    if (!threadSubject) threadSubject = subject;

    const dateHeader = headerValue(headers, 'Date');
    const sentMs = m.internalDate ? Number(m.internalDate) : (dateHeader ? new Date(dateHeader).getTime() : null);
    const sentAt = sentMs ? new Date(sentMs).toISOString() : null;

    const { html, text } = decodeBodyHtmlAndText(m.payload);
    const cleanText = stripQuotedText(text);
    const labelIds = m.labelIds || [];
    for (const l of labelIds) allLabelIds.add(l);

    // Direction: outbound if from-address is the mailbox itself; inbound otherwise.
    const isOutbound = from === mailboxEmail.toLowerCase()
      || (labelIds.includes('SENT'));
    const isInbox = labelIds.includes('INBOX');
    const direction = isOutbound ? 'outbound' : (isInbox ? 'inbound' : 'internal');

    const att = hasAttachment(m.payload);
    if (att) threadHasAttachment = true;

    // Capture customer (first non-mailbox sender)
    if (!customer_email && !isOutbound && from && from !== mailboxEmail.toLowerCase()) {
      customer_email = from;
    }

    // Resolve rep identity for outbound messages
    let repInfo = { rep_email: null, rep_key: null, rep_name: null };
    if (isOutbound) {
      repInfo = resolveRep({
        labelIds,
        body: text || '',
        from,
        fromRaw,
      }, ctx);
      if (repInfo.rep_email) repEmails.add(repInfo.rep_email);
      if (repInfo.rep_key) repKeys.add(repInfo.rep_key);
    }

    parsedMessages.push({
      gmail_message_id: m.id,
      sent_at: sentAt,
      direction,
      from_email: from || null,
      from_name: fromName || null,
      to_emails: parseHeaderEmails(toRaw),
      cc_emails: parseHeaderEmails(ccRaw),
      subject,
      body_html: html,
      body_text_clean: cleanText,
      body_text_full: text,
      snippet: m.snippet || '',
      has_attachment: att,
      label_ids: labelIds,
      rep_email: repInfo.rep_email,
      rep_key: repInfo.rep_key,
      rep_name: repInfo.rep_name,
    });

    if (sentMs) {
      if (earliest === null || sentMs < earliest) earliest = sentMs;
      if (latest === null || sentMs > latest) latest = sentMs;
    }
  }

  // Resolve label names for the thread
  const labelNames = [];
  if (ctx && ctx.labelIdToName) {
    for (const lid of allLabelIds) {
      const name = ctx.labelIdToName.get(lid);
      if (name) labelNames.push(name);
    }
  }

  return {
    thread: {
      mailbox_email: mailboxEmail,
      gmail_thread_id: thread.id,
      subject: threadSubject,
      customer_email,
      customer_domain: domainOf(customer_email || ''),
      first_msg_at: earliest ? new Date(earliest).toISOString() : null,
      last_msg_at: latest ? new Date(latest).toISOString() : null,
      message_count: parsedMessages.length,
      rep_emails: Array.from(repEmails),
      rep_keys: Array.from(repKeys),
      label_ids: Array.from(allLabelIds),
      label_names: labelNames,
      has_attachment: threadHasAttachment,
      raw_thread: thread,
    },
    messages: parsedMessages,
  };
}

// ---------- upsert ----------

async function upsertThreadAndMessages(parsed) {
  if (!parsed) return { newThread: false, newMessages: 0 };
  const t = parsed.thread;

  const tr = await pool.query(
    `INSERT INTO email_archive_threads
       (mailbox_email, gmail_thread_id, subject, customer_email, customer_domain,
        first_msg_at, last_msg_at, message_count, rep_emails, rep_keys,
        label_ids, label_names, has_attachment, raw_thread, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT (mailbox_email, gmail_thread_id) DO UPDATE SET
       subject = EXCLUDED.subject,
       customer_email = EXCLUDED.customer_email,
       customer_domain = EXCLUDED.customer_domain,
       first_msg_at = EXCLUDED.first_msg_at,
       last_msg_at = EXCLUDED.last_msg_at,
       message_count = EXCLUDED.message_count,
       rep_emails = EXCLUDED.rep_emails,
       rep_keys = EXCLUDED.rep_keys,
       label_ids = EXCLUDED.label_ids,
       label_names = EXCLUDED.label_names,
       has_attachment = EXCLUDED.has_attachment,
       raw_thread = EXCLUDED.raw_thread,
       synced_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      t.mailbox_email, t.gmail_thread_id, t.subject, t.customer_email, t.customer_domain,
      t.first_msg_at, t.last_msg_at, t.message_count, t.rep_emails, t.rep_keys,
      t.label_ids, t.label_names, t.has_attachment, t.raw_thread,
    ]
  );
  const threadId = tr.rows[0].id;
  const newThread = !!tr.rows[0].inserted;

  let newMessages = 0;
  for (const m of parsed.messages) {
    const mr = await pool.query(
      `INSERT INTO email_archive_messages
         (thread_id, mailbox_email, gmail_message_id, sent_at, direction,
          from_email, from_name, to_emails, cc_emails, subject,
          body_html, body_text_clean, body_text_full, snippet,
          has_attachment, label_ids, rep_email, rep_key, rep_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (mailbox_email, gmail_message_id) DO UPDATE SET
         label_ids = EXCLUDED.label_ids,
         rep_email = EXCLUDED.rep_email,
         rep_key = EXCLUDED.rep_key,
         rep_name = EXCLUDED.rep_name
       RETURNING (xmax = 0) AS inserted`,
      [
        threadId, t.mailbox_email, m.gmail_message_id, m.sent_at, m.direction,
        m.from_email, m.from_name, m.to_emails, m.cc_emails, m.subject,
        m.body_html, m.body_text_clean, m.body_text_full, m.snippet,
        m.has_attachment, m.label_ids, m.rep_email, m.rep_key, m.rep_name,
      ]
    );
    if (mr.rows[0].inserted) newMessages++;
  }
  return { newThread, newMessages };
}

// ---------- run management ----------

async function startRun({ mailboxEmail, runType, dateFrom, dateTo, userId, filterSnapshot }) {
  const r = await pool.query(
    `INSERT INTO email_archive_runs
       (mailbox_email, run_type, date_from, date_to, started_by_user_id, filter_snapshot, current_status_line)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      mailboxEmail, runType,
      dateFrom || null, dateTo || null,
      userId || null, filterSnapshot || null,
      'Initializing…',
    ]
  );
  return r.rows[0];
}

async function updateRun(runId, patch) {
  if (!runId) return;
  const fields = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (!fields.length) return;
  values.push(runId);
  await pool.query(
    `UPDATE email_archive_runs SET ${fields.join(', ')} WHERE id = $${i}`,
    values
  );
}

async function finishRun(runId, status, lastError = null) {
  await updateRun(runId, {
    status,
    completed_at: new Date(),
    last_error: lastError,
    progress_percent: status === 'complete' ? 100 : null,
  });
}

async function checkCancel(runId) {
  const r = await pool.query(`SELECT cancel_requested FROM email_archive_runs WHERE id = $1`, [runId]);
  return !!(r.rows[0] && r.rows[0].cancel_requested);
}

// ---------- Gmail listing helpers ----------

/**
 * List ALL message ids for a mailbox between two dates (inclusive UTC days).
 * Uses gmail.users.messages.list with a date-range query and paginates fully.
 */
async function listMessageIds(gmail, dateFrom, dateTo, max = 50000) {
  const after = dateFrom; // YYYY/MM/DD
  const before = dateTo;
  const q = `after:${after} before:${before}`;
  const ids = new Set();
  let pageToken;
  while (ids.size < max) {
    const resp = await withTimeout(
      gmail.users.messages.list({
        userId: 'me',
        q,
        maxResults: 500,
        pageToken,
      }),
      30000, 'gmail.messages.list'
    );
    const page = resp.data.messages || [];
    if (!page.length) break;
    for (const m of page) ids.add(m.id);
    pageToken = resp.data.nextPageToken;
    if (!pageToken) break;
  }
  return Array.from(ids);
}

/** Get unique thread ids for a date range. Faster than listing every message. */
async function listThreadIds(gmail, dateFrom, dateTo, max = 20000) {
  const q = `after:${dateFrom} before:${dateTo}`;
  const ids = [];
  let pageToken;
  while (ids.length < max) {
    const resp = await withTimeout(
      gmail.users.threads.list({
        userId: 'me',
        q,
        maxResults: 500,
        pageToken,
      }),
      30000, 'gmail.threads.list'
    );
    const page = resp.data.threads || [];
    if (!page.length) break;
    for (const t of page) ids.push(t.id);
    pageToken = resp.data.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

// ---------- chunked backfill ----------

function fmtGmailDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function monthChunks(startISO, endISO) {
  // Returns [{label:'YYYY-MM', from:'YYYY/MM/DD', to:'YYYY/MM/DD'}, ...] oldest-first.
  const chunks = [];
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur < end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    chunks.push({
      label: `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`,
      from: fmtGmailDate(cur),
      to: fmtGmailDate(next),
    });
    cur = next;
  }
  return chunks;
}

/**
 * Backfill a single mailbox between two dates. Chunked by month so that a
 * Cloud Run restart only loses at most one month of progress, and so that
 * a long-running backfill can report month-by-month progress in the UI.
 *
 * If `runId` is provided, this resumes that run (used by resumeIncompleteRuns).
 */
async function backfillMailbox({ mailboxEmail, dateFrom, dateTo, userId, runId }) {
  let run;
  if (runId) {
    const r = await pool.query(`SELECT * FROM email_archive_runs WHERE id = $1`, [runId]);
    run = r.rows[0];
    if (!run) throw new Error('run not found');
  } else {
    run = await startRun({
      mailboxEmail, runType: 'backfill',
      dateFrom, dateTo, userId,
    });
    runId = run.id;
  }

  let gmail, ctx;
  try {
    await updateRun(runId, { current_status_line: `Connecting to Gmail (${mailboxEmail})…` });
    gmail = await getGmailClientForMailbox(mailboxEmail);
    ctx = await buildRepCtx(gmail);
  } catch (e) {
    console.error(`[archive] cannot connect to ${mailboxEmail}:`, e.message);
    await finishRun(runId, 'failed', `Connect failed: ${e.message}`);
    return { runId, status: 'failed' };
  }

  const chunks = monthChunks(dateFrom, dateTo);
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalNewThreads = 0;
  let totalNewMessages = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalCount = 0;

  // Pass 1: count threads in each chunk so we can show a real percentage.
  await updateRun(runId, { current_status_line: 'Counting threads…' });
  const chunkSizes = [];
  for (const c of chunks) {
    if (await checkCancel(runId)) {
      await finishRun(runId, 'cancelled', 'Cancelled during counting phase');
      return { runId, status: 'cancelled' };
    }
    try {
      const ids = await listThreadIds(gmail, c.from, c.to, 20000);
      chunkSizes.push(ids.length);
      totalCount += ids.length;
    } catch (e) {
      console.warn(`[archive] count failed for ${c.label}:`, e.message);
      chunkSizes.push(0);
    }
  }
  await updateRun(runId, { total_threads: totalCount });

  // Pass 2: per-chunk fetch + parse + upsert.
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    if (await checkCancel(runId)) {
      await finishRun(runId, 'cancelled', `Cancelled at chunk ${c.label}`);
      return { runId, status: 'cancelled' };
    }
    await updateRun(runId, {
      current_chunk_label: c.label,
      current_status_line: `Loading ${c.label}…`,
    });

    let threadIds;
    try {
      threadIds = await listThreadIds(gmail, c.from, c.to, 20000);
    } catch (e) {
      console.warn(`[archive] list failed for ${c.label}:`, e.message);
      totalErrors++;
      continue;
    }

    for (let i = 0; i < threadIds.length; i++) {
      // Periodic cancel check (every 25 threads to limit DB hits)
      if (i % 25 === 0 && await checkCancel(runId)) {
        await finishRun(runId, 'cancelled', `Cancelled mid-chunk ${c.label}`);
        return { runId, status: 'cancelled' };
      }

      const tid = threadIds[i];
      try {
        const thread = (await withTimeout(
          gmail.users.threads.get({ userId: 'me', id: tid, format: 'full' }),
          30000, 'gmail.threads.get'
        )).data;
        const parsed = parseThread(thread, mailboxEmail, ctx);
        const r = await upsertThreadAndMessages(parsed);
        if (r.newThread) totalNewThreads++;
        totalNewMessages += r.newMessages;
        totalProcessed++;
      } catch (e) {
        totalErrors++;
        if (totalErrors < 20) {
          console.warn(`[archive] thread ${tid} failed:`, e.message);
        }
      }

      // Progress + ETA every 10 threads
      if (totalProcessed % 10 === 0) {
        const pct = totalCount ? (totalProcessed / totalCount) * 100 : 0;
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = totalProcessed / Math.max(elapsedSec, 1);
        const remaining = Math.max(totalCount - totalProcessed, 0);
        const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
        await updateRun(runId, {
          processed_count: totalProcessed,
          new_threads: totalNewThreads,
          new_messages: totalNewMessages,
          error_count: totalErrors,
          progress_percent: Number(pct.toFixed(2)),
          eta_seconds: etaSec,
          current_status_line: `${c.label}  ·  ${i + 1}/${threadIds.length} in chunk  ·  ${totalProcessed}/${totalCount} total`,
        });
      }
    }
  }

  // Update sync_state cursor with the latest historyId for delta sync going forward.
  let latestHistoryId = null;
  try {
    const profile = await withTimeout(
      gmail.users.getProfile({ userId: 'me' }), 15000, 'gmail.profile'
    );
    latestHistoryId = profile.data.historyId || null;
  } catch (e) { /* ignore */ }

  await pool.query(
    `INSERT INTO email_archive_sync_state
       (mailbox_email, last_history_id, last_synced_at, backfill_completed_at,
        earliest_archived_at, latest_archived_at, total_threads_archived, total_messages_archived)
     VALUES ($1, $2, NOW(), NOW(),
       (SELECT MIN(first_msg_at) FROM email_archive_threads WHERE mailbox_email=$1),
       (SELECT MAX(last_msg_at) FROM email_archive_threads WHERE mailbox_email=$1),
       (SELECT COUNT(*) FROM email_archive_threads WHERE mailbox_email=$1),
       (SELECT COUNT(*) FROM email_archive_messages WHERE mailbox_email=$1))
     ON CONFLICT (mailbox_email) DO UPDATE SET
       last_history_id = EXCLUDED.last_history_id,
       last_synced_at = EXCLUDED.last_synced_at,
       backfill_completed_at = EXCLUDED.backfill_completed_at,
       earliest_archived_at = EXCLUDED.earliest_archived_at,
       latest_archived_at = EXCLUDED.latest_archived_at,
       total_threads_archived = EXCLUDED.total_threads_archived,
       total_messages_archived = EXCLUDED.total_messages_archived`,
    [mailboxEmail, latestHistoryId]
  );

  await updateRun(runId, {
    processed_count: totalProcessed,
    new_threads: totalNewThreads,
    new_messages: totalNewMessages,
    error_count: totalErrors,
    skipped_count: totalSkipped,
    progress_percent: 100,
    current_status_line: `Done · ${totalNewThreads} new threads · ${totalNewMessages} new messages`,
  });
  await finishRun(runId, 'complete');
  return { runId, status: 'complete' };
}

// ---------- delta sync (history.list) ----------

async function deltaSyncMailbox(mailboxEmail) {
  const ss = await pool.query(
    `SELECT last_history_id FROM email_archive_sync_state WHERE mailbox_email = $1`,
    [mailboxEmail]
  );
  const startHistoryId = ss.rows[0] && ss.rows[0].last_history_id;
  if (!startHistoryId) {
    // No cursor yet: skip; backfill must complete first.
    return { mailboxEmail, skipped: true, reason: 'no cursor (backfill not yet complete)' };
  }

  const run = await startRun({ mailboxEmail, runType: 'delta_sync' });
  const runId = run.id;

  let gmail;
  try {
    gmail = await getGmailClientForMailbox(mailboxEmail);
  } catch (e) {
    await finishRun(runId, 'failed', `Connect failed: ${e.message}`);
    return { mailboxEmail, runId, status: 'failed' };
  }

  await updateRun(runId, { current_status_line: 'Pulling history…' });

  // Walk history.list pagination, collecting unique thread ids that changed.
  const changedThreadIds = new Set();
  let pageToken;
  let latestHistoryId = startHistoryId;
  try {
    while (true) {
      const resp = await withTimeout(
        gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
          maxResults: 500,
          pageToken,
        }),
        30000, 'gmail.history.list'
      );
      const histories = resp.data.history || [];
      for (const h of histories) {
        if (h.id) latestHistoryId = h.id;
        const collect = (arr) => {
          for (const x of (arr || [])) {
            const tid = x.message && x.message.threadId;
            if (tid) changedThreadIds.add(tid);
          }
        };
        collect(h.messagesAdded);
        collect(h.labelsAdded);
        collect(h.labelsRemoved);
      }
      pageToken = resp.data.nextPageToken;
      if (!pageToken) break;
    }
  } catch (e) {
    // 404: cursor expired. Fall back to a recent re-pull.
    if ((e.message || '').includes('404') || (e.message || '').includes('Requested entity was not found')) {
      console.warn(`[archive] history cursor expired for ${mailboxEmail}; reseeding`);
      // Reseed cursor only; UI can trigger a new shallow backfill if needed.
      try {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        latestHistoryId = profile.data.historyId;
      } catch (_) {}
      await pool.query(
        `UPDATE email_archive_sync_state SET last_history_id = $2, last_synced_at = NOW() WHERE mailbox_email = $1`,
        [mailboxEmail, latestHistoryId]
      );
      await updateRun(runId, { current_status_line: 'History cursor expired, reseeded' });
      await finishRun(runId, 'complete');
      return { mailboxEmail, runId, status: 'complete', reseeded: true };
    }
    await finishRun(runId, 'failed', e.message);
    return { mailboxEmail, runId, status: 'failed' };
  }

  await updateRun(runId, {
    total_threads: changedThreadIds.size,
    current_status_line: `Updating ${changedThreadIds.size} changed threads…`,
  });

  let processed = 0, newThreads = 0, newMessages = 0, errors = 0;
  const ctx = await buildRepCtx(gmail);
  for (const tid of changedThreadIds) {
    if (processed % 10 === 0 && await checkCancel(runId)) {
      await finishRun(runId, 'cancelled');
      return { mailboxEmail, runId, status: 'cancelled' };
    }
    try {
      const thread = (await withTimeout(
        gmail.users.threads.get({ userId: 'me', id: tid, format: 'full' }),
        30000, 'gmail.threads.get'
      )).data;
      const parsed = parseThread(thread, mailboxEmail, ctx);
      const r = await upsertThreadAndMessages(parsed);
      if (r.newThread) newThreads++;
      newMessages += r.newMessages;
    } catch (e) {
      errors++;
    }
    processed++;
    if (processed % 10 === 0) {
      const pct = changedThreadIds.size ? (processed / changedThreadIds.size) * 100 : 100;
      await updateRun(runId, {
        processed_count: processed,
        new_threads: newThreads,
        new_messages: newMessages,
        error_count: errors,
        progress_percent: Number(pct.toFixed(2)),
      });
    }
  }

  await pool.query(
    `UPDATE email_archive_sync_state
        SET last_history_id = $2, last_synced_at = NOW(),
            latest_archived_at = (SELECT MAX(last_msg_at) FROM email_archive_threads WHERE mailbox_email = $1),
            total_threads_archived = (SELECT COUNT(*) FROM email_archive_threads WHERE mailbox_email = $1),
            total_messages_archived = (SELECT COUNT(*) FROM email_archive_messages WHERE mailbox_email = $1)
      WHERE mailbox_email = $1`,
    [mailboxEmail, latestHistoryId]
  );

  await updateRun(runId, {
    processed_count: processed,
    new_threads: newThreads,
    new_messages: newMessages,
    error_count: errors,
    progress_percent: 100,
    current_status_line: `Synced · ${newThreads} new threads · ${newMessages} new messages`,
  });
  await finishRun(runId, 'complete');
  return { mailboxEmail, runId, status: 'complete', processed, newThreads, newMessages };
}

// ---------- orchestration ----------

/** Sequential backfill across all connected mailboxes. */
async function backfillAll({ years, userId } = {}) {
  const cfg = await getConfig();
  const yrs = years || cfg.backfill_years || 2;
  const connected = await getConnectedMailboxes();
  if (!connected.length) {
    console.warn('[archive] backfillAll: no mailboxes have refresh tokens');
    return { started: [], skipped: cfg.mailboxes };
  }

  const today = new Date();
  const dateTo = today.toISOString().slice(0, 10);
  const fromDate = new Date(Date.UTC(today.getUTCFullYear() - yrs, today.getUTCMonth(), today.getUTCDate()));
  const dateFrom = fromDate.toISOString().slice(0, 10);

  const started = [];
  // Run sequentially in background — don't await all at once.
  (async () => {
    for (const mb of connected) {
      try {
        // Skip if a non-failed backfill already finished.
        const done = await pool.query(
          `SELECT 1 FROM email_archive_sync_state WHERE mailbox_email = $1 AND backfill_completed_at IS NOT NULL`,
          [mb]
        );
        if (done.rows.length) {
          console.log(`[archive] ${mb} already backfilled, skipping`);
          continue;
        }
        console.log(`[archive] backfilling ${mb} ${dateFrom} → ${dateTo}`);
        await backfillMailbox({ mailboxEmail: mb, dateFrom, dateTo, userId });
      } catch (e) {
        console.error(`[archive] backfill failed for ${mb}:`, e);
      }
    }
  })().catch(e => console.error('[archive] backfillAll error:', e));

  for (const mb of connected) started.push(mb);
  return { started, dateFrom, dateTo };
}

/** Run delta sync for every connected mailbox. */
async function deltaSyncAll() {
  const connected = await getConnectedMailboxes();
  const results = [];
  for (const mb of connected) {
    try {
      const r = await deltaSyncMailbox(mb);
      results.push(r);
    } catch (e) {
      console.error(`[archive] delta sync failed for ${mb}:`, e);
      results.push({ mailboxEmail: mb, error: e.message });
    }
  }
  return results;
}

/**
 * On server boot: any backfill run still marked 'running' with no recent
 * heartbeat is presumed orphaned (Cloud Run restarted). Kick off a fresh run
 * for the same date range so progress continues from where it left off
 * (ON CONFLICT DO UPDATE in upsertThreadAndMessages makes that idempotent).
 */
async function resumeIncompleteRuns() {
  try {
    const r = await pool.query(
      `SELECT id, mailbox_email, date_from, date_to, run_type
         FROM email_archive_runs
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '10 minutes'`
    );
    for (const row of r.rows) {
      console.log(`[archive] resuming orphaned run ${row.id} (${row.mailbox_email}, ${row.run_type})`);
      // Mark old as failed
      await finishRun(row.id, 'failed', 'Orphaned (server restart)');
      // Start a fresh run for the same range
      if (row.run_type === 'backfill' && row.date_from && row.date_to) {
        backfillMailbox({
          mailboxEmail: row.mailbox_email,
          dateFrom: row.date_from.toISOString().slice(0, 10),
          dateTo: row.date_to.toISOString().slice(0, 10),
        }).catch(e => console.error(`[archive] resume failed:`, e));
      }
    }
  } catch (e) {
    console.warn('[archive] resumeIncompleteRuns error:', e.message);
  }
}

// ---------- listings for the UI ----------

async function listRuns({ limit = 50 } = {}) {
  const r = await pool.query(
    `SELECT id, mailbox_email, run_type, status, started_at, completed_at,
            total_threads, processed_count, new_threads, new_messages,
            error_count, progress_percent, eta_seconds,
            current_status_line, current_chunk_label, last_error,
            cancel_requested, date_from, date_to
       FROM email_archive_runs
       ORDER BY started_at DESC
       LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function listActiveRuns() {
  const r = await pool.query(
    `SELECT id, mailbox_email, run_type, status, started_at,
            total_threads, processed_count, new_threads, new_messages,
            progress_percent, eta_seconds, current_status_line, current_chunk_label
       FROM email_archive_runs
       WHERE status = 'running' OR (status = 'complete' AND completed_at > NOW() - INTERVAL '10 minutes')
       ORDER BY started_at DESC`
  );
  return r.rows;
}

async function getMailboxStatus() {
  const cfg = await getConfig();
  const r = await pool.query(
    `SELECT mailbox_email,
            backfill_completed_at,
            last_synced_at,
            earliest_archived_at,
            latest_archived_at,
            total_threads_archived,
            total_messages_archived
       FROM email_archive_sync_state
       WHERE mailbox_email = ANY($1::text[])`,
    [cfg.mailboxes]
  );
  const byMailbox = {};
  for (const row of r.rows) byMailbox[row.mailbox_email] = row;

  const connected = await getConnectedMailboxes();
  return cfg.mailboxes.map(m => ({
    mailbox_email: m,
    is_connected: connected.includes(m),
    ...byMailbox[m],
  }));
}

async function requestCancel(runId) {
  await pool.query(`UPDATE email_archive_runs SET cancel_requested = true WHERE id = $1`, [runId]);
}

module.exports = {
  // config & status
  getConfig,
  getConnectedMailboxes,
  getMailboxStatus,
  // runs
  listRuns,
  listActiveRuns,
  requestCancel,
  // backfill / delta
  backfillMailbox,
  backfillAll,
  deltaSyncMailbox,
  deltaSyncAll,
  resumeIncompleteRuns,
  // utility
  parseThread,
  upsertThreadAndMessages,
  buildRepCtx,
};
