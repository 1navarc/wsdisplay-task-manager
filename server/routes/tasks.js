const router = require('express').Router();
const { pool } = require('../config/database');
const tasksService = require('../services/tasks');

async function getUserTokens(userId) {
  const result = await pool.query('SELECT google_token FROM users WHERE id = $1', [userId]);
  if (!result.rows[0]?.google_token) return null;
  return typeof result.rows[0].google_token === 'string'
    ? JSON.parse(result.rows[0].google_token)
    : result.rows[0].google_token;
}

// GET /api/tasks — List tasks with filters
router.get('/', async (req, res) => {
  try {
    const { assigned_to, created_by, status, conversation_id, view } = req.query;
    const filters = {};
    if (assigned_to) filters.assignedTo = assigned_to;
    if (created_by) filters.createdBy = created_by;
    if (status) filters.status = status;
    if (conversation_id) filters.conversationId = conversation_id;
    if (view === 'mine') filters.assignedTo = req.session.userId;
    if (view === 'created') filters.createdBy = req.session.userId;

    const tasks = await tasksService.listTasks(filters);

    // Two-way sync: check Google Tasks for status changes
    const tokens = await getUserTokens(req.session.userId);
    if (tokens) {
      for (const task of tasks) {
        if (task.google_task_id && task.assigned_to === req.session.userId) {
          const changed = await tasksService.syncFromGoogle(tokens, task);
          if (changed) task.status = changed;
        }
      }
    }

    res.json(tasks);
  } catch (err) {
    console.error('List tasks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET /api/tasks/stats — Task statistics
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress_count,
        COUNT(*) FILTER (WHERE status = 'done') as done_count,
        COUNT(*) FILTER (WHERE status != 'done' AND due_date < NOW()) as overdue_count,
        COUNT(*) as total_count,
        AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at)) / 3600) FILTER (WHERE status = 'done') as avg_completion_hours
      FROM tasks
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Task stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/tasks — Create a task
router.post('/', async (req, res) => {
  try {
    const { title, description, priority, assignedTo, conversationId, emailSubject, emailFrom, dueDate } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const task = await tasksService.createTask({
      title, description, priority,
      assignedTo: assignedTo || req.session.userId,
      createdBy: req.session.userId,
      conversationId, emailSubject, emailFrom, dueDate,
    });

    // Sync to assignee's Google Tasks
    const assigneeId = assignedTo || req.session.userId;
    const tokens = await getUserTokens(assigneeId);
    if (tokens) {
      await tasksService.syncTaskToGoogle(tokens, task);
    }

    const fullTask = await tasksService.getTask(task.id);
    res.json(fullTask);
  } catch (err) {
    console.error('Create task error:', err.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// POST /api/tasks/from-email — Create task from email conversation
router.post('/from-email', async (req, res) => {
  try {
    const { conversationId, subject, fromEmail, fromName, assignedTo, priority } = req.body;

    const task = await tasksService.createTask({
      title: `Follow up: ${subject || 'Email'}`,
      description: `From: ${fromName || fromEmail || 'Unknown'}\nConversation ID: ${conversationId}`,
      priority: priority || 'medium',
      assignedTo: assignedTo || req.session.userId,
      createdBy: req.session.userId,
      conversationId, emailSubject: subject, emailFrom: fromEmail,
    });

    const assigneeId = assignedTo || req.session.userId;
    const tokens = await getUserTokens(assigneeId);
    if (tokens) {
      await tasksService.syncTaskToGoogle(tokens, task);
    }

    const fullTask = await tasksService.getTask(task.id);
    res.json(fullTask);
  } catch (err) {
    console.error('Create task from email error:', err.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/tasks/:id — Update a task
router.patch('/:id', async (req, res) => {
  try {
    const task = await tasksService.updateTask(req.params.id, req.body);

    // Sync status change to Google Tasks
    const tokens = await getUserTokens(task.assigned_to);
    if (tokens && task.google_task_id) {
      await tasksService.syncTaskToGoogle(tokens, task);
    }

    const fullTask = await tasksService.getTask(task.id);
    res.json(fullTask);
  } catch (err) {
    console.error('Update task error:', err.message);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE /api/tasks/:id — Delete a task
router.delete('/:id', async (req, res) => {
  try {
    const task = await tasksService.getTask(req.params.id);
    if (task?.google_task_id) {
      const tokens = await getUserTokens(task.assigned_to);
      if (tokens) await tasksService.deleteFromGoogle(tokens, task.google_task_id);
    }
    await tasksService.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete task error:', err.message);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// GET /api/tasks/team — Get team members for assignment dropdown
router.get('/team', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, avatar_url, role FROM users ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

module.exports = router;
