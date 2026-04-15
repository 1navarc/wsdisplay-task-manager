const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendGmailReply } = require('../services/gmail-sync');

const SITE_URL = process.env.SITE_URL || 'https://wsmail.ws';

function renderInviteEmail({ recipientName, inviterName, role, siteUrl }) {
  const roleLabel = role === 'manager' ? 'Manager' : role === 'supervisor' ? 'Supervisor' : 'Rep';
  const greeting = recipientName ? `Hi ${recipientName.split(' ')[0]},` : 'Hi there,';
  const inviter = inviterName ? inviterName : 'Your team';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <div style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);padding:32px 28px;color:#fff">
        <div style="font-size:13px;opacity:0.85;letter-spacing:0.5px;text-transform:uppercase;font-weight:600">wsmail.ws</div>
        <div style="font-size:24px;font-weight:700;margin-top:8px">You're invited to the team</div>
      </div>
      <div style="padding:32px 28px;font-size:15px;line-height:1.6">
        <p style="margin:0 0 16px">${greeting}</p>
        <p style="margin:0 0 16px">${escapeHtml(inviter)} has invited you to join <strong>wsmail.ws</strong> as a <strong>${roleLabel}</strong>.</p>
        <p style="margin:0 0 24px">wsmail.ws is your team's shared email workspace &mdash; handle customer conversations, track SLAs, and collaborate on replies all in one place.</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${siteUrl}" style="display:inline-block;background:#4f46e5;color:#fff;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px">Sign in to wsmail.ws &rarr;</a>
        </div>
        <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-top:24px;font-size:13px;color:#475569">
          <div style="font-weight:600;color:#1e293b;margin-bottom:6px">How to sign in</div>
          <ol style="margin:0;padding-left:18px">
            <li>Click the button above (or visit <a href="${siteUrl}" style="color:#4f46e5">${siteUrl.replace(/^https?:\/\//,'')}</a>)</li>
            <li>Click <em>Sign in with Google</em></li>
            <li>Choose the Google account matching this email address</li>
          </ol>
        </div>
        <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">If you weren't expecting this invite, you can safely ignore this email.</p>
      </div>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function parseInviteLine(line) {
  // Accepts: "email" | "email, name" | "email, name, role" | "email, role"
  const parts = line.split(/[,;\t]/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validRoles = ['rep', 'supervisor', 'manager'];
  const result = { email: null, name: null, role: null };
  for (const part of parts) {
    if (!result.email && emailRe.test(part)) { result.email = part.toLowerCase(); continue; }
    if (!result.role && validRoles.includes(part.toLowerCase())) { result.role = part.toLowerCase(); continue; }
    if (!result.name) { result.name = part; continue; }
  }
  return result.email ? result : null;
}

// GET /api/manager/employees - list all users
// All roles can fetch the employee list (needed for team display, assignee dropdowns)
// but only managers can modify roles/active status (see PATCH routes below)
router.get('/employees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, role,
              (google_token IS NOT NULL) AS has_signed_in,
              created_at
         FROM users ORDER BY name NULLS LAST, email`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manager/employees/invite - bulk invite team members (manager only)
// Body: { invites: [{email, name?, role?}], default_role?, sender_mailbox?, send_email? }
router.post('/employees/invite', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { invites, default_role, sender_mailbox, send_email, raw_text } = req.body || {};
    const validRoles = ['rep', 'supervisor', 'manager'];
    const defaultRole = validRoles.includes(default_role) ? default_role : 'rep';
    const shouldSendEmail = send_email !== false; // default true

    // Build normalized list either from `invites` array or `raw_text` (multi-line paste)
    let list = [];
    if (Array.isArray(invites)) {
      list = invites.map(inv => ({
        email: (inv.email || '').trim().toLowerCase(),
        name: (inv.name || '').trim() || null,
        role: validRoles.includes(inv.role) ? inv.role : defaultRole
      })).filter(inv => inv.email);
    } else if (typeof raw_text === 'string') {
      const lines = raw_text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parsed = parseInviteLine(trimmed);
        if (parsed) {
          list.push({
            email: parsed.email,
            name: parsed.name,
            role: parsed.role || defaultRole
          });
        }
      }
    }

    if (!list.length) {
      return res.status(400).json({ error: 'No valid email addresses provided' });
    }

    // Figure out sender mailbox (must be connected). Fallback to first connected mailbox.
    let senderEmail = null;
    if (shouldSendEmail) {
      if (sender_mailbox) {
        const mb = await pool.query('SELECT email FROM mailboxes WHERE email = $1', [sender_mailbox]);
        if (mb.rows.length) senderEmail = mb.rows[0].email;
      }
      if (!senderEmail) {
        const firstMb = await pool.query('SELECT email FROM mailboxes ORDER BY created_at LIMIT 1');
        if (firstMb.rows.length) senderEmail = firstMb.rows[0].email;
      }
    }

    // Fetch inviter name for the email copy
    let inviterName = 'A teammate';
    if (req.session?.userId) {
      const inviterRow = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.session.userId]);
      if (inviterRow.rows.length) {
        inviterName = inviterRow.rows[0].name || inviterRow.rows[0].email || inviterName;
      }
    }

    const results = [];
    for (const inv of list) {
      const r = { email: inv.email, role: inv.role, status: 'pending', email_sent: false };
      try {
        const existing = await pool.query('SELECT id, email, name, role, google_token FROM users WHERE email = $1', [inv.email]);
        if (existing.rows.length) {
          // Update role if it changed
          if (existing.rows[0].role !== inv.role) {
            await pool.query('UPDATE users SET role = $1 WHERE email = $2', [inv.role, inv.email]);
            r.status = 'updated';
          } else {
            r.status = 'already_exists';
          }
          r.has_signed_in = !!existing.rows[0].google_token;
        } else {
          // Create user row with no google_token - first sign-in will populate it
          const defaultName = inv.name || inv.email.split('@')[0];
          await pool.query(
            'INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)',
            [uuidv4(), inv.email, defaultName, inv.role]
          );
          r.status = 'created';
          r.has_signed_in = false;
        }

        // Send invite email
        if (shouldSendEmail && senderEmail) {
          try {
            const html = renderInviteEmail({
              recipientName: inv.name,
              inviterName,
              role: inv.role,
              siteUrl: SITE_URL
            });
            await sendGmailReply(
              pool,
              senderEmail,
              inv.email,
              `You've been invited to wsmail.ws`,
              html,
              null
            );
            r.email_sent = true;
          } catch (mailErr) {
            r.email_sent = false;
            r.email_error = mailErr.message;
          }
        }
      } catch (err) {
        r.status = 'error';
        r.error = err.message;
      }
      results.push(r);
    }

    const summary = {
      total: results.length,
      created: results.filter(r => r.status === 'created').length,
      updated: results.filter(r => r.status === 'updated').length,
      already_exists: results.filter(r => r.status === 'already_exists').length,
      errors: results.filter(r => r.status === 'error').length,
      emails_sent: results.filter(r => r.email_sent).length
    };

    res.json({ summary, sender_mailbox: senderEmail, results });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manager/employees/:id/resend-invite - resend invite email to a specific user (manager only)
router.post('/employees/:id/resend-invite', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { sender_mailbox } = req.body || {};
    const userRow = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
    if (!userRow.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRow.rows[0];

    let senderEmail = null;
    if (sender_mailbox) {
      const mb = await pool.query('SELECT email FROM mailboxes WHERE email = $1', [sender_mailbox]);
      if (mb.rows.length) senderEmail = mb.rows[0].email;
    }
    if (!senderEmail) {
      const firstMb = await pool.query('SELECT email FROM mailboxes ORDER BY created_at LIMIT 1');
      if (firstMb.rows.length) senderEmail = firstMb.rows[0].email;
    }
    if (!senderEmail) return res.status(400).json({ error: 'No connected mailbox to send from' });

    let inviterName = 'A teammate';
    if (req.session?.userId) {
      const inviterRow = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.session.userId]);
      if (inviterRow.rows.length) inviterName = inviterRow.rows[0].name || inviterRow.rows[0].email || inviterName;
    }

    const html = renderInviteEmail({
      recipientName: user.name,
      inviterName,
      role: user.role,
      siteUrl: SITE_URL
    });
    await sendGmailReply(pool, senderEmail, user.email, `You've been invited to wsmail.ws`, html, null);
    res.json({ ok: true, email: user.email, sender: senderEmail });
  } catch (err) {
    console.error('Resend invite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/manager/employees/:id/role - update user role (manager only)
router.patch('/employees/:id/role', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['rep', 'supervisor', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be rep, supervisor, or manager.' });
    }

    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, role',
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/manager/employees/:id/active - toggle active (manager only)
router.patch('/employees/:id/active', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const result = await pool.query(
      'SELECT id, email, name, role FROM users WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/manager/teams - list teams
router.get('/teams', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, sla_response_minutes, sla_resolution_minutes, color, created_by, created_at FROM teams ORDER BY name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manager/teams - create team
router.post('/teams', requireAuth, async (req, res) => {
  try {
    const { name, description, sla_response_minutes, sla_resolution_minutes, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Team name required' });
    }

    const result = await pool.query(
      'INSERT INTO teams (name, description, sla_response_minutes, sla_resolution_minutes, color, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
      [name, description || null, sla_response_minutes || 240, sla_resolution_minutes || 1440, color || null, req.user?.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/manager/teams/:id - update team
router.put('/teams/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, sla_response_minutes, sla_resolution_minutes, color } = req.body;

    const result = await pool.query(
      'UPDATE teams SET name = $1, description = $2, sla_response_minutes = $3, sla_resolution_minutes = $4, color = $5 WHERE id = $6 RETURNING *',
      [name, description || null, sla_response_minutes || 240, sla_resolution_minutes || 1440, color || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/manager/teams/:id - delete team
router.delete('/teams/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM teams WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/manager/teams/:id/members - get team members
router.get('/teams/:id/members', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, tm.joined_at
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY u.name`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manager/teams/:id/members - add member
router.post('/teams/:id/members', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }

    const result = await pool.query(
      'INSERT INTO team_members (user_id, team_id, joined_at) VALUES ($1, $2, NOW()) RETURNING *',
      [user_id, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'User already member of this team' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/manager/teams/:id/members/:userId - remove member
router.delete('/teams/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const { id, userId } = req.params;

    const result = await pool.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/manager/labels - list labels
router.get('/labels', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, color, created_at FROM ticket_labels ORDER BY name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manager/labels - create label
router.post('/labels', requireAuth, async (req, res) => {
  try {
    const { name, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Label name required' });
    }

    const result = await pool.query(
      'INSERT INTO ticket_labels (name, color, created_at) VALUES ($1, $2, NOW()) RETURNING *',
      [name, color || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Label already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/manager/labels/:id - delete label
router.delete('/labels/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM ticket_labels WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/manager/dashboard?from=DATE&to=DATE - comprehensive dashboard metrics
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;

    let dateFilter = '';
    let params = [];
    let paramIndex = 1;

    if (from) {
      dateFilter += `AND t.received_at >= $${paramIndex}::timestamp `;
      params.push(from);
      paramIndex++;
    }

    if (to) {
      dateFilter += `AND t.received_at <= $${paramIndex}::timestamp `;
      params.push(to);
      paramIndex++;
    }

    // Summary metrics
    const summaryQuery = `
      SELECT
        COUNT(*) as total_tickets,
        COUNT(*) FILTER (WHERE status = 'resolved' OR status = 'reopened') as resolved_tickets,
        COUNT(*) FILTER (WHERE status IN ('open', 'pending')) as open_tickets,
        ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - received_at))/60)::numeric, 2) as avg_first_response_time_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - received_at))/60)::numeric, 2) as avg_resolution_time_minutes
      FROM email_tickets t
      WHERE 1=1 ${dateFilter}
    `;

    const summaryResult = await pool.query(summaryQuery, params);
    const summary = summaryResult.rows[0];

    // FRT trend (daily)
    const frtQuery = `
      SELECT
        date_trunc('day', received_at)::date as day,
        ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - received_at))/60)::numeric, 2) as avg_frt_minutes,
        COUNT(*) as ticket_count
      FROM email_tickets
      WHERE first_response_at IS NOT NULL ${dateFilter}
      GROUP BY date_trunc('day', received_at)::date
      ORDER BY day ASC
    `;

    const frtResult = await pool.query(frtQuery, params);

    // ART stats
    const artQuery = `
      SELECT
        ROUND(MIN(EXTRACT(EPOCH FROM (resolved_at - received_at))/60)::numeric, 2) as min_art_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - received_at))/60)::numeric, 2) as avg_art_minutes,
        ROUND(MAX(EXTRACT(EPOCH FROM (resolved_at - received_at))/60)::numeric, 2) as max_art_minutes,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - received_at))/60)::numeric, 2) as median_art_minutes
      FROM email_tickets
      WHERE resolved_at IS NOT NULL ${dateFilter}
    `;

    const artResult = await pool.query(artQuery, params);
    const art = artResult.rows[0];

    // SLA achievement per team
    const slaQuery = `
      SELECT
        t.id,
        t.name,
        COUNT(*) as total_tickets,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_response_at - received_at))/60 <= t.sla_response_minutes) as sla_response_met,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (resolved_at - received_at))/60 <= t.sla_resolution_minutes) as sla_resolution_met,
        ROUND(100.0 * COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_response_at - received_at))/60 <= t.sla_response_minutes) / NULLIF(COUNT(*), 0)::numeric, 2) as sla_response_percent,
        ROUND(100.0 * COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (resolved_at - received_at))/60 <= t.sla_resolution_minutes) / NULLIF(COUNT(*), 0)::numeric, 2) as sla_resolution_percent
      FROM email_tickets et
      JOIN teams t ON et.team_id = t.id
      WHERE first_response_at IS NOT NULL ${dateFilter}
      GROUP BY t.id, t.name
      ORDER BY t.name
    `;

    const slaResult = await pool.query(slaQuery, params);

    // Volume (received vs resolved per day)
    const volumeQuery = `
      SELECT
        date_trunc('day', received_at)::date as day,
        COUNT(*) as received,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved
      FROM email_tickets
      WHERE 1=1 ${dateFilter}
      GROUP BY date_trunc('day', received_at)::date
      ORDER BY day ASC
    `;

    const volumeResult = await pool.query(volumeQuery, params);

    // Agent resolutions
    const agentResolutionsQuery = `
      SELECT
        u.id,
        u.name,
        u.email,
        COUNT(*) FILTER (WHERE et.status IN ('resolved', 'reopened')) as resolution_count,
        ROUND(AVG(EXTRACT(EPOCH FROM (et.resolved_at - et.received_at))/60)::numeric, 2) as avg_resolution_time_minutes
      FROM users u
      LEFT JOIN email_tickets et ON u.id = et.assigned_to AND (et.resolved_at IS NOT NULL ${dateFilter})
      WHERE 1=1 ${dateFilter}
      GROUP BY u.id, u.name, u.email
      ORDER BY resolution_count DESC
    `;

    const agentResolutionsResult = await pool.query(agentResolutionsQuery, params);

    // Backlog (open tickets by age bucket)
    const backlogQuery = `
      SELECT
        CASE
          WHEN NOW() - received_at < INTERVAL '1 day' THEN '0-1 days'
          WHEN NOW() - received_at < INTERVAL '3 days' THEN '1-3 days'
          WHEN NOW() - received_at < INTERVAL '7 days' THEN '3-7 days'
          WHEN NOW() - received_at < INTERVAL '14 days' THEN '7-14 days'
          ELSE '14+ days'
        END as age_bucket,
        COUNT(*) as ticket_count
      FROM email_tickets
      WHERE status IN ('open', 'pending') ${dateFilter}
      GROUP BY age_bucket
      ORDER BY age_bucket
    `;

    const backlogResult = await pool.query(backlogQuery, params);

    // Exchange count histogram
    const exchangesQuery = `
      SELECT
        exchange_count,
        COUNT(*) as ticket_count
      FROM email_tickets
      WHERE 1=1 ${dateFilter}
      GROUP BY exchange_count
      ORDER BY exchange_count ASC
    `;

    const exchangesResult = await pool.query(exchangesQuery, params);

    // Reopen rate (daily)
    const reopenRateQuery = `
      SELECT
        date_trunc('day', received_at)::date as day,
        COUNT(*) as total_tickets,
        COUNT(*) FILTER (WHERE reopened_count > 0) as reopened_tickets,
        ROUND(100.0 * COUNT(*) FILTER (WHERE reopened_count > 0) / NULLIF(COUNT(*), 0)::numeric, 2) as reopen_rate_percent
      FROM email_tickets
      WHERE 1=1 ${dateFilter}
      GROUP BY date_trunc('day', received_at)::date
      ORDER BY day ASC
    `;

    const reopenRateResult = await pool.query(reopenRateQuery, params);

    // Heatmap (hour x day_of_week traffic)
    const heatmapQuery = `
      SELECT
        EXTRACT(HOUR FROM received_at)::int as hour,
        EXTRACT(DOW FROM received_at)::int as day_of_week,
        COUNT(*) as ticket_count
      FROM email_tickets
      WHERE 1=1 ${dateFilter}
      GROUP BY EXTRACT(HOUR FROM received_at)::int, EXTRACT(DOW FROM received_at)::int
      ORDER BY hour, day_of_week
    `;

    const heatmapResult = await pool.query(heatmapQuery, params);

    // Agent matrix (speed vs volume scatter)
    const agentMatrixQuery = `
      SELECT
        u.id,
        u.name,
        COUNT(*) as tickets_handled,
        ROUND(AVG(EXTRACT(EPOCH FROM (et.first_response_at - et.received_at))/60)::numeric, 2) as avg_frt_minutes
      FROM users u
      LEFT JOIN email_tickets et ON u.id = et.assigned_to AND (et.first_response_at IS NOT NULL ${dateFilter})
      WHERE 1=1 ${dateFilter}
      GROUP BY u.id, u.name
      ORDER BY tickets_handled DESC
    `;

    const agentMatrixResult = await pool.query(agentMatrixQuery, params);

    // Label distribution
    const labelDistQuery = `
      SELECT
        tl.id,
        tl.name,
        tl.color,
        COUNT(*) as ticket_count
      FROM email_tickets et
      JOIN ticket_labels tl ON et.label = tl.name
      WHERE 1=1 ${dateFilter}
      GROUP BY tl.id, tl.name, tl.color
      ORDER BY ticket_count DESC
    `;

    const labelDistResult = await pool.query(labelDistQuery, params);

    // Agent activity (events per agent)
    const agentActivityQuery = `
      SELECT
        u.id,
        u.name,
        COUNT(*) as event_count,
        COUNT(*) FILTER (WHERE te.event_type = 'replied') as replies_sent,
        COUNT(*) FILTER (WHERE te.event_type = 'resolved') as tickets_resolved
      FROM users u
      LEFT JOIN ticket_events te ON u.id = te.performed_by AND (te.created_at >= COALESCE($1::timestamp, '1900-01-01') ${to ? `AND te.created_at <= $${paramIndex}::timestamp` : ''})
      WHERE 1=1 ${dateFilter}
      GROUP BY u.id, u.name
      ORDER BY event_count DESC
    `;

    const agentActivityParams = [...params];
    const agentActivityResult = await pool.query(agentActivityQuery, agentActivityParams);

    res.json({
      summary,
      frt: { trend: frtResult.rows },
      art,
      sla: slaResult.rows,
      volume: volumeResult.rows,
      agentResolutions: agentResolutionsResult.rows,
      backlog: backlogResult.rows,
      exchanges: exchangesResult.rows,
      reopenRate: reopenRateResult.rows,
      heatmap: heatmapResult.rows,
      agentMatrix: agentMatrixResult.rows,
      labelDist: labelDistResult.rows,
      agentActivity: agentActivityResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manager/dashboard/seed-demo - create demo data
router.post('/dashboard/seed-demo', requireAuth, async (req, res) => {
  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Create 10 demo agents
      const agents = [];
      const agentNames = [
        'Alice Johnson', 'Bob Smith', 'Carol Davis', 'David Wilson', 'Emma Brown',
        'Frank Miller', 'Grace Lee', 'Henry Taylor', 'Iris Martinez', 'Jack Anderson'
      ];

      for (let i = 0; i < agentNames.length; i++) {
        const result = await client.query(
          'INSERT INTO users (email, name, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id',
          [`agent${i+1}@example.com`, agentNames[i], 'rep']
        );
        if (result.rows.length > 0) {
          agents.push(result.rows[0].id);
        } else {
          // Agent already exists, fetch it
          const existing = await client.query(
            'SELECT id FROM users WHERE email = $1',
            [`agent${i+1}@example.com`]
          );
          if (existing.rows.length > 0) {
            agents.push(existing.rows[0].id);
          }
        }
      }

      // Get team IDs
      const teamsResult = await client.query('SELECT id FROM teams LIMIT 5');
      const teams = teamsResult.rows.map(r => r.id);

      // Get label IDs
      const labelsResult = await client.query('SELECT id FROM ticket_labels LIMIT 8');
      const labels = labelsResult.rows.map(r => r.id);

      const priorities = ['low', 'medium', 'high', 'urgent'];
      const statuses = ['open', 'pending', 'resolved', 'reopened'];

      // Create 500 demo tickets over 30 days
      for (let i = 0; i < 500; i++) {
        const daysAgo = Math.floor(Math.random() * 30);
        const hoursAgo = Math.floor(Math.random() * 24);
        const minutesAgo = Math.floor(Math.random() * 60);

        const receivedAt = new Date();
        receivedAt.setDate(receivedAt.getDate() - daysAgo);
        receivedAt.setHours(receivedAt.getHours() - hoursAgo);
        receivedAt.setMinutes(receivedAt.getMinutes() - minutesAgo);

        const priority = priorities[Math.floor(Math.random() * priorities.length)];
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        const assignedAgent = agents[Math.floor(Math.random() * agents.length)];
        const teamId = teams[Math.floor(Math.random() * teams.length)];
        const labelId = labels[Math.floor(Math.random() * labels.length)];

        let firstResponseAt = null;
        let resolvedAt = null;

        if (status !== 'open') {
          firstResponseAt = new Date(receivedAt);
          firstResponseAt.setMinutes(firstResponseAt.getMinutes() + (Math.floor(Math.random() * 480) + 30)); // 30 min to 8 hours
        }

        if (status === 'resolved' || status === 'reopened') {
          resolvedAt = new Date(firstResponseAt || receivedAt);
          resolvedAt.setMinutes(resolvedAt.getMinutes() + (Math.floor(Math.random() * 2880) + 60)); // 1 hour to 48 hours
        }

        const reopenedCount = status === 'reopened' ? 1 : 0;
        const exchangeCount = Math.floor(Math.random() * 8) + 1;
        const labelName = labels.length > 0 ? `label_${labelId}` : 'General';

        await client.query(
          `INSERT INTO email_tickets
           (gmail_message_id, subject, from_email, from_name, assigned_to, team_id, priority, status, label, received_at, first_response_at, resolved_at, reopened_count, exchange_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
          [
            `msg-${i}-${Date.now()}`,
            `Demo Ticket #${i+1}`,
            `customer${i+1}@example.com`,
            `Customer ${i+1}`,
            assignedAgent,
            teamId,
            priority,
            status,
            labelName,
            receivedAt,
            firstResponseAt,
            resolvedAt,
            reopenedCount,
            exchangeCount
          ]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, message: 'Demo data created: 10 agents and 500 tickets' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
