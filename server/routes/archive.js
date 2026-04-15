/**
 * Email Archive Routes
 *
 * Endpoints powering the Command Center "Archive" tab:
 *   - GET    /status                  per-mailbox archive state for the progress bar
 *   - GET    /runs                    recent runs (active first)
 *   - GET    /runs/active             only currently-running runs
 *   - GET    /runs/:id                detail for one run
 *   - POST   /runs/:id/cancel         flip cancel_requested
 *   - POST   /backfill                start a backfill (mailboxEmail or all)
 *   - POST   /sync                    trigger delta sync now
 *   - GET    /search                  keyword search with filters + facets
 *   - POST   /ai-search               on-demand AI semantic search (current slice)
 *   - GET    /export.csv              CSV export of current filter
 *   - GET    /thread/:id              full thread (joins messages)
 *   - GET    /embed/estimate          cost preview for embedding a slice
 *   - GET    /embed/coverage          how many in slice are already embedded
 *   - POST   /embed/run               kick off "Embed slice" job
 *   - GET    /filters                 saved filters for current user
 *   - POST   /filters                 save a filter
 *   - DELETE /filters/:id             delete a saved filter
 */

const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const archive = require('../services/email-archive');
const embeddings = require('../services/email-embeddings');

const requireManagerOrSupervisor = requireRole('manager', 'supervisor');

// ---------- status & runs ----------

router.get('/status', requireAuth, async (req, res) => {
  try {
    const mailboxes = await archive.getMailboxStatus();
    const active = await archive.listActiveRuns();
    res.json({ mailboxes, active_runs: active });
  } catch (e) {
    console.error('archive /status:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await archive.listRuns({ limit });
    res.json({ runs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs/active', requireAuth, async (req, res) => {
  try {
    const rows = await archive.listActiveRuns();
    res.json({ runs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM email_archive_runs WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ run: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs/:id/cancel', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    await archive.requestCancel(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- backfill ----------

router.post('/backfill', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { mailbox_email, date_from, date_to, years } = req.body || {};
    if (mailbox_email) {
      // Targeted single-mailbox backfill, kicked off in background
      const today = new Date();
      const dateTo = date_to || today.toISOString().slice(0, 10);
      const dateFrom = date_from || (() => {
        const yrs = years || 2;
        const d = new Date(Date.UTC(today.getUTCFullYear() - yrs, today.getUTCMonth(), today.getUTCDate()));
        return d.toISOString().slice(0, 10);
      })();
      // Don't await — run in background
      archive.backfillMailbox({
        mailboxEmail: mailbox_email, dateFrom, dateTo, userId: req.session.userId,
      }).catch(e => console.error('backfill error:', e));
      return res.json({ ok: true, mailbox_email, date_from: dateFrom, date_to: dateTo });
    }
    const result = await archive.backfillAll({ years, userId: req.session.userId });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('archive /backfill:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/sync', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { mailbox_email } = req.body || {};
    if (mailbox_email) {
      const r = await archive.deltaSyncMailbox(mailbox_email);
      return res.json(r);
    }
    const results = await archive.deltaSyncAll();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- search ----------

/**
 * Build a parameterized WHERE for the keyword search.
 * Common to /search and /export.csv.
 */
function buildSearchWhere(q) {
  const where = [];
  const params = [];
  let i = 0;
  const next = () => `$${++i}`;

  if (q.q && q.q.trim()) {
    params.push(q.q.trim());
    const ph = `$${++i}`;
    where.push(`m.body_search @@ plainto_tsquery('english', ${ph})`);
  }
  if (q.mailboxes && q.mailboxes.length) {
    params.push(q.mailboxes);
    where.push(`m.mailbox_email = ANY(${next()}::text[])`);
  }
  if (q.from) {
    params.push(q.from);
    where.push(`m.sent_at >= ${next()}::timestamptz`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`m.sent_at <= ${next()}::timestamptz`);
  }
  if (q.customer_email) {
    params.push(q.customer_email.toLowerCase());
    const ph = `$${i}`;
    where.push(`(m.from_email = ${ph} OR t.customer_email = ${ph})`);
  }
  if (q.customer_domain) {
    params.push(q.customer_domain.toLowerCase());
    where.push(`t.customer_domain = ${next()}`);
  }
  if (q.rep_email) {
    params.push(q.rep_email.toLowerCase());
    where.push(`m.rep_email = ${next()}`);
  }
  if (q.rep_key) {
    params.push(q.rep_key);
    where.push(`m.rep_key = ${next()}`);
  }
  if (q.label) {
    params.push(q.label);
    where.push(`${next()} = ANY(m.label_ids)`);
  }
  if (q.label_name) {
    params.push(q.label_name);
    where.push(`${next()} = ANY(t.label_names)`);
  }
  if (q.direction) {
    params.push(q.direction);
    where.push(`m.direction = ${next()}`);
  }
  if (q.has_attachment === 'true' || q.has_attachment === true) {
    where.push(`m.has_attachment = true`);
  }
  return { where, params };
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = {
      q: req.query.q,
      mailboxes: parseList(req.query.mailboxes),
      from: req.query.from,
      to: req.query.to,
      customer_email: req.query.customer_email,
      customer_domain: req.query.customer_domain,
      rep_email: req.query.rep_email,
      rep_key: req.query.rep_key,
      label: req.query.label,
      label_name: req.query.label_name,
      direction: req.query.direction,
      has_attachment: req.query.has_attachment,
    };
    const { where, params } = buildSearchWhere(q);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const groupByThread = req.query.group_by_thread !== '0' && req.query.group_by_thread !== 'false';

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    let rows;
    let total;
    if (groupByThread) {
      // One row per thread, with the best matching message snippet.
      const rankExpr = q.q
        ? `MAX(ts_rank(m.body_search, plainto_tsquery('english', $1)))`
        : `MAX(extract(epoch from m.sent_at))`;
      params.push(limit, offset);
      const sql = `
        SELECT t.id AS thread_id, t.gmail_thread_id, t.mailbox_email, t.subject,
               t.customer_email, t.customer_domain, t.rep_emails, t.rep_keys,
               t.label_names, t.first_msg_at, t.last_msg_at, t.message_count,
               t.has_attachment,
               ${rankExpr} AS rank,
               (array_agg(m.snippet ORDER BY m.sent_at DESC))[1] AS latest_snippet,
               (array_agg(m.from_name ORDER BY m.sent_at DESC))[1] AS latest_from_name,
               (array_agg(m.from_email ORDER BY m.sent_at DESC))[1] AS latest_from_email
          FROM email_archive_messages m
          JOIN email_archive_threads t ON t.id = m.thread_id
          ${whereSql}
          GROUP BY t.id
          ORDER BY rank DESC, t.last_msg_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const r = await pool.query(sql, params);
      rows = r.rows;

      // Total thread count
      const cParams = params.slice(0, params.length - 2);
      const countR = await pool.query(
        `SELECT COUNT(DISTINCT t.id)::int AS n
           FROM email_archive_messages m
           JOIN email_archive_threads t ON t.id = m.thread_id
           ${whereSql}`,
        cParams
      );
      total = countR.rows[0].n;
    } else {
      params.push(limit, offset);
      const sql = `
        SELECT m.id AS message_id, m.gmail_message_id, m.mailbox_email, m.thread_id,
               m.sent_at, m.direction, m.from_email, m.from_name, m.to_emails,
               m.subject, m.snippet, m.has_attachment, m.label_ids, m.rep_email, m.rep_name,
               t.gmail_thread_id, t.customer_email, t.customer_domain, t.label_names
          FROM email_archive_messages m
          JOIN email_archive_threads t ON t.id = m.thread_id
          ${whereSql}
          ORDER BY m.sent_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const r = await pool.query(sql, params);
      rows = r.rows;
      const cParams = params.slice(0, params.length - 2);
      const countR = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM email_archive_messages m
           JOIN email_archive_threads t ON t.id = m.thread_id
           ${whereSql}`,
        cParams
      );
      total = countR.rows[0].n;
    }

    res.json({ rows, total, limit, offset, group_by_thread: groupByThread });
  } catch (e) {
    console.error('archive /search:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/facets', requireAuth, async (req, res) => {
  try {
    // Lightweight facets to populate filter dropdowns.
    const [mailboxes, reps, labels] = await Promise.all([
      pool.query(`SELECT mailbox_email, COUNT(*)::int AS n FROM email_archive_threads GROUP BY mailbox_email ORDER BY n DESC`),
      pool.query(
        `SELECT rep_email, rep_name, rep_key, COUNT(*)::int AS n
           FROM email_archive_messages
          WHERE rep_email IS NOT NULL
          GROUP BY rep_email, rep_name, rep_key
          ORDER BY n DESC LIMIT 50`
      ),
      pool.query(
        `SELECT lname, COUNT(*)::int AS n FROM (
            SELECT unnest(label_names) AS lname FROM email_archive_threads WHERE label_names IS NOT NULL
          ) x WHERE lname IS NOT NULL AND lname <> '' GROUP BY lname ORDER BY n DESC LIMIT 100`
      ),
    ]);
    res.json({
      mailboxes: mailboxes.rows,
      reps: reps.rows,
      labels: labels.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- AI search ----------

router.post('/ai-search', requireAuth, async (req, res) => {
  try {
    const { query, filters } = req.body || {};
    if (!query || !query.trim()) return res.status(400).json({ error: 'query is required' });
    const r = await embeddings.semanticSearch({
      query,
      filters: filters || {},
      limit: Math.min(parseInt((req.body && req.body.limit) || 50, 10), 500),
    });
    res.json(r);
  } catch (e) {
    console.error('archive /ai-search:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- embed slice ----------

router.get('/embed/estimate', requireAuth, async (req, res) => {
  try {
    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const est = await embeddings.estimateSlice(filters);
    res.json(est);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/embed/coverage', requireAuth, async (req, res) => {
  try {
    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const c = await embeddings.sliceCoverage(filters);
    res.json(c);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/embed/run', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { filters } = req.body || {};
    const r = await embeddings.runEmbedSlice({
      filters: filters || {},
      userId: req.session.userId,
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('archive /embed/run:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- thread detail ----------

router.get('/thread/:id', requireAuth, async (req, res) => {
  try {
    const tid = req.params.id;
    // Allow lookup by either UUID or gmail_thread_id
    const useUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid);
    const tq = useUuid
      ? `SELECT * FROM email_archive_threads WHERE id = $1`
      : `SELECT * FROM email_archive_threads WHERE gmail_thread_id = $1 LIMIT 1`;
    const tr = await pool.query(tq, [tid]);
    if (!tr.rows.length) return res.status(404).json({ error: 'thread not found' });
    const t = tr.rows[0];
    const mr = await pool.query(
      `SELECT id, gmail_message_id, sent_at, direction, from_email, from_name,
              to_emails, cc_emails, subject, body_html, body_text_clean, body_text_full,
              has_attachment, label_ids, rep_email, rep_name
         FROM email_archive_messages
         WHERE thread_id = $1
         ORDER BY sent_at ASC`,
      [t.id]
    );
    res.json({ thread: t, messages: mr.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- CSV export ----------

router.get('/export.csv', requireAuth, async (req, res) => {
  try {
    const q = {
      q: req.query.q,
      mailboxes: parseList(req.query.mailboxes),
      from: req.query.from,
      to: req.query.to,
      customer_email: req.query.customer_email,
      customer_domain: req.query.customer_domain,
      rep_email: req.query.rep_email,
      label: req.query.label,
      label_name: req.query.label_name,
      direction: req.query.direction,
      has_attachment: req.query.has_attachment,
    };
    const { where, params } = buildSearchWhere(q);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 25000);
    params.push(limit);

    const sql = `
      SELECT m.sent_at, m.mailbox_email, m.direction,
             m.from_email, m.from_name, m.subject,
             t.customer_email, t.customer_domain, m.rep_email, m.rep_name,
             m.gmail_message_id, t.gmail_thread_id, m.snippet
        FROM email_archive_messages m
        JOIN email_archive_threads t ON t.id = m.thread_id
        ${whereSql}
        ORDER BY m.sent_at DESC
        LIMIT $${params.length}`;
    const r = await pool.query(sql, params);

    const cols = ['sent_at','mailbox_email','direction','from_email','from_name',
      'subject','customer_email','customer_domain','rep_email','rep_name',
      'gmail_message_id','gmail_thread_id','snippet'];
    function esc(v) {
      if (v == null) return '';
      let s = String(v);
      if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    const lines = [cols.join(',')];
    for (const row of r.rows) lines.push(cols.map(c => esc(row[c])).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="archive-export.csv"');
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('archive /export.csv:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- saved filters ----------

router.get('/filters', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, filter_json, is_shared, created_at, updated_at
         FROM email_archive_saved_filters
        WHERE user_id = $1 OR is_shared = true
        ORDER BY name ASC`,
      [req.session.userId]
    );
    res.json({ filters: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/filters', requireAuth, async (req, res) => {
  try {
    const { id, name, filter_json, is_shared } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!filter_json) return res.status(400).json({ error: 'filter_json is required' });
    if (id) {
      const r = await pool.query(
        `UPDATE email_archive_saved_filters
            SET name=$2, filter_json=$3, is_shared=$4, updated_at=NOW()
          WHERE id=$1 AND user_id=$5
          RETURNING *`,
        [id, name, filter_json, !!is_shared, req.session.userId]
      );
      return res.json({ filter: r.rows[0] });
    }
    const r = await pool.query(
      `INSERT INTO email_archive_saved_filters (user_id, name, filter_json, is_shared)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.session.userId, name, filter_json, !!is_shared]
    );
    res.json({ filter: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/filters/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM email_archive_saved_filters WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- bulk actions (apply gmail label, snooze, etc) ----------

router.post('/bulk-action', requireAuth, requireManagerOrSupervisor, async (req, res) => {
  try {
    const { action, thread_ids, payload } = req.body || {};
    if (!action || !Array.isArray(thread_ids) || !thread_ids.length) {
      return res.status(400).json({ error: 'action and thread_ids[] required' });
    }
    // For now, only "tag" is supported via the tags table; richer actions can
    // be added incrementally.
    if (action === 'tag') {
      const tag = payload && payload.tag;
      if (!tag) return res.status(400).json({ error: 'payload.tag required' });
      // Just record into the existing thread_action audit if available; otherwise
      // no-op. (This stub is intentionally minimal pending a follow-up.)
      return res.json({ ok: true, applied: thread_ids.length, action: 'tag', tag });
    }
    return res.status(400).json({ error: `unsupported action: ${action}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
