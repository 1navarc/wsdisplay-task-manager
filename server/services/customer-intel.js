/**
 * Customer Intelligence — type a company / domain / email / person / order ref
 * and get a 360° actionable profile back.
 *
 * Returns 4 cards' worth of data:
 *   1. Health & risk score   (with AI-generated "next best action")
 *   2. Top keywords / topics (from email_archive_classifications)
 *   3. Conversation timeline (every thread, click-into-able by gmail_thread_id)
 *   4. Rep relationships     (who handled them, response time, quality scores)
 *
 * Read-only on existing tables. Health summary uses Gemini 2.5 Flash with a
 * cap on context size so cost stays predictable (one short prompt per profile
 * load, ~$0.0002 each).
 */

const { pool } = require('../config/database');
const { getGenAI } = require('./ai-service');

const MODEL = 'gemini-2.5-flash';

// -----------------------------------------------------------------------------
// SEARCH — match a free-text query against threads/messages and rank candidates
// -----------------------------------------------------------------------------

/**
 * Quick suggester for the autocomplete dropdown. Returns up to N candidates
 * grouped by entity_type (domain, customer_email, person_name, order_ref).
 * Cheap query — no AI, just SQL aggregations on the archive tables.
 */
async function searchCandidates({ q, limit = 12 }) {
  if (!q || !q.trim()) return [];
  const term = q.trim().toLowerCase();
  const like = `%${term}%`;
  const exact = term;

  const out = [];

  // 1) Domain match (most useful for B2B per user's preference)
  const dom = await pool.query(`
    SELECT customer_domain AS key,
           customer_domain AS label,
           COUNT(DISTINCT id) AS thread_count,
           MAX(last_msg_at) AS last_seen,
           ARRAY_AGG(DISTINCT customer_email) FILTER (WHERE customer_email IS NOT NULL) AS contacts
      FROM email_archive_threads
     WHERE customer_domain IS NOT NULL
       AND LOWER(customer_domain) LIKE $1
       AND junk_status IS DISTINCT FROM 'blocked'
     GROUP BY customer_domain
     ORDER BY thread_count DESC, last_seen DESC
     LIMIT $2`, [like, limit]);
  for (const r of dom.rows) {
    out.push({
      type: 'domain',
      key: r.key,
      label: r.label,
      sublabel: `${r.thread_count} threads · ${(r.contacts || []).length} contacts`,
      thread_count: Number(r.thread_count),
      last_seen: r.last_seen,
    });
  }

  // 2) Customer email match
  const em = await pool.query(`
    SELECT customer_email AS key,
           customer_email AS label,
           customer_domain AS sublabel,
           COUNT(DISTINCT id) AS thread_count,
           MAX(last_msg_at) AS last_seen
      FROM email_archive_threads
     WHERE customer_email IS NOT NULL
       AND LOWER(customer_email) LIKE $1
       AND junk_status IS DISTINCT FROM 'blocked'
     GROUP BY customer_email, customer_domain
     ORDER BY thread_count DESC, last_seen DESC
     LIMIT $2`, [like, limit]);
  for (const r of em.rows) {
    out.push({
      type: 'email',
      key: r.key,
      label: r.label,
      sublabel: `${r.thread_count} threads · ${r.sublabel || ''}`,
      thread_count: Number(r.thread_count),
      last_seen: r.last_seen,
    });
  }

  // 3) Person name match (from message.from_name on inbound)
  const ppl = await pool.query(`
    SELECT m.from_name AS label,
           m.from_email AS key,
           COUNT(DISTINCT m.thread_id)::int AS thread_count,
           MAX(m.sent_at) AS last_seen
      FROM email_archive_messages m
      JOIN email_archive_threads t ON t.id = m.thread_id AND t.junk_status IS DISTINCT FROM 'blocked'
     WHERE m.direction = 'inbound'
       AND m.from_name IS NOT NULL
       AND LOWER(m.from_name) LIKE $1
     GROUP BY m.from_name, m.from_email
     ORDER BY thread_count DESC, last_seen DESC
     LIMIT $2`, [like, Math.max(4, Math.floor(limit/2))]);
  for (const r of ppl.rows) {
    out.push({
      type: 'person',
      key: r.key,
      label: r.label,
      sublabel: `${r.thread_count} threads · ${r.key || ''}`,
      thread_count: Number(r.thread_count),
      last_seen: r.last_seen,
    });
  }

  // 4) Order/quote ref in subject (ALL CAPS or alphanumeric token like Q-1234, PO-9876, INV-5)
  // Only worth searching if the term looks like a ref (has digits)
  if (/\d/.test(term) && term.length >= 3) {
    const subj = await pool.query(`
      SELECT t.subject AS label,
             t.gmail_thread_id AS key,
             t.customer_email AS sublabel,
             1::int AS thread_count,
             t.last_msg_at AS last_seen
        FROM email_archive_threads t
       WHERE LOWER(t.subject) LIKE $1
       ORDER BY t.last_msg_at DESC
       LIMIT $2`, [like, 6]);
    for (const r of subj.rows) {
      out.push({
        type: 'subject',
        key: r.key,
        label: r.label,
        sublabel: r.sublabel || '',
        thread_count: 1,
        last_seen: r.last_seen,
      });
    }
  }

  // De-dupe by (type,key) and trim
  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    const k = r.type + '|' + (r.key || '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

// -----------------------------------------------------------------------------
// RESOLVE — turn (type, key) into a thread-id list scoped to that entity
// -----------------------------------------------------------------------------

async function resolveThreadIds({ type, key }) {
  if (!key) return [];
  if (type === 'domain') {
    const r = await pool.query(
      `SELECT id, gmail_thread_id, customer_email, customer_domain
         FROM email_archive_threads
        WHERE customer_domain = $1
        ORDER BY last_msg_at DESC NULLS LAST`,
      [key.toLowerCase()]
    );
    return r.rows;
  }
  if (type === 'email') {
    const r = await pool.query(
      `SELECT id, gmail_thread_id, customer_email, customer_domain
         FROM email_archive_threads
        WHERE customer_email = $1
        ORDER BY last_msg_at DESC NULLS LAST`,
      [key.toLowerCase()]
    );
    return r.rows;
  }
  if (type === 'person') {
    // person-key is usually the from_email on inbound; gather all threads
    // where that person appears as a sender.
    const r = await pool.query(
      `SELECT DISTINCT t.id, t.gmail_thread_id, t.customer_email, t.customer_domain
         FROM email_archive_threads t
         JOIN email_archive_messages m ON m.thread_id = t.id
        WHERE m.from_email = $1 AND m.direction = 'inbound'
        ORDER BY t.id`,
      [key.toLowerCase()]
    );
    return r.rows;
  }
  if (type === 'subject') {
    // Order/quote ref — single thread by gmail_thread_id
    const r = await pool.query(
      `SELECT id, gmail_thread_id, customer_email, customer_domain
         FROM email_archive_threads
        WHERE gmail_thread_id = $1
        LIMIT 1`,
      [key]
    );
    return r.rows;
  }
  // Fallback: try interpreting as email or domain
  if (key.includes('@')) return resolveThreadIds({ type: 'email', key });
  if (key.includes('.')) return resolveThreadIds({ type: 'domain', key });
  return [];
}

// -----------------------------------------------------------------------------
// PROFILE — build the full Customer 360 payload
// -----------------------------------------------------------------------------

async function getProfile({ type, key, days = 365 }) {
  const threads = await resolveThreadIds({ type, key });
  if (!threads.length) return { found: false, type, key };

  const threadIds = threads.map(t => t.id);
  // De-dupe domains/emails (in case search was by person)
  const domains = [...new Set(threads.map(t => t.customer_domain).filter(Boolean))];
  const emails = [...new Set(threads.map(t => t.customer_email).filter(Boolean))];

  // ---- 1. Header / overview ----
  const header = await pool.query(`
    SELECT COUNT(DISTINCT t.id)::int AS total_threads,
           COUNT(m.id)::int AS total_messages,
           SUM(CASE WHEN m.direction='inbound' THEN 1 ELSE 0 END)::int AS inbound_count,
           SUM(CASE WHEN m.direction='outbound' THEN 1 ELSE 0 END)::int AS outbound_count,
           MIN(t.first_msg_at) AS first_contact,
           MAX(t.last_msg_at) AS last_contact,
           ARRAY_AGG(DISTINCT t.mailbox_email) AS mailboxes
      FROM email_archive_threads t
      LEFT JOIN email_archive_messages m ON m.thread_id = t.id
     WHERE t.id = ANY($1::uuid[])`,
    [threadIds]
  );

  // ---- 2. Health metrics ----
  const health = await pool.query(`
    SELECT SUM(CASE WHEN c.is_complaint THEN 1 ELSE 0 END)::int AS complaints,
           SUM(CASE WHEN c.asks_for_manager THEN 1 ELSE 0 END)::int AS escalations,
           SUM(CASE WHEN c.is_damage_claim THEN 1 ELSE 0 END)::int AS damage_claims,
           SUM(CASE WHEN c.sentiment='negative' THEN 1 ELSE 0 END)::int AS negative_msgs,
           SUM(CASE WHEN c.sentiment='positive' THEN 1 ELSE 0 END)::int AS positive_msgs,
           SUM(CASE WHEN c.sentiment='neutral'  THEN 1 ELSE 0 END)::int AS neutral_msgs,
           COUNT(c.message_id)::int AS classified_count
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE m.thread_id = ANY($1::uuid[])`,
    [threadIds]
  );

  // ---- 3. Open attention items for this customer ----
  const attention = await pool.query(`
    SELECT id, item_type, severity, title, summary, snippet, gmail_thread_id, detected_at
      FROM manager_attention_items
     WHERE status = 'open'
       AND (
         thread_id = ANY($1::uuid[])
         OR ($2::text[] <> '{}' AND customer_email = ANY($2::text[]))
         OR ($3::text[] <> '{}' AND customer_domain = ANY($3::text[]))
       )
     ORDER BY severity DESC, detected_at DESC
     LIMIT 20`,
    [threadIds, emails, domains]
  );

  // ---- 4. Top keywords ----
  const keywords = await pool.query(`
    SELECT kw, COUNT(*)::int AS volume
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id,
           UNNEST(COALESCE(c.keywords, ARRAY[]::text[])) AS kw
     WHERE m.thread_id = ANY($1::uuid[])
     GROUP BY kw
     ORDER BY volume DESC
     LIMIT 25`,
    [threadIds]
  );

  // ---- 5. Question type breakdown ----
  const qtypes = await pool.query(`
    SELECT c.question_type, COUNT(*)::int AS volume
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE m.thread_id = ANY($1::uuid[])
       AND c.question_type IS NOT NULL
     GROUP BY c.question_type
     ORDER BY volume DESC`,
    [threadIds]
  );

  // ---- 6. Product-line breakdown ----
  const products = await pool.query(`
    SELECT c.product_line, COUNT(*)::int AS volume
      FROM email_archive_classifications c
      JOIN email_archive_messages m ON m.id = c.message_id
     WHERE m.thread_id = ANY($1::uuid[])
       AND c.product_line IS NOT NULL
     GROUP BY c.product_line
     ORDER BY volume DESC
     LIMIT 12`,
    [threadIds]
  );

  // ---- 7. Conversation timeline (one row per thread) ----
  const timeline = await pool.query(`
    SELECT t.id, t.gmail_thread_id, t.subject, t.mailbox_email,
           t.customer_email, t.first_msg_at, t.last_msg_at, t.message_count,
           t.has_attachment, t.label_names, t.rep_emails,
           (SELECT m.snippet FROM email_archive_messages m
              WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS latest_snippet,
           (SELECT m.direction FROM email_archive_messages m
              WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS latest_direction,
           (SELECT bool_or(c.is_complaint) FROM email_archive_classifications c
              JOIN email_archive_messages mm ON mm.id = c.message_id
             WHERE mm.thread_id = t.id) AS has_complaint,
           (SELECT bool_or(c.is_damage_claim) FROM email_archive_classifications c
              JOIN email_archive_messages mm ON mm.id = c.message_id
             WHERE mm.thread_id = t.id) AS has_damage_claim
      FROM email_archive_threads t
     WHERE t.id = ANY($1::uuid[])
     ORDER BY t.last_msg_at DESC NULLS LAST
     LIMIT 100`,
    [threadIds]
  );

  // ---- 8. Rep relationships + response stats ----
  const reps = await pool.query(`
    SELECT m.rep_email,
           COALESCE(MAX(m.rep_name), m.rep_email) AS rep_name,
           COUNT(*)::int AS reply_count,
           COUNT(DISTINCT m.thread_id)::int AS thread_count,
           MAX(m.sent_at) AS last_reply_at,
           AVG(g.overall_score)::numeric(3,2) AS avg_quality,
           MIN(g.overall_score) AS worst_quality,
           MAX(g.overall_score) AS best_quality,
           COUNT(g.message_id)::int AS graded_count
      FROM email_archive_messages m
      LEFT JOIN email_archive_rep_grades g ON g.message_id = m.id
     WHERE m.thread_id = ANY($1::uuid[])
       AND m.direction = 'outbound'
       AND m.rep_email IS NOT NULL
     GROUP BY m.rep_email
     ORDER BY reply_count DESC`,
    [threadIds]
  );

  // ---- 9. Avg first-response time on this customer's inbound msgs ----
  const responseStats = await pool.query(`
    WITH paired AS (
      SELECT m_in.thread_id,
             m_in.sent_at AS inbound_at,
             (SELECT MIN(m_out.sent_at)
                FROM email_archive_messages m_out
               WHERE m_out.thread_id = m_in.thread_id
                 AND m_out.direction = 'outbound'
                 AND m_out.sent_at > m_in.sent_at) AS first_outbound_at
        FROM email_archive_messages m_in
       WHERE m_in.thread_id = ANY($1::uuid[])
         AND m_in.direction = 'inbound'
    )
    SELECT AVG(EXTRACT(EPOCH FROM (first_outbound_at - inbound_at)))::numeric AS avg_response_seconds,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - inbound_at))) AS median_response_seconds,
           COUNT(first_outbound_at) FILTER (WHERE first_outbound_at IS NOT NULL)::int AS responded_count,
           COUNT(*) FILTER (WHERE first_outbound_at IS NULL)::int AS unanswered_count
      FROM paired`,
    [threadIds]
  );

  const overview = header.rows[0] || {};
  const h = health.rows[0] || {};
  const r = responseStats.rows[0] || {};

  // ---- 10. Risk score (rules-based 0..100, lower = healthier) ----
  const totalMsgs = Number(h.classified_count || 0);
  const negShare = totalMsgs ? (Number(h.negative_msgs) / totalMsgs) : 0;
  const posShare = totalMsgs ? (Number(h.positive_msgs) / totalMsgs) : 0;
  const daysSinceContact = overview.last_contact
    ? Math.floor((Date.now() - new Date(overview.last_contact).getTime()) / 86400000)
    : null;

  let risk = 0;
  risk += Math.min(40, Number(h.complaints || 0) * 8);
  risk += Math.min(20, Number(h.escalations || 0) * 10);
  risk += Math.min(20, Number(h.damage_claims || 0) * 10);
  risk += Math.min(15, Math.round(negShare * 100));
  risk += Math.min(10, Number(r.unanswered_count || 0) * 5);
  risk -= Math.min(10, Math.round(posShare * 20));
  risk = Math.max(0, Math.min(100, Math.round(risk)));
  const riskLabel = risk >= 60 ? 'high' : risk >= 30 ? 'medium' : 'low';
  const riskColor = risk >= 60 ? '#dc2626' : risk >= 30 ? '#f59e0b' : '#059669';

  return {
    found: true,
    type, key,
    identity: {
      domains, emails,
      label: type === 'domain' ? key : (type === 'email' ? key : (emails[0] || domains[0] || key)),
      first_contact: overview.first_contact,
      last_contact: overview.last_contact,
      days_since_contact: daysSinceContact,
      mailboxes: overview.mailboxes || [],
      total_threads: Number(overview.total_threads || 0),
      total_messages: Number(overview.total_messages || 0),
      inbound_count: Number(overview.inbound_count || 0),
      outbound_count: Number(overview.outbound_count || 0),
    },
    health: {
      score: risk,
      label: riskLabel,
      color: riskColor,
      complaints: Number(h.complaints || 0),
      escalations: Number(h.escalations || 0),
      damage_claims: Number(h.damage_claims || 0),
      negative_msgs: Number(h.negative_msgs || 0),
      positive_msgs: Number(h.positive_msgs || 0),
      neutral_msgs: Number(h.neutral_msgs || 0),
      classified_count: totalMsgs,
      sentiment_pct: {
        negative: totalMsgs ? Math.round(negShare * 100) : 0,
        positive: totalMsgs ? Math.round(posShare * 100) : 0,
        neutral:  totalMsgs ? 100 - Math.round(negShare * 100) - Math.round(posShare * 100) : 0,
      },
    },
    response: {
      avg_seconds: r.avg_response_seconds ? Number(r.avg_response_seconds) : null,
      median_seconds: r.median_response_seconds ? Number(r.median_response_seconds) : null,
      responded_count: Number(r.responded_count || 0),
      unanswered_count: Number(r.unanswered_count || 0),
    },
    open_attention: attention.rows,
    keywords: keywords.rows.map(k => ({ kw: k.kw, volume: Number(k.volume) })),
    question_types: qtypes.rows.map(q => ({ type: q.question_type, volume: Number(q.volume) })),
    product_lines: products.rows.map(p => ({ product: p.product_line, volume: Number(p.volume) })),
    timeline: timeline.rows,
    reps: reps.rows.map(r => ({
      rep_email: r.rep_email,
      rep_name: r.rep_name,
      reply_count: Number(r.reply_count),
      thread_count: Number(r.thread_count),
      last_reply_at: r.last_reply_at,
      avg_quality: r.avg_quality ? Number(r.avg_quality) : null,
      worst_quality: r.worst_quality ? Number(r.worst_quality) : null,
      best_quality: r.best_quality ? Number(r.best_quality) : null,
      graded_count: Number(r.graded_count),
    })),
  };
}

// -----------------------------------------------------------------------------
// AI SUMMARY — small one-shot prompt to draft a "next best action" recommendation
// Cached lightly via the caller (not per-request) — cost ~$0.0002 per call.
// -----------------------------------------------------------------------------

async function generateNextBestAction(profile) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({ model: MODEL, generationConfig: { temperature: 0.3 } });

  const recentSubjects = (profile.timeline || []).slice(0, 12).map(t =>
    `${new Date(t.last_msg_at).toLocaleDateString()} — ${t.subject || '(no subject)'}`
  ).join('\n');
  const topKw = (profile.keywords || []).slice(0, 12).map(k => k.kw).join(', ');
  const topQt = (profile.question_types || []).slice(0, 6).map(q => `${q.type}(${q.volume})`).join(', ');

  const prompt = `You write 1-paragraph "next best action" recommendations for the customer-support manager at WSDisplay/SDSign (banner stands, signs, displays).

CUSTOMER: ${profile.identity.label}
- ${profile.identity.total_threads} threads, ${profile.identity.total_messages} messages
- Days since last contact: ${profile.identity.days_since_contact ?? 'never'}
- Risk score: ${profile.health.score}/100 (${profile.health.label})
- Complaints: ${profile.health.complaints} · Escalations: ${profile.health.escalations} · Damage claims: ${profile.health.damage_claims}
- Sentiment mix: ${profile.health.sentiment_pct.positive}% positive / ${profile.health.sentiment_pct.neutral}% neutral / ${profile.health.sentiment_pct.negative}% negative
- Open attention items: ${profile.open_attention.length}
- Avg response time on inbound: ${profile.response.avg_seconds ? Math.round(profile.response.avg_seconds/3600) + 'h' : 'n/a'}
- Unanswered inbound msgs: ${profile.response.unanswered_count}
- Top keywords: ${topKw}
- Top question types: ${topQt}

RECENT SUBJECTS:
${recentSubjects}

Write 2 short sections, each 1 sentence:

NEXT BEST ACTION: a single specific action this manager should take RIGHT NOW for this account (e.g. "call to follow up on the damage claim from 4/2", "send a thank-you sample for their reorder", "loop in supervisor to clear the unanswered email from 3/28"). Skip platitudes — be specific to what you see in the data.

WATCHOUTS: one sentence flagging anything risky or unusual (recurring complaint, churn signal, response-time problem, etc.). If nothing's wrong, say "Account looks healthy — no watchouts."

Return strict JSON:
{ "next_best_action": "...", "watchouts": "..." }`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(json);
    return {
      next_best_action: parsed.next_best_action || '',
      watchouts: parsed.watchouts || '',
    };
  } catch (e) {
    return {
      next_best_action: '',
      watchouts: '',
      error: e.message,
    };
  }
}

module.exports = {
  searchCandidates,
  resolveThreadIds,
  getProfile,
  generateNextBestAction,
};
