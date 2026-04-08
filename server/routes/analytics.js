const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── Helper: build WHERE clauses from filter query params ───
function buildFilters(query) {
  const clauses = [];
  const params = [];
  let idx = 1;

  // Period / date range
  const period = query.period || '30d';
  if (period === 'custom' && query.start && query.end) {
    clauses.push(`c.created_at >= $${idx}::timestamp`);
    params.push(query.start);
    idx++;
    clauses.push(`c.created_at <= $${idx}::timestamp + INTERVAL '1 day'`);
    params.push(query.end);
    idx++;
  } else {
    const periodMap = { today: 0, yesterday: 1, '7d': 7, '30d': 30, '90d': 90 };
    let days = periodMap[period];
    if (days === undefined) days = 30;
    if (period === 'today') {
      clauses.push(`c.created_at >= CURRENT_DATE`);
    } else if (period === 'yesterday') {
      clauses.push(`c.created_at >= CURRENT_DATE - INTERVAL '1 day'`);
      clauses.push(`c.created_at < CURRENT_DATE`);
    } else {
      clauses.push(`c.created_at >= CURRENT_DATE - $${idx} * INTERVAL '1 day'`);
      params.push(days);
      idx++;
    }
  }

  // Assignee
  if (query.assignee_id) {
    clauses.push(`c.assignee_id = $${idx}::uuid`);
    params.push(query.assignee_id);
    idx++;
  }

  // Mailbox
  if (query.mailbox_id) {
    clauses.push(`c.mailbox_id = $${idx}::uuid`);
    params.push(query.mailbox_id);
    idx++;
  }

  // Status
  if (query.status && query.status !== 'all') {
    clauses.push(`c.status = $${idx}`);
    params.push(query.status);
    idx++;
  }

  // Priority
  if (query.priority && query.priority !== 'all') {
    clauses.push(`c.priority = $${idx}`);
    params.push(query.priority);
    idx++;
  }

  return { clauses, params, idx };
}

function whereString(clauses) {
  return clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
}

// ─── Helper: get date range days for generate_series ───
function getPeriodDays(query) {
  const period = query.period || '30d';
  if (period === 'custom' && query.start && query.end) {
    return null; // handled differently
  }
  const map = { today: 0, yesterday: 1, '7d': 7, '30d': 30, '90d': 90 };
  return map[period] !== undefined ? map[period] : 30;
}

// ═══════════════════════════════════════════════════════════
// GET /api/analytics/overview
// Returns all 6 KPI values with filter support
// ═══════════════════════════════════════════════════════════
router.get('/overview', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { clauses, params, idx } = buildFilters(req.query);
    const where = whereString(clauses);

    // 1. Tickets solved (closed in period)
    const closedClauses = [...clauses, `c.status = 'closed'`];
    const ticketsSolvedQ = await pool.query(
      `SELECT COUNT(*) FROM conversations c ${whereString(closedClauses)}`,
      params
    );
    const ticketsSolved = parseInt(ticketsSolvedQ.rows[0].count);

    // 2. First response time (median)
    // For each conversation in the period, find the first agent reply
    // Agent reply = message where from_email matches a mailbox email
    const frtQ = await pool.query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_seconds) AS median_seconds
      FROM (
        SELECT EXTRACT(EPOCH FROM (first_reply.sent_at - c.created_at)) AS response_seconds
        FROM conversations c
        INNER JOIN LATERAL (
          SELECT m.sent_at FROM messages m
          WHERE m.conversation_id = c.id
            AND m.from_email IN (SELECT email FROM mailboxes)
          ORDER BY m.sent_at ASC LIMIT 1
        ) first_reply ON true
        ${where}
      ) sub
    `, params);
    const medianFRT = frtQ.rows[0].median_seconds ? parseFloat(frtQ.rows[0].median_seconds) : null;

    // 3. Full resolution time (median) - closed conversations only
    const frtClauses = [...clauses, `c.status = 'closed'`];
    const fullResQ = await pool.query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.updated_at - c.created_at))) AS median_seconds
      FROM conversations c
      ${whereString(frtClauses)}
    `, params);
    const medianResolution = fullResQ.rows[0].median_seconds ? parseFloat(fullResQ.rows[0].median_seconds) : null;

    // 4. One-touch resolution rate
    // Conversations with status='closed' that have exactly 1 agent message
    const oneTouchQ = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE agent_msgs = 1) AS one_touch,
        COUNT(*) AS total_closed
      FROM (
        SELECT c.id,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.from_email IN (SELECT email FROM mailboxes)) AS agent_msgs
        FROM conversations c
        ${whereString([...clauses, `c.status = 'closed'`])}
      ) sub
    `, params);
    const oneTouchCount = parseInt(oneTouchQ.rows[0].one_touch) || 0;
    const totalClosed = parseInt(oneTouchQ.rows[0].total_closed) || 0;
    const oneTouchRate = totalClosed > 0 ? Math.round((oneTouchCount / totalClosed) * 100) : 0;

    // 5. Reopened ticket rate (approximate)
    // Conversations that are currently open but were updated more than 1 hour after creation
    // (suggests they were closed and reopened)
    const reopenedQ = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE c.status = 'open' AND c.updated_at > c.created_at + INTERVAL '1 hour') AS reopened,
        COUNT(*) AS total
      FROM conversations c
      ${where}
    `, params);
    const reopenedCount = parseInt(reopenedQ.rows[0].reopened) || 0;
    const totalConvos = parseInt(reopenedQ.rows[0].total) || 0;
    const reopenedRate = totalConvos > 0 ? Math.round((reopenedCount / totalConvos) * 100) : 0;

    // 6. CSAT - not available yet
    const csat = null;

    // Trend calculation (compare current period to previous equal period)
    const trendQ = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE c.created_at >= CURRENT_DATE - INTERVAL '7 days') AS this_week,
        COUNT(*) FILTER (WHERE c.created_at >= CURRENT_DATE - INTERVAL '14 days' AND c.created_at < CURRENT_DATE - INTERVAL '7 days') AS last_week
      FROM conversations c
    `);
    const thisWeekCount = parseInt(trendQ.rows[0].this_week);
    const lastWeekCount = parseInt(trendQ.rows[0].last_week);
    const trendPercent = lastWeekCount > 0
      ? Math.round(((thisWeekCount - lastWeekCount) / lastWeekCount) * 100)
      : (thisWeekCount > 0 ? 100 : 0);

    res.json({
      tickets_solved: ticketsSolved,
      first_response_time_seconds: medianFRT,
      full_resolution_time_seconds: medianResolution,
      one_touch_rate: oneTouchRate,
      reopened_rate: reopenedRate,
      csat: csat,
      trend_percent: trendPercent,
      total_conversations: totalConvos
    });
  } catch (err) {
    console.error('Analytics overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/analytics/tickets-over-time
// Daily solved counts for the selected period with filters
// ═══════════════════════════════════════════════════════════
router.get('/tickets-over-time', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const period = req.query.period || '30d';
    let dateSeriesSQL;
    let filterParams = [];
    let paramIdx = 1;

    // Build the date series
    if (period === 'custom' && req.query.start && req.query.end) {
      dateSeriesSQL = `generate_series($${paramIdx}::date, $${paramIdx + 1}::date, '1 day'::interval)::date`;
      filterParams.push(req.query.start, req.query.end);
      paramIdx += 2;
    } else {
      const days = getPeriodDays(req.query) || 30;
      dateSeriesSQL = `generate_series((CURRENT_DATE - $${paramIdx} * INTERVAL '1 day')::date, CURRENT_DATE::date, '1 day'::interval)::date`;
      filterParams.push(days);
      paramIdx++;
    }

    // Build additional filter clauses for the closed subquery
    const extraClauses = [];
    if (req.query.assignee_id) {
      extraClauses.push(`c.assignee_id = $${paramIdx}::uuid`);
      filterParams.push(req.query.assignee_id);
      paramIdx++;
    }
    if (req.query.mailbox_id) {
      extraClauses.push(`c.mailbox_id = $${paramIdx}::uuid`);
      filterParams.push(req.query.mailbox_id);
      paramIdx++;
    }
    if (req.query.status && req.query.status !== 'all') {
      extraClauses.push(`c.status = $${paramIdx}`);
      filterParams.push(req.query.status);
      paramIdx++;
    }
    if (req.query.priority && req.query.priority !== 'all') {
      extraClauses.push(`c.priority = $${paramIdx}`);
      filterParams.push(req.query.priority);
      paramIdx++;
    }

    const extraWhere = extraClauses.length > 0 ? ' AND ' + extraClauses.join(' AND ') : '';

    const result = await pool.query(`
      WITH date_series AS (
        SELECT ${dateSeriesSQL} AS date
      )
      SELECT
        ds.date,
        COALESCE(solved.cnt, 0) AS solved,
        COALESCE(incoming.cnt, 0) AS incoming
      FROM date_series ds
      LEFT JOIN (
        SELECT c.updated_at::date AS date, COUNT(*) AS cnt
        FROM conversations c
        WHERE c.status = 'closed' ${extraWhere}
        GROUP BY c.updated_at::date
      ) solved ON solved.date = ds.date
      LEFT JOIN (
        SELECT c.created_at::date AS date, COUNT(*) AS cnt
        FROM conversations c
        WHERE 1=1 ${extraWhere}
        GROUP BY c.created_at::date
      ) incoming ON incoming.date = ds.date
      ORDER BY ds.date ASC
    `, filterParams);

    res.json(result.rows.map(r => ({
      date: r.date,
      solved: parseInt(r.solved),
      incoming: parseInt(r.incoming)
    })));
  } catch (err) {
    console.error('Tickets over time error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/analytics/agent-performance
// Per-agent solved count with filters
// ═══════════════════════════════════════════════════════════
router.get('/agent-performance', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { clauses, params } = buildFilters(req.query);
    const closedClauses = [...clauses, `c.status = 'closed'`];
    const where = whereString(closedClauses);

    const result = await pool.query(`
      SELECT
        u.id,
        u.name,
        COUNT(*) AS solved_count
      FROM conversations c
      JOIN users u ON c.assignee_id = u.id
      ${where}
      GROUP BY u.id, u.name
      ORDER BY solved_count DESC
    `, params);

    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      solved_count: parseInt(r.solved_count)
    })));
  } catch (err) {
    console.error('Agent performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/analytics/ticket-details?page=1&limit=20
// Paginated conversation list with filters
// ═══════════════════════════════════════════════════════════
router.get('/ticket-details', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { clauses, params, idx } = buildFilters(req.query);
    const where = whereString(clauses);

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // Get total count
    const countQ = await pool.query(
      `SELECT COUNT(*) FROM conversations c ${where}`,
      params
    );
    const total = parseInt(countQ.rows[0].count);

    // Get paginated rows
    const detailParams = [...params, limit, offset];
    const result = await pool.query(`
      SELECT
        c.id,
        c.subject,
        COALESCE(u.name, 'Unassigned') AS agent,
        c.status,
        COALESCE(c.priority, 'normal') AS priority,
        c.created_at,
        c.from_email
      FROM conversations c
      LEFT JOIN users u ON c.assignee_id = u.id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, detailParams);

    res.json({
      tickets: result.rows.map(r => ({
        id: r.id,
        subject: r.subject,
        agent: r.agent,
        status: r.status,
        priority: r.priority,
        created_at: r.created_at,
        from_email: r.from_email
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Ticket details error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Legacy endpoints (kept for backward compatibility)
// ═══════════════════════════════════════════════════════════

// GET /api/analytics/team-performance
router.get('/team-performance', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.name,
        COUNT(*) FILTER (WHERE c.status = 'open') AS open_count,
        COUNT(*) FILTER (WHERE c.status = 'closed' AND c.updated_at > NOW() - INTERVAL '7 days') AS closed_count,
        COUNT(*) AS total_assigned,
        COALESCE(AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) / 3600) FILTER (WHERE c.status = 'closed'), 0)::numeric(10,1) AS avg_resolution_hours
      FROM users u
      LEFT JOIN conversations c ON c.assignee_id = u.id
      GROUP BY u.id, u.name
      ORDER BY total_assigned DESC
    `);

    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      open_count: parseInt(r.open_count),
      closed_count: parseInt(r.closed_count),
      total_assigned: parseInt(r.total_assigned),
      avg_resolution_hours: parseFloat(r.avg_resolution_hours) || 0
    })));
  } catch (err) {
    console.error('Team performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/volume?period=7d|30d|90d (legacy)
router.get('/volume', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const periodMap = { '7d': 7, '30d': 30, '90d': 90 };
    const days = periodMap[req.query.period] || 7;

    const result = await pool.query(`
      WITH date_series AS (
        SELECT generate_series(
          (CURRENT_DATE - $1 * INTERVAL '1 day')::date,
          CURRENT_DATE::date,
          '1 day'::interval
        )::date AS date
      )
      SELECT
        ds.date,
        COALESCE(incoming.cnt, 0) AS incoming,
        COALESCE(closed.cnt, 0) AS closed
      FROM date_series ds
      LEFT JOIN (
        SELECT created_at::date AS date, COUNT(*) AS cnt
        FROM conversations
        WHERE created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
        GROUP BY created_at::date
      ) incoming ON incoming.date = ds.date
      LEFT JOIN (
        SELECT updated_at::date AS date, COUNT(*) AS cnt
        FROM conversations
        WHERE status = 'closed' AND updated_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
        GROUP BY updated_at::date
      ) closed ON closed.date = ds.date
      ORDER BY ds.date ASC
    `, [days]);

    res.json(result.rows.map(r => ({
      date: r.date,
      incoming: parseInt(r.incoming),
      closed: parseInt(r.closed)
    })));
  } catch (err) {
    console.error('Volume error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/export?format=csv&period=7d|30d|90d
router.get('/export', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const periodMap = { '7d': 7, '30d': 30, '90d': 90 };
    const days = periodMap[req.query.period] || 30;

    const result = await pool.query(`
      SELECT
        c.created_at::date AS date,
        c.from_email AS "from",
        c.subject,
        COALESCE(c.status, 'open') AS status,
        COALESCE(u.name, 'Unassigned') AS assignee,
        COALESCE(c.priority, 'normal') AS priority,
        (SELECT string_agg(t.name, '; ')
         FROM conversation_tags ct JOIN tags t ON ct.tag_id = t.id
         WHERE ct.conversation_id = c.id) AS tags,
        COALESCE(m.email, m.name, '') AS mailbox,
        c.created_at,
        c.last_message_at AS last_activity
      FROM conversations c
      LEFT JOIN users u ON c.assignee_id = u.id
      LEFT JOIN mailboxes m ON c.mailbox_id = m.id
      WHERE c.created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      ORDER BY c.created_at DESC
    `, [days]);

    const headers = ['Date', 'From', 'Subject', 'Status', 'Assignee', 'Priority', 'Tags', 'Mailbox', 'Created', 'Last Activity'];
    let csv = headers.join(',') + '\n';

    result.rows.forEach(row => {
      const fields = [
        row.date,
        '"' + (row.from || '').replace(/"/g, '""') + '"',
        '"' + (row.subject || '').replace(/"/g, '""') + '"',
        row.status,
        '"' + (row.assignee || '').replace(/"/g, '""') + '"',
        row.priority,
        '"' + (row.tags || '').replace(/"/g, '""') + '"',
        '"' + (row.mailbox || '').replace(/"/g, '""') + '"',
        row.created_at ? new Date(row.created_at).toISOString() : '',
        row.last_activity ? new Date(row.last_activity).toISOString() : ''
      ];
      csv += fields.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="conversations-export-${days}d.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
