const router = require('express').Router();
const { pool } = require('../config/database');
const { SCOPES, createOAuth2Client } = require('../config/gmail');
const { v4: uuidv4 } = require('uuid');

router.get('/google', (req, res) => {
  const client = createOAuth2Client();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'select_account' });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  try {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    const oauth2 = require('googleapis').google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    let user = (await pool.query('SELECT * FROM users WHERE email = $1', [data.email])).rows[0];
    if (!user) {
      const result = await pool.query(
        'INSERT INTO users (id, email, name, avatar_url, google_token, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [uuidv4(), data.email, data.name, data.picture, JSON.stringify(tokens), 'rep']
      );
      user = result.rows[0];
    } else {
      await pool.query('UPDATE users SET google_token=$1, name=$2, avatar_url=$3 WHERE id=$4',
        [JSON.stringify(tokens), data.name, data.picture, user.id]);
    }
    req.session.userId = user.id;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        res.redirect('/?error=session_failed');
      } else {
        res.redirect('/');
      }
    });
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  let user;
  try {
    user = (await pool.query('SELECT id,email,name,avatar_url,role,email_signature FROM users WHERE id=$1', [req.session.userId])).rows[0];
  } catch(e) {
    // Fallback if email_signature column doesn't exist yet
    user = (await pool.query('SELECT id,email,name,avatar_url,role FROM users WHERE id=$1', [req.session.userId])).rows[0];
    if (user) user.email_signature = '';
  }
  res.json(user || { error: 'User not found' });
});

router.put('/signature', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { signature } = req.body;
    await pool.query('UPDATE users SET email_signature = $1 WHERE id = $2', [signature || '', req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update signature error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

module.exports = router;
