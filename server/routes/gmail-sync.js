const { pool } = require('../config/database');
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { syncAllMailboxes, syncMailbox, sendGmailReply } = require('../services/gmail-sync');

// POST /api/gmail/sync - Sync all active mailboxes
router.post('/sync', async (req, res) => {
  try {
    const count = await syncAllMailboxes(pool);
    res.json({ success: true, synced: count });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gmail/sync/:mailboxId - Sync specific mailbox
router.post('/sync/:mailboxId', async (req, res) => {
  try {
    const mailbox = await pool.query('SELECT id, email FROM mailboxes WHERE id = $1', [req.params.mailboxId]);
    if (mailbox.rows.length === 0) {
      return res.status(404).json({ error: 'Mailbox not found' });
    }
    const count = await syncMailbox(pool, mailbox.rows[0].id, mailbox.rows[0].email);
    res.json({ success: true, synced: count });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gmail/send - Send a reply or new email
router.post('/send', async (req, res) => {
  try {
    const { to, subject: rawSubject, body, threadId, conversationId, mailbox_email } = req.body;

    // Ensure Re: prefix for replies
    let subject = rawSubject || '';
    if (conversationId && !/^Re:/i.test(subject)) {
      subject = 'Re: ' + subject;
    }

    // Get the mailbox email — from conversationId (reply) or mailbox_email (new compose)
    let emailAddress = 'info@modco.com';
    let mailboxId = null;
    if (conversationId) {
      const conv = await pool.query('SELECT c.mailbox_id, m.email FROM conversations c JOIN mailboxes m ON c.mailbox_id = m.id WHERE c.id = $1', [conversationId]);
      if (conv.rows.length > 0) {
        emailAddress = conv.rows[0].email;
        mailboxId = conv.rows[0].mailbox_id;
      }
    } else if (mailbox_email) {
      emailAddress = mailbox_email;
      const mbRow = await pool.query('SELECT id FROM mailboxes WHERE email = $1', [mailbox_email]);
      if (mbRow.rows.length > 0) {
        mailboxId = mbRow.rows[0].id;
      }
    }

    const result = await sendGmailReply(pool, emailAddress, to, subject, body, threadId);

    // Insert sent message into DB
    const msgId = uuidv4();
    if (conversationId) {
      // Reply to existing conversation
      await pool.query(
        `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, gmail_message_id, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
         ON CONFLICT (gmail_message_id) DO NOTHING`,
        [msgId, conversationId, emailAddress, to, subject, body, body, result.id, result.threadId]
      );
      await pool.query(
        'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
        [conversationId]
      );
    } else if (mailboxId) {
      // New email — create a new conversation and insert the message
      const convId = uuidv4();
      await pool.query(
        `INSERT INTO conversations (id, mailbox_id, from_email, from_name, subject, status, priority, gmail_thread_id, last_message_at, created_at, is_read)
         VALUES ($1, $2, $3, $4, $5, 'open', 'normal', $6, NOW(), NOW(), false)`,
        [convId, mailboxId, to, to, subject, result.threadId]
      );
      await pool.query(
        `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, gmail_message_id, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)`,
        [msgId, convId, emailAddress, to, subject, body, body, result.id, result.threadId]
      );
    }

    res.json({ success: true, messageId: result.id });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gmail/status - Get sync status
router.get('/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, is_active, last_synced_at, created_at FROM mailboxes ORDER BY created_at');
    res.json(result.rows);
  } catch (err) {
    // Fallback if new columns don't exist yet
    try {
      const result = await pool.query('SELECT id, email, created_at FROM mailboxes ORDER BY created_at');
      res.json(result.rows);
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});

// POST /api/gmail/forward - Forward a conversation to an external email
router.post('/forward', async (req, res) => {
  try {
    const { conversationId, to, note } = req.body;
    if (!conversationId || !to) {
      return res.status(400).json({ error: 'conversationId and to are required' });
    }

    // Get the conversation and its messages
    const convResult = await pool.query(
      'SELECT c.*, m2.email as mailbox_email FROM conversations c JOIN mailboxes m2 ON c.mailbox_id = m2.id WHERE c.id = $1',
      [conversationId]
    );
    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = convResult.rows[0];

    const msgsResult = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at ASC',
      [conversationId]
    );
    const messages = msgsResult.rows;

    // Build forwarded email body
    let forwardedBody = '';
    if (note) {
      forwardedBody += note + '\n\n';
    }
    forwardedBody += '---------- Forwarded message ----------\n';
    forwardedBody += 'From: ' + (conv.from_email || 'Unknown') + '\n';
    forwardedBody += 'Subject: ' + (conv.subject || '(no subject)') + '\n';
    forwardedBody += 'Date: ' + (conv.created_at ? new Date(conv.created_at).toLocaleString() : 'Unknown') + '\n';
    forwardedBody += '\n';

    messages.forEach(msg => {
      forwardedBody += '--- ' + (msg.from_email || 'Unknown') + ' (' + new Date(msg.sent_at).toLocaleString() + ') ---\n';
      forwardedBody += (msg.body_text || '') + '\n\n';
    });

    const subject = 'Fwd: ' + (conv.subject || '');
    const emailAddress = conv.mailbox_email;

    const result = await sendGmailReply(pool, emailAddress, to, subject, forwardedBody, null);

    // Insert forwarded message into DB
    const msgId = uuidv4();
    await pool.query(
      `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, gmail_message_id, gmail_thread_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
       ON CONFLICT (gmail_message_id) DO NOTHING`,
      [msgId, conversationId, emailAddress, to, subject, forwardedBody, forwardedBody, result.id, result.threadId]
    );

    res.json({ success: true, messageId: result.id });
  } catch (err) {
    console.error('Forward error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
