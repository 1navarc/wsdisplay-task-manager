const { google } = require('googleapis');
const { createOAuth2Client } = require('../config/gmail');
const { pool } = require('../config/database');

function createTasksClient(tokens) {
  const auth = createOAuth2Client();
  auth.setCredentials(tokens);
  return google.tasks({ version: 'v1', auth });
}

// ===== DATABASE OPERATIONS =====

async function listTasks({ assignedTo, createdBy, status, conversationId }) {
  let query = `
    SELECT t.*,
      creator.name as created_by_name, creator.email as created_by_email, creator.avatar_url as created_by_avatar,
      assignee.name as assigned_to_name, assignee.email as assigned_to_email, assignee.avatar_url as assigned_to_avatar,
      c.subject as conv_subject
    FROM tasks t
    LEFT JOIN users creator ON t.created_by = creator.id
    LEFT JOIN users assignee ON t.assigned_to = assignee.id
    LEFT JOIN conversations c ON t.conversation_id = c.id
    WHERE 1=1
  `;
  const params = [];
  let i = 1;

  if (assignedTo) { query += ` AND t.assigned_to = $${i++}`; params.push(assignedTo); }
  if (createdBy) { query += ` AND t.created_by = $${i++}`; params.push(createdBy); }
  if (status) { query += ` AND t.status = $${i++}`; params.push(status); }
  if (conversationId) { query += ` AND t.conversation_id = $${i++}`; params.push(conversationId); }

  query += ' ORDER BY CASE t.priority WHEN \'urgent\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 WHEN \'low\' THEN 4 END, t.created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

async function getTask(taskId) {
  const result = await pool.query(`
    SELECT t.*,
      creator.name as created_by_name, assignee.name as assigned_to_name
    FROM tasks t
    LEFT JOIN users creator ON t.created_by = creator.id
    LEFT JOIN users assignee ON t.assigned_to = assignee.id
    WHERE t.id = $1
  `, [taskId]);
  return result.rows[0];
}

async function createTask({ title, description, priority, assignedTo, createdBy, conversationId, emailSubject, emailFrom, dueDate }) {
  const result = await pool.query(`
    INSERT INTO tasks (title, description, priority, assigned_to, created_by, conversation_id, email_subject, email_from, due_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [title, description || '', priority || 'medium', assignedTo || createdBy, createdBy, conversationId || null, emailSubject || null, emailFrom || null, dueDate || null]);
  return result.rows[0];
}

async function updateTask(taskId, updates) {
  const fields = [];
  const params = [];
  let i = 1;

  if (updates.title !== undefined) { fields.push(`title = $${i++}`); params.push(updates.title); }
  if (updates.description !== undefined) { fields.push(`description = $${i++}`); params.push(updates.description); }
  if (updates.status !== undefined) {
    fields.push(`status = $${i++}`); params.push(updates.status);
    if (updates.status === 'done') {
      fields.push(`completed_at = NOW()`);
    } else {
      fields.push(`completed_at = NULL`);
    }
  }
  if (updates.priority !== undefined) { fields.push(`priority = $${i++}`); params.push(updates.priority); }
  if (updates.assignedTo !== undefined) { fields.push(`assigned_to = $${i++}`); params.push(updates.assignedTo); }
  if (updates.dueDate !== undefined) { fields.push(`due_date = $${i++}`); params.push(updates.dueDate || null); }

  fields.push('updated_at = NOW()');
  params.push(taskId);

  const result = await pool.query(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  return result.rows[0];
}

async function deleteTask(taskId) {
  await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
}

// ===== GOOGLE TASKS SYNC =====

async function syncTaskToGoogle(tokens, task) {
  try {
    const client = createTasksClient(tokens);
    const body = {
      title: task.title,
      notes: task.description || '',
    };
    if (task.due_date) body.due = new Date(task.due_date).toISOString();
    if (task.status === 'done') {
      body.status = 'completed';
      body.completed = task.completed_at ? new Date(task.completed_at).toISOString() : new Date().toISOString();
    } else {
      body.status = 'needsAction';
    }

    let googleTaskId = task.google_task_id;

    if (googleTaskId) {
      // Update existing Google Task
      await client.tasks.patch({
        tasklist: '@default',
        task: googleTaskId,
        requestBody: body,
      });
    } else {
      // Create new Google Task
      const res = await client.tasks.insert({
        tasklist: '@default',
        requestBody: body,
      });
      googleTaskId = res.data.id;
      // Save Google Task ID
      await pool.query('UPDATE tasks SET google_task_id = $1, google_task_synced_at = NOW() WHERE id = $2', [googleTaskId, task.id]);
    }
    return googleTaskId;
  } catch (err) {
    console.error('Google Tasks sync error:', err.message);
    return null;
  }
}

async function syncFromGoogle(tokens, task) {
  if (!task.google_task_id) return null;
  try {
    const client = createTasksClient(tokens);
    const res = await client.tasks.get({
      tasklist: '@default',
      task: task.google_task_id,
    });
    const googleTask = res.data;

    // Check if Google Task status changed
    const googleCompleted = googleTask.status === 'completed';
    const localCompleted = task.status === 'done';

    if (googleCompleted !== localCompleted) {
      const newStatus = googleCompleted ? 'done' : 'open';
      await pool.query(
        'UPDATE tasks SET status = $1, completed_at = $2, updated_at = NOW(), google_task_synced_at = NOW() WHERE id = $3',
        [newStatus, googleCompleted ? new Date() : null, task.id]
      );
      return newStatus;
    }
    return null;
  } catch (err) {
    console.error('Google Tasks sync-from error:', err.message);
    return null;
  }
}

async function deleteFromGoogle(tokens, googleTaskId) {
  if (!googleTaskId) return;
  try {
    const client = createTasksClient(tokens);
    await client.tasks.delete({ tasklist: '@default', task: googleTaskId });
  } catch (err) {
    console.error('Google Tasks delete error:', err.message);
  }
}

module.exports = {
  listTasks, getTask, createTask, updateTask, deleteTask,
  syncTaskToGoogle, syncFromGoogle, deleteFromGoogle,
};
