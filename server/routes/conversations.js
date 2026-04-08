const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { mailbox_id, status, assignee_id, search, sort, snoozed } = req.query;
    let query = `SELECT c.*, u.name as assignee_name,
      (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
       FROM conversation_tags ct JOIN tags t ON ct.tag_id = t.id
       WHERE ct.conversation_id = c.id) as tags
      FROM conversations c LEFT JOIN users u ON c.assignee_id=u.id WHERE 1=1`;
    const params = [];

    // Role-based filtering: reps can only see their own + unassigned conversations
    if (req.user && req.user.role === 'rep') {
      params.push(req.user.id);
      query += ' AND (c.assignee_id = $' + params.length + ' OR c.assignee_id IS NULL)';
    }

    if (mailbox_id) { params.push(mailbox_id); query += ' AND c.mailbox_id=$'+params.length; }
    // Check if snooze columns exist before filtering
    let hasSnooze = false;
    try {
      await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='conversations' AND column_name='is_snoozed'");
      hasSnooze = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='conversations' AND column_name='is_snoozed'")).rows.length > 0;
    } catch(e) {}

    if (hasSnooze && snoozed === 'true') {
      query += ' AND c.is_snoozed = true';
    } else if (hasSnooze) {
      query += ' AND (c.is_snoozed = false OR c.is_snoozed IS NULL OR c.snoozed_until < NOW())';
    }
    if (status) { params.push(status); query += ' AND COALESCE(c.status, \'open\')=$'+params.length; }
    if (assignee_id === 'none') {
      query += ' AND c.assignee_id IS NULL';
    } else if (assignee_id) {
      params.push(assignee_id); query += ' AND c.assignee_id=$'+params.length;
    }
    if (req.query.channel === 'sms') {
      query += " AND c.subject ILIKE 'SMS:%'";
    } else if (req.query.channel === 'whatsapp') {
      query += " AND c.subject ILIKE 'WhatsApp:%'";
    } else if (req.query.channel === 'email') {
      query += " AND c.subject NOT ILIKE 'SMS:%' AND c.subject NOT ILIKE 'WhatsApp:%'";
    }
    if (search) { params.push('%'+search+'%'); query += ' AND (c.subject ILIKE $'+params.length+' OR c.from_email ILIKE $'+params.length+')'; }
    const sortMap = {
      date_desc: 'c.last_message_at DESC',
      date_asc: 'c.last_message_at ASC',
      priority: "CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, c.last_message_at DESC",
      assignee: 'u.name ASC NULLS LAST, c.last_message_at DESC'
    };
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    params.push(limit);
    query += ' ORDER BY ' + (sortMap[sort] || sortMap.date_desc) + ' LIMIT $' + params.length;
    if (offset > 0) { params.push(offset); query += ' OFFSET $' + params.length; }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// List all conversations (alternate endpoint)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { mailbox_id, status, assignee_id, search } = req.query;

    let query = `
      SELECT
        c.id,
        c.subject,
        c.from_email,
        c.status,
        c.priority,
        u.name AS assignee_name,
        c.mailbox_id,
        c.created_at,
        c.updated_at,
        c.last_message_at,
        c.is_read,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
        m.body AS last_message_preview,
        (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
         FROM conversation_tags ct JOIN tags t ON ct.tag_id = t.id
         WHERE ct.conversation_id = c.id) as tags
      FROM conversations c
      LEFT JOIN users u ON c.assignee_id = u.id
      LEFT JOIN messages m ON c.id = m.conversation_id
        AND m.id = (
          SELECT id FROM messages
          WHERE conversation_id = c.id
          ORDER BY created_at DESC
          LIMIT 1
        )
      WHERE 1=1
    `;

    const params = [];

    // Role-based filtering: reps can only see their own + unassigned conversations
    if (req.user && req.user.role === 'rep') {
      query += ' AND (c.assignee_id = $' + (params.length + 1) + ' OR c.assignee_id IS NULL)';
      params.push(req.user.id);
    }

    if (mailbox_id) {
      query += ' AND c.mailbox_id = $' + (params.length + 1);
      params.push(mailbox_id);
    }

    if (status) {
      query += ' AND c.status = $' + (params.length + 1);
      params.push(status);
    } else {
      query += ' AND c.status = $' + (params.length + 1);
      params.push('open');
    }

    if (assignee_id) {
      query += ' AND c.assignee_id = $' + (params.length + 1);
      params.push(assignee_id);
    }

    if (search) {
      query += ' AND c.subject ILIKE $' + (params.length + 1);
      params.push('%' + search + '%');
    }

    query += ' ORDER BY c.last_message_at DESC LIMIT 50';

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Error listing conversations:', error);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Create new conversation
router.post('/', requireAuth, async (req, res) => {
  try {
    const { subject, from_email, from_name, mailbox_id, body, priority } = req.body;
    if (!subject || !from_email || !mailbox_id) {
      return res.status(400).json({ error: 'subject, from_email, and mailbox_id are required' });
    }
    const convResult = await pool.query(
      'INSERT INTO conversations (id, mailbox_id, subject, from_email, from_name, status, priority) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [require('uuid').v4(), mailbox_id, subject, from_email, from_name || from_email, 'open', priority || 'medium']
    );
    const conversation = convResult.rows[0];
    if (body) {
      await pool.query(
        'INSERT INTO messages (id, conversation_id, from_email, from_name, to_email, body_text, body_html, direction, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())',
        [require('uuid').v4(), conversation.id, from_email, from_name || from_email, '', body, body, 'inbound']
      );
    }
    const io = req.app.get('io');
    if (io) io.emit('conversation:created', conversation);
    res.status(201).json(conversation);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const [conv, msgs, msgCount, notes, tags] = await Promise.all([
      pool.query('SELECT c.*, u.name as assignee_name FROM conversations c LEFT JOIN users u ON c.assignee_id=u.id WHERE c.id=$1', [req.params.id]),
      pool.query('SELECT id, conversation_id, from_email, from_name, to_email, subject, body_text, body_html, sent_at, gmail_message_id, is_ai_generated FROM messages WHERE conversation_id=$1 ORDER BY sent_at ASC LIMIT $2 OFFSET $3', [req.params.id, limit, offset]),
      pool.query('SELECT COUNT(*) AS total FROM messages WHERE conversation_id=$1', [req.params.id]),
      pool.query('SELECT n.*, u.name as author_name FROM internal_notes n JOIN users u ON n.user_id=u.id WHERE n.conversation_id=$1 ORDER BY n.created_at', [req.params.id]),
      pool.query('SELECT t.* FROM tags t JOIN conversation_tags ct ON t.id=ct.tag_id WHERE ct.conversation_id=$1', [req.params.id])
    ]);
    res.json({ ...conv.rows[0], messages: msgs.rows, totalMessages: parseInt(msgCount.rows[0].total), notes: notes.rows, tags: tags.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { status, assignee_id, priority } = req.body;
    // Fetch current conversation to detect assignee change
    const currentConv = await pool.query('SELECT assignee_id, subject FROM conversations WHERE id = $1', [req.params.id]);
    const oldAssigneeId = currentConv.rows[0] ? currentConv.rows[0].assignee_id : null;
    const convSubject = currentConv.rows[0] ? currentConv.rows[0].subject : '';

    const sets = []; const params = [req.params.id];
    if (status) { params.push(status); sets.push('status=$'+params.length); }
    if (assignee_id !== undefined) { params.push(assignee_id); sets.push('assignee_id=$'+params.length); }
    if (priority) { params.push(priority); sets.push('priority=$'+params.length); }
    if (sets.length === 0) return res.json({ ok: true });
    const result = await pool.query('UPDATE conversations SET '+sets.join(',')+',updated_at=NOW() WHERE id=$1 RETURNING *', params);

    // Create notification when assignee changes
    if (assignee_id && assignee_id !== oldAssigneeId) {
      try {
        await pool.query(
          'INSERT INTO notifications (id, user_id, type, title, message, conversation_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [require('uuid').v4(), assignee_id, 'assigned', "You've been assigned: " + convSubject, null, req.params.id]
        );
      } catch (notifErr) {
        console.error('Failed to create assignment notification:', notifErr.message);
      }
    }

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

// Snooze a conversation
router.post('/:id/snooze', requireAuth, async (req, res) => {
  try {
    const { until } = req.body;
    if (!until) return res.status(400).json({ error: 'until timestamp is required' });
    const result = await pool.query(
      'UPDATE conversations SET is_snoozed = true, snoozed_until = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [until, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
    const io = req.app.get('io');
    if (io) io.emit('conversation:updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unsnooze a conversation
router.post('/:id/unsnooze', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE conversations SET is_snoozed = false, snoozed_until = NULL, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
    const io = req.app.get('io');
    if (io) io.emit('conversation:updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/conversations/:id/merge - Merge another conversation into this one
router.post('/:id/merge', requireAuth, async (req, res) => {
  try {
    const targetId = req.params.id;
    const { merge_into_id } = req.body;

    // If merge_into_id is provided, merge targetId into merge_into_id
    // Otherwise, this is the target and we expect source_ids in the body
    const { source_ids } = req.body;

    if (merge_into_id) {
      // Move all messages from this conversation into merge_into_id
      await pool.query(
        'UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2',
        [merge_into_id, targetId]
      );
      // Move internal notes
      await pool.query(
        'UPDATE internal_notes SET conversation_id = $1 WHERE conversation_id = $2',
        [merge_into_id, targetId]
      ).catch(() => {}); // ignore if internal_notes table doesn't exist

      // Update last_message_at on target
      await pool.query(
        `UPDATE conversations SET last_message_at = (
          SELECT MAX(sent_at) FROM messages WHERE conversation_id = $1
        ), updated_at = NOW() WHERE id = $1`,
        [merge_into_id]
      );

      // Delete source conversation
      await pool.query('DELETE FROM conversation_tags WHERE conversation_id = $1', [targetId]).catch(() => {});
      await pool.query('DELETE FROM conversations WHERE id = $1', [targetId]);

      const io = req.app.get('io');
      if (io) {
        io.emit('conversation:deleted', { id: targetId });
        io.emit('conversation:updated', { id: merge_into_id });
      }

      res.json({ success: true, merged_into: merge_into_id });
    } else if (source_ids && Array.isArray(source_ids)) {
      // Merge multiple source conversations into this one (targetId)
      for (const sourceId of source_ids) {
        if (sourceId === targetId) continue;

        await pool.query(
          'UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2',
          [targetId, sourceId]
        );
        await pool.query(
          'UPDATE internal_notes SET conversation_id = $1 WHERE conversation_id = $2',
          [targetId, sourceId]
        ).catch(() => {});

        // Delete source
        await pool.query('DELETE FROM conversation_tags WHERE conversation_id = $1', [sourceId]).catch(() => {});
        await pool.query('DELETE FROM conversations WHERE id = $1', [sourceId]);
      }

      // Update last_message_at on target
      await pool.query(
        `UPDATE conversations SET last_message_at = (
          SELECT MAX(sent_at) FROM messages WHERE conversation_id = $1
        ), updated_at = NOW() WHERE id = $1`,
        [targetId]
      );

      const io = req.app.get('io');
      if (io) {
        source_ids.forEach(id => io.emit('conversation:deleted', { id }));
        io.emit('conversation:updated', { id: targetId });
      }

      res.json({ success: true, merged_into: targetId, merged_count: source_ids.length });
    } else {
      return res.status(400).json({ error: 'merge_into_id or source_ids is required' });
    }
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
