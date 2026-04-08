const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function getRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/mailboxes/oauth/callback`;
}

function getOAuth2Client(req) {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, getRedirectUri(req));
}

// GET /api/mailboxes - List all mailboxes
router.get('/', async (req, res) => {
  try {
    // Check if snooze columns exist
    let snoozeFilter = '';
    try {
      const col = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='conversations' AND column_name='is_snoozed'");
      if (col.rows.length > 0) {
        snoozeFilter = ' AND (c.is_snoozed = false OR c.is_snoozed IS NULL OR c.snoozed_until < NOW())';
      }
    } catch(e) {}

    const result = await pool.query(
      `SELECT m.id, m.name, m.email, m.mailbox_type, m.is_active, m.last_synced_at, m.created_at,
              (SELECT COUNT(*) FROM conversations c WHERE c.mailbox_id = m.id AND COALESCE(c.status, 'open') = 'open'${snoozeFilter}) AS unread_count
       FROM mailboxes m ORDER BY m.created_at`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing mailboxes:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mailboxes/oauth/start - Begin OAuth flow (manager only)
router.get('/oauth/start', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const mailboxType = req.query.type || 'personal';
    const mailboxName = req.query.name || '';
    const oauth2Client = getOAuth2Client(req);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/userinfo.email'
      ],
      state: JSON.stringify({ type: mailboxType, name: mailboxName })
    });
    res.json({ authUrl });
  } catch (err) {
    console.error('Error starting OAuth:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mailboxes/oauth/callback - OAuth callback
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    let mailboxType = 'personal';
    let mailboxName = '';
    try {
      const parsed = JSON.parse(state || '{}');
      mailboxType = parsed.type || 'personal';
      mailboxName = parsed.name || '';
    } catch(e) {}

    const oauth2Client = getOAuth2Client(req);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    if (!mailboxName) {
      mailboxName = email.split('@')[0];
    }


    // Check if mailbox already exists
    const existing = await pool.query('SELECT id FROM mailboxes WHERE email = $1', [email]);

    if (existing.rows.length > 0) {
      // Update existing mailbox tokens
      await pool.query(
        `UPDATE mailboxes SET refresh_token = $1, access_token = $2, token_expiry = $3, is_active = true, name = COALESCE(NULLIF($4, ''), name) WHERE email = $5`,
        [tokens.refresh_token, tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, mailboxName, email]
      );
      console.log(`Updated tokens for existing mailbox: ${email}`);
    } else {
      // Create new mailbox
      const id = uuidv4();
      await pool.query(
        `INSERT INTO mailboxes (id, name, email, refresh_token, access_token, token_expiry, mailbox_type, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [id, mailboxName, email, tokens.refresh_token, tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, mailboxType]
      );
      console.log(`Created new mailbox: ${email} (${mailboxType})`);
    }

    // Redirect back to app with success
    res.send(`
      <html><body>
        <h2>Mailbox Connected!</h2>
        <p>${email} has been successfully connected.</p>
        <script>
          setTimeout(function() {
            window.location.href = '/';
          }, 2000);
        </script>
        <p>Redirecting back to app...</p>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`
      <html><body>
        <h2>Connection Failed</h2>
        <p>Error: ${err.message}</p>
        <a href="/">Back to app</a>
      </body></html>
    `);
  }
});

// DELETE /api/mailboxes/:id - Remove a mailbox (manager only)
router.delete('/:id', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    await pool.query('UPDATE mailboxes SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing mailbox:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mailboxes/:id/activate - Reactivate a mailbox
router.post('/:id/activate', async (req, res) => {
  try {
    await pool.query('UPDATE mailboxes SET is_active = true WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error activating mailbox:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/mailboxes/:id - Update mailbox settings (type, name)
router.patch('/:id', async (req, res) => {
  try {
    const { mailbox_type, name } = req.body;
    const sets = []; const params = [req.params.id];
    if (mailbox_type) { params.push(mailbox_type); sets.push('mailbox_type=$' + params.length); }
    if (name !== undefined) { params.push(name); sets.push('name=$' + params.length); }
    if (sets.length === 0) return res.json({ ok: true });
    const result = await pool.query('UPDATE mailboxes SET ' + sets.join(',') + ' WHERE id=$1 RETURNING *', params);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating mailbox:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
