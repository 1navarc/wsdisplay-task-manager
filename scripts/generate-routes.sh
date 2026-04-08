#!/bin/bash
cd ~/wsdisplay-email

# server/routes/auth.js
cat > server/routes/auth.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { SCOPES, createOAuth2Client } = require('../config/gmail');
const { v4: uuidv4 } = require('uuid');

router.get('/google', (req, res) => {
  const client = createOAuth2Client();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
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
        [uuidv4(), data.email, data.name, data.picture, JSON.stringify(tokens), 'agent']
      );
      user = result.rows[0];
    } else {
      await pool.query('UPDATE users SET google_token=$1, name=$2, avatar_url=$3 WHERE id=$4',
        [JSON.stringify(tokens), data.name, data.picture, user.id]);
    }
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = (await pool.query('SELECT id,email,name,avatar_url,role FROM users WHERE id=$1', [req.session.userId])).rows[0];
  res.json(user || { error: 'User not found' });
});

router.post('/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

module.exports = router;
EOF

# server/routes/mailboxes.js
cat > server/routes/mailboxes.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, 
        (SELECT COUNT(*) FROM conversations c WHERE c.mailbox_id=m.id AND c.status='open') as open_count,
        (SELECT COUNT(*) FROM conversations c WHERE c.mailbox_id=m.id AND c.is_read=false) as unread_count
      FROM mailboxes m ORDER BY m.name`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body;
    const result = await pool.query(
      'INSERT INTO mailboxes (id, name, email) VALUES ($1,$2,$3) RETURNING *',
      [require('uuid').v4(), name, email]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
EOF

# server/routes/conversations.js
cat > server/routes/conversations.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { mailbox_id, status, assignee_id, search } = req.query;
    let query = 'SELECT c.*, u.name as assignee_name FROM conversations c LEFT JOIN users u ON c.assignee_id=u.id WHERE 1=1';
    const params = [];
    if (mailbox_id) { params.push(mailbox_id); query += ' AND c.mailbox_id=$'+params.length; }
    if (status) { params.push(status); query += ' AND c.status=$'+params.length; }
    if (assignee_id) { params.push(assignee_id); query += ' AND c.assignee_id=$'+params.length; }
    if (search) { params.push('%'+search+'%'); query += ' AND (c.subject ILIKE $'+params.length+' OR c.from_email ILIKE $'+params.length+')'; }
    query += ' ORDER BY c.last_message_at DESC LIMIT 50';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [conv, msgs, notes, tags] = await Promise.all([
      pool.query('SELECT c.*, u.name as assignee_name FROM conversations c LEFT JOIN users u ON c.assignee_id=u.id WHERE c.id=$1', [req.params.id]),
      pool.query('SELECT * FROM messages WHERE conversation_id=$1 ORDER BY sent_at ASC', [req.params.id]),
      pool.query('SELECT n.*, u.name as author_name FROM internal_notes n JOIN users u ON n.user_id=u.id WHERE n.conversation_id=$1 ORDER BY n.created_at', [req.params.id]),
      pool.query('SELECT t.* FROM tags t JOIN conversation_tags ct ON t.id=ct.tag_id WHERE ct.conversation_id=$1', [req.params.id])
    ]);
    res.json({ ...conv.rows[0], messages: msgs.rows, notes: notes.rows, tags: tags.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { status, assignee_id, priority } = req.body;
    const sets = []; const params = [req.params.id];
    if (status) { params.push(status); sets.push('status=$'+params.length); }
    if (assignee_id !== undefined) { params.push(assignee_id); sets.push('assignee_id=$'+params.length); }
    if (priority) { params.push(priority); sets.push('priority=$'+params.length); }
    if (sets.length === 0) return res.json({ ok: true });
    const result = await pool.query('UPDATE conversations SET '+sets.join(',')+',updated_at=NOW() WHERE id=$1 RETURNING *', params);
    const io = req.app.get('io');
    if (io) io.emit('conversation:updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/notes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'INSERT INTO internal_notes (id, conversation_id, user_id, content) VALUES ($1,$2,$3,$4) RETURNING *',
      [require('uuid').v4(), req.params.id, req.session.userId, req.body.content]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
EOF

# server/routes/tags.js
cat > server/routes/tags.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM tags ORDER BY name');
  res.json(result.rows);
});

router.post('/', requireAuth, async (req, res) => {
  const { name, color } = req.body;
  const result = await pool.query('INSERT INTO tags (id,name,color) VALUES ($1,$2,$3) RETURNING *',
    [require('uuid').v4(), name, color || '#6366f1']);
  res.json(result.rows[0]);
});

module.exports = router;
EOF

# server/routes/canned-responses.js
cat > server/routes/canned-responses.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM canned_responses ORDER BY title');
  res.json(result.rows);
});

router.post('/', requireAuth, async (req, res) => {
  const { title, content, shortcut, category } = req.body;
  const result = await pool.query(
    'INSERT INTO canned_responses (id,title,content,shortcut,category,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [require('uuid').v4(), title, content, shortcut, category, req.session.userId]
  );
  res.json(result.rows[0]);
});

module.exports = router;
EOF

# server/routes/sla.js
cat > server/routes/sla.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/policies', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM sla_policies ORDER BY name');
  res.json(result.rows);
});

router.get('/breaches', requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT c.* FROM conversations c WHERE c.sla_deadline < NOW() AND c.status != 'closed' ORDER BY c.sla_deadline"
  );
  res.json(result.rows);
});

module.exports = router;
EOF

# server/routes/analytics.js
cat > server/routes/analytics.js << 'EOF'
const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/overview', requireAuth, async (req, res) => {
  try {
    const [open, closed, avg] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM conversations WHERE status='open'"),
      pool.query("SELECT COUNT(*) FROM conversations WHERE status='closed' AND updated_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600)::numeric(10,1) as avg_hours FROM conversations WHERE status='closed' AND updated_at > NOW() - INTERVAL '7 days'")
    ]);
    res.json({ open_conversations: parseInt(open.rows[0].count), closed_today: parseInt(closed.rows[0].count), avg_resolution_hours: parseFloat(avg.rows[0].avg_hours) || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
EOF

# server/routes/gmail-webhook.js
cat > server/routes/gmail-webhook.js << 'EOF'
module.exports = async (req, res) => {
  try {
    console.log('Gmail webhook received:', JSON.stringify(req.body));
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK');
  }
};
EOF

# server/services/sla-engine.js
cat > server/services/sla-engine.js << 'EOF'
const { pool } = require('../config/database');

const checkSLAs = async (io) => {
  try {
    const breaches = await pool.query(
      "SELECT * FROM conversations WHERE sla_deadline IS NOT NULL AND sla_deadline < NOW() AND status != 'closed' AND sla_breached = false"
    );
    for (const conv of breaches.rows) {
      await pool.query('UPDATE conversations SET sla_breached=true WHERE id=$1', [conv.id]);
      if (io) io.emit('sla:breach', conv);
    }
  } catch (err) { console.error('SLA check error:', err); }
};

module.exports = { checkSLAs };
EOF

# server/services/gmail-sync.js
cat > server/services/gmail-sync.js << 'EOF'
const { createGmailClient } = require('../config/gmail');
const { pool } = require('../config/database');

class GmailSync {
  static async syncMailbox(mailboxId) {
    console.log('Syncing mailbox:', mailboxId);
  }
}

module.exports = GmailSync;
EOF

# server/socket/index.js
cat > server/socket/index.js << 'EOF'
module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('join:conversation', (convId) => { socket.join('conv:'+convId); });
    socket.on('leave:conversation', (convId) => { socket.leave('conv:'+convId); });
    socket.on('typing', (data) => { socket.to('conv:'+data.conversationId).emit('typing', data); });
    socket.on('disconnect', () => { console.log('Client disconnected:', socket.id); });
  });
};
EOF

echo "=== Route files created ==="
