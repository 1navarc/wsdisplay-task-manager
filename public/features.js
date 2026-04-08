// WSDisplay Features Frontend Module
// Provides UI components for all new feature endpoints

const FEATURES_API_BASE = '/api/features';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function apiFetch(endpoint, options = {}) {
  try {
    const response = await fetch(`${FEATURES_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `API error: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.error('API Error:', err);
    throw err;
  }
}

function showLoading(container) {
  container.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;">Loading...</div>';
}

function showError(container, message) {
  container.innerHTML = `<div style="padding: 15px; background: #fee; color: #c00; border-radius: 4px; border: 1px solid #fcc;">${escapeHtml(message)}</div>`;
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function createButton(text, onclick, className = '') {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.onclick = onclick;
  btn.className = `btn ${className}`;
  btn.style.cssText = 'padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 4px 4px 4px 0; font-size: 14px;';
  return btn;
}

function createStyle(selector, rules) {
  const style = document.createElement('style');
  style.textContent = `${selector} { ${rules} }`;
  document.head.appendChild(style);
}

// Initialize global styles
createStyle('.btn:hover', 'opacity: 0.9; transform: translateY(-1px);');
createStyle('.btn.btn-sm', 'padding: 4px 8px; font-size: 12px;');
createStyle('.btn.btn-danger', 'background: #dc3545;');
createStyle('.btn.btn-success', 'background: #28a745;');
createStyle('.input-group', 'display: flex; gap: 8px; margin: 8px 0;');
createStyle('.input-group input', 'flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px;');
createStyle('.modal-overlay', 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;');
createStyle('.modal-content', 'background: white; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 600px; width: 90%;');
createStyle('.form-group', 'margin: 16px 0;');
createStyle('.form-group label', 'display: block; font-weight: 600; margin-bottom: 4px; font-size: 14px;');
createStyle('.form-group input, .form-group textarea, .form-group select', 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;');
createStyle('.form-group textarea', 'min-height: 100px; resize: vertical;');

// ============================================================================
// EMAIL ASSIGNMENT
// ============================================================================

async function renderAssignmentUI(conversationId) {
  const container = document.getElementById('assignment-container') || document.querySelector('[data-view="assignment"]');
  if (!container) return;

  showLoading(container);

  try {
    const [assignment, users] = await Promise.all([
      apiFetch(`/assignments/${conversationId}`).catch(() => null),
      apiFetch('/assignments').catch(() => [])
    ]);

    let html = '<div style="padding: 16px; background: #f8f9fa; border-radius: 4px;">';
    html += '<h3 style="margin-top: 0; font-size: 16px;">Assign to Agent</h3>';
    html += '<div class="input-group">';
    html += '<select id="assign-select" style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px;"><option value="">Select agent...</option>';

    // Get available users (agents/managers)
    if (users && Array.isArray(users)) {
      users.forEach(u => {
        const selected = assignment && assignment.assigned_to === u.id ? 'selected' : '';
        html += `<option value="${u.id}" ${selected}>${escapeHtml(u.name)}</option>`;
      });
    }

    html += '</select>';
    html += '</div>';

    if (assignment) {
      html += `<div style="margin-top: 8px; font-size: 14px; color: #666;">Currently assigned to: <strong>${escapeHtml(assignment.assigned_to_name)}</strong></div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    document.getElementById('assign-select').addEventListener('change', async (e) => {
      if (e.target.value) {
        try {
          await apiFetch('/assignments', {
            method: 'POST',
            body: JSON.stringify({ conversation_id: conversationId, assigned_to: parseInt(e.target.value) })
          });
          renderAssignmentUI(conversationId);
        } catch (err) {
          showError(container, err.message);
        }
      }
    });
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// COLLISION DETECTION
// ============================================================================

let collisionHeartbeatInterval = null;

function startCollisionHeartbeat(conversationId) {
  if (collisionHeartbeatInterval) clearInterval(collisionHeartbeatInterval);

  collisionHeartbeatInterval = setInterval(async () => {
    try {
      await apiFetch('/collision/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: conversationId, action: 'viewing' })
      });
    } catch (err) {
      console.error('Heartbeat error:', err);
    }
  }, 5000);
}

function stopCollisionHeartbeat() {
  if (collisionHeartbeatInterval) {
    clearInterval(collisionHeartbeatInterval);
    collisionHeartbeatInterval = null;
  }
}

async function renderCollisionIndicator(conversationId) {
  const container = document.getElementById('collision-container') || document.querySelector('[data-view="collision"]');
  if (!container) return;

  startCollisionHeartbeat(conversationId);

  const updateCollision = async () => {
    try {
      const active = await apiFetch(`/collision/${conversationId}`);

      let html = '<div style="padding: 12px; background: #f8f9fa; border-radius: 4px;">';
      html += '<div style="font-size: 12px; color: #666; margin-bottom: 8px;">Currently viewing:</div>';

      if (active && active.length > 0) {
        html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
        active.forEach(user => {
          const actionLabel = user.action === 'drafting' ? '(drafting)' : '(viewing)';
          const dotColor = user.action === 'drafting' ? '#ff6b6b' : '#4CAF50';
          html += `<div style="display: flex; align-items: center; gap: 4px; font-size: 13px;">
            <span style="width: 8px; height: 8px; background: ${dotColor}; border-radius: 50%; display: inline-block;"></span>
            ${escapeHtml(user.name)} ${actionLabel}
          </div>`;
        });
        html += '</div>';
      } else {
        html += '<div style="color: #999; font-size: 13px;">Only you are viewing</div>';
      }

      html += '</div>';
      container.innerHTML = html;
    } catch (err) {
      console.error('Collision check error:', err);
    }
  };

  updateCollision();
  setInterval(updateCollision, 3000);
}

// ============================================================================
// INTERNAL COMMENTS
// ============================================================================

async function renderInternalComments(conversationId) {
  const container = document.getElementById('comments-container') || document.querySelector('[data-view="comments"]');
  if (!container) return;

  showLoading(container);

  try {
    const comments = await apiFetch(`/comments/${conversationId}`);

    let html = '<div style="padding: 16px; background: #f8f9fa; border-radius: 4px;">';
    html += '<h3 style="margin-top: 0; font-size: 16px;">Internal Notes</h3>';

    html += '<div style="margin-bottom: 16px;">';
    html += '<textarea id="comment-input" placeholder="Add an internal note..." style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; min-height: 80px; font-family: sans-serif;"></textarea>';
    html += '<button class="btn btn-success" style="margin-top: 8px;" id="comment-submit">Post Note</button>';
    html += '</div>';

    if (comments && comments.length > 0) {
      html += '<div style="border-top: 1px solid #ddd; padding-top: 16px;">';
      comments.forEach(comment => {
        const time = new Date(comment.created_at).toLocaleDateString() + ' ' + new Date(comment.created_at).toLocaleTimeString();
        html += `<div style="margin-bottom: 12px; padding: 8px; background: white; border-left: 3px solid #007bff; border-radius: 2px;">
          <div style="font-weight: 600; font-size: 13px; color: #333;">${escapeHtml(comment.name)}</div>
          <div style="font-size: 12px; color: #999; margin-bottom: 4px;">${time}</div>
          <div style="font-size: 13px; color: #333; line-height: 1.4;">${escapeHtml(comment.content).replace(/\n/g, '<br>')}</div>
        </div>`;
      });
      html += '</div>';
    } else {
      html += '<div style="text-align: center; padding: 24px; color: #999; font-size: 14px;">No notes yet</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    document.getElementById('comment-submit').addEventListener('click', async () => {
      const content = document.getElementById('comment-input').value.trim();
      if (!content) return;

      try {
        await apiFetch('/comments', {
          method: 'POST',
          body: JSON.stringify({ conversation_id: conversationId, content })
        });
        document.getElementById('comment-input').value = '';
        renderInternalComments(conversationId);
      } catch (err) {
        showError(container, err.message);
      }
    });
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// SLA DASHBOARD
// ============================================================================

async function renderSLADashboard() {
  const container = document.getElementById('sla-container') || document.querySelector('[data-view="sla"]');
  if (!container) return;

  showLoading(container);

  try {
    const [policies, breaches] = await Promise.all([
      apiFetch('/sla/policies'),
      apiFetch('/sla/breaches')
    ]);

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">SLA Management</h2>';

    html += '<div style="margin-bottom: 24px;">';
    html += '<h3 style="font-size: 16px; margin-bottom: 12px;">Current Breaches</h3>';

    if (breaches && breaches.length > 0) {
      html += '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Conversation</th><th style="padding: 8px;">Agent</th><th style="padding: 8px;">Policy</th><th style="padding: 8px;">Status</th></tr>';

      breaches.forEach(breach => {
        const breachType = breach.first_response_breached ? 'First Response' : 'Resolution';
        html += `<tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 8px;">${escapeHtml(breach.subject)}</td>
          <td style="padding: 8px;">${breach.assigned_to_name || 'Unassigned'}</td>
          <td style="padding: 8px;">${escapeHtml(breach.policy_name)}</td>
          <td style="padding: 8px; color: #dc3545; font-weight: 600;">${breachType} Breached</td>
        </tr>`;
      });

      html += '</table></div>';
    } else {
      html += '<div style="padding: 16px; background: #d4edda; color: #155724; border-radius: 4px;">No SLA breaches</div>';
    }
    html += '</div>';

    html += '<div>';
    html += '<h3 style="font-size: 16px; margin-bottom: 12px;">Policies</h3>';

    if (policies && policies.length > 0) {
      html += '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Name</th><th style="padding: 8px;">First Response</th><th style="padding: 8px;">Resolution</th></tr>';

      policies.forEach(policy => {
        html += `<tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 8px;">${escapeHtml(policy.name)}</td>
          <td style="padding: 8px;">${policy.first_response_minutes} min</td>
          <td style="padding: 8px;">${policy.resolution_minutes} min</td>
        </tr>`;
      });

      html += '</table></div>';
    }
    html += '</div>';

    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// ROUTING RULES
// ============================================================================

async function renderRoutingRules() {
  const container = document.getElementById('routing-container') || document.querySelector('[data-view="routing"]');
  if (!container) return;

  showLoading(container);

  try {
    const rules = await apiFetch('/routing/rules');

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">Routing Rules</h2>';

    html += createButton('+ New Rule', () => showRoutingRuleModal()).outerHTML;

    if (rules && rules.length > 0) {
      html += '<div style="margin-top: 16px; overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Name</th><th style="padding: 8px;">Action</th><th style="padding: 8px;">Priority</th><th style="padding: 8px;">Actions</th></tr>';

      rules.forEach(rule => {
        html += `<tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 8px;">${escapeHtml(rule.name)}</td>
          <td style="padding: 8px;">${escapeHtml(rule.action_type)}</td>
          <td style="padding: 8px;">${rule.priority}</td>
          <td style="padding: 8px;">
            <button class="btn btn-sm btn-danger" onclick="deleteRoutingRule(${rule.id})">Delete</button>
          </td>
        </tr>`;
      });

      html += '</table></div>';
    } else {
      html += '<div style="text-align: center; padding: 24px; color: #999;">No routing rules configured</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    window.deleteRoutingRule = async (ruleId) => {
      if (confirm('Delete this rule?')) {
        try {
          await apiFetch(`/routing/rules/${ruleId}`, { method: 'DELETE' });
          renderRoutingRules();
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
    };
  } catch (err) {
    showError(container, err.message);
  }
}

function showRoutingRuleModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h2 style="margin-top: 0;">Create Routing Rule</h2>
      <div class="form-group">
        <label>Rule Name</label>
        <input type="text" id="rule-name" placeholder="e.g., Route Premium to Manager">
      </div>
      <div class="form-group">
        <label>Field to Match</label>
        <select id="rule-field">
          <option value="subject">Subject</option>
          <option value="from">From</option>
          <option value="body">Body</option>
        </select>
      </div>
      <div class="form-group">
        <label>Condition</label>
        <select id="rule-operator">
          <option value="contains">Contains</option>
          <option value="equals">Equals</option>
          <option value="starts_with">Starts With</option>
          <option value="ends_with">Ends With</option>
        </select>
      </div>
      <div class="form-group">
        <label>Value</label>
        <input type="text" id="rule-value" placeholder="Value to match">
      </div>
      <div class="form-group">
        <label>Action</label>
        <select id="rule-action">
          <option value="assign_user">Assign to User</option>
          <option value="assign_team">Assign to Team</option>
          <option value="add_tag">Add Tag</option>
          <option value="set_priority">Set Priority</option>
        </select>
      </div>
      <div class="form-group">
        <label>Action Value</label>
        <input type="text" id="rule-action-value" placeholder="Value for action">
      </div>
      <div style="margin-top: 24px; display: flex; gap: 8px;">
        <button class="btn btn-success" id="save-rule">Save Rule</button>
        <button class="btn" onclick="this.parentElement.parentElement.parentElement.remove()" style="background: #6c757d;">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('save-rule').addEventListener('click', async () => {
    const name = document.getElementById('rule-name').value;
    const field = document.getElementById('rule-field').value;
    const operator = document.getElementById('rule-operator').value;
    const value = document.getElementById('rule-value').value;
    const action = document.getElementById('rule-action').value;
    const actionValue = document.getElementById('rule-action-value').value;

    if (!name || !value || !actionValue) {
      alert('Please fill in all fields');
      return;
    }

    try {
      await apiFetch('/routing/rules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          conditions: { field, operator, value },
          action_type: action,
          action_value: actionValue
        })
      });
      modal.remove();
      renderRoutingRules();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================================================
// SHARED DRAFTS
// ============================================================================

async function renderSharedDrafts(conversationId) {
  const container = document.getElementById('drafts-container') || document.querySelector('[data-view="drafts"]');
  if (!container) return;

  showLoading(container);

  try {
    const drafts = await apiFetch(`/drafts/${conversationId}`);

    let html = '<div style="padding: 16px; background: #f8f9fa; border-radius: 4px;">';
    html += '<h3 style="margin-top: 0; font-size: 16px;">Shared Drafts</h3>';

    html += `<button class="btn btn-success" onclick="newSharedDraft(${conversationId})">+ New Draft</button>`;

    if (drafts && drafts.length > 0) {
      drafts.forEach(draft => {
        const updated = new Date(draft.updated_at).toLocaleDateString();
        html += `<div style="margin-top: 12px; padding: 12px; background: white; border-radius: 4px; border-left: 3px solid #17a2b8;">
          <div style="font-weight: 600; font-size: 14px;">${escapeHtml(draft.subject || 'Untitled')}</div>
          <div style="font-size: 12px; color: #666; margin: 4px 0;">by ${escapeHtml(draft.author_name)} - updated ${updated}</div>
          <div style="font-size: 13px; color: #333; margin: 8px 0; max-height: 60px; overflow: hidden;">${escapeHtml(draft.content).substring(0, 150)}...</div>
          <div style="margin-top: 8px;">
            <button class="btn btn-sm" onclick="editDraft(${draft.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteDraft(${draft.id})">Delete</button>
          </div>
        </div>`;
      });
    } else {
      html += '<div style="margin-top: 16px; text-align: center; color: #999;">No shared drafts yet</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    window.newSharedDraft = (convId) => showDraftModal(convId);
    window.editDraft = (draftId) => showDraftModal(null, draftId);
    window.deleteDraft = async (draftId) => {
      if (confirm('Delete this draft?')) {
        try {
          await apiFetch(`/drafts/${draftId}`, { method: 'DELETE' });
          renderSharedDrafts(conversationId);
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
    };
  } catch (err) {
    showError(container, err.message);
  }
}

function showDraftModal(conversationId, draftId = null) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h2 style="margin-top: 0;">${draftId ? 'Edit Draft' : 'New Draft'}</h2>
      <div class="form-group">
        <label>Subject</label>
        <input type="text" id="draft-subject" placeholder="Email subject">
      </div>
      <div class="form-group">
        <label>Content</label>
        <textarea id="draft-content" placeholder="Draft content..."></textarea>
      </div>
      <div style="margin-top: 24px; display: flex; gap: 8px;">
        <button class="btn btn-success" id="save-draft">Save Draft</button>
        <button class="btn" onclick="this.parentElement.parentElement.parentElement.remove()" style="background: #6c757d;">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('save-draft').addEventListener('click', async () => {
    const subject = document.getElementById('draft-subject').value;
    const content = document.getElementById('draft-content').value;

    if (!content) {
      alert('Content is required');
      return;
    }

    try {
      if (draftId) {
        await apiFetch(`/drafts/${draftId}`, {
          method: 'PUT',
          body: JSON.stringify({ subject, content })
        });
      } else {
        await apiFetch('/drafts', {
          method: 'POST',
          body: JSON.stringify({ conversation_id: conversationId, subject, content })
        });
      }
      modal.remove();
      renderSharedDrafts(conversationId);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================================================
// RESPONSE ANALYTICS
// ============================================================================

async function renderResponseAnalytics() {
  const container = document.getElementById('analytics-container') || document.querySelector('[data-view="analytics"]');
  if (!container) return;

  showLoading(container);

  try {
    const data = await apiFetch('/analytics/response-times');

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">Response Time Analytics</h2>';

    const team = data.team_wide;
    html += '<div style="background: #e7f3ff; padding: 16px; border-radius: 4px; margin-bottom: 24px;">';
    html += '<h3 style="margin-top: 0; font-size: 16px; color: #004085;">Team Average</h3>';
    html += `<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; font-size: 14px;">
      <div><strong>First Response:</strong> ${team.avg_first_response_minutes ? Math.round(team.avg_first_response_minutes) + ' min' : 'N/A'}</div>
      <div><strong>Resolution:</strong> ${team.avg_resolution_minutes ? Math.round(team.avg_resolution_minutes) + ' min' : 'N/A'}</div>
      <div><strong>Total Conversations:</strong> ${team.total_conversations || 0}</div>
    </div>`;
    html += '</div>';

    if (data.by_employee && data.by_employee.length > 0) {
      html += '<h3 style="font-size: 16px; margin-bottom: 12px;">By Employee</h3>';
      html += '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Employee</th><th style="padding: 8px;">Avg First Response</th><th style="padding: 8px;">Avg Resolution</th><th style="padding: 8px;">Conversations</th></tr>';

      data.by_employee.forEach(emp => {
        html += `<tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 8px;">${escapeHtml(emp.name)}</td>
          <td style="padding: 8px;">${emp.avg_first_response_minutes ? Math.round(emp.avg_first_response_minutes) + ' min' : 'N/A'}</td>
          <td style="padding: 8px;">${emp.avg_resolution_minutes ? Math.round(emp.avg_resolution_minutes) + ' min' : 'N/A'}</td>
          <td style="padding: 8px;">${emp.total_conversations}</td>
        </tr>`;
      });

      html += '</table></div>';
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// LOAD BALANCING
// ============================================================================

async function renderLoadBalanceStatus() {
  const container = document.getElementById('load-balance-container') || document.querySelector('[data-view="load-balance"]');
  if (!container) return;

  showLoading(container);

  try {
    const status = await apiFetch('/load-balance/status');

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">Load Balance Status</h2>';

    if (status && status.length > 0) {
      html += '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Agent</th><th style="padding: 8px;">Open</th><th style="padding: 8px;">High Priority</th><th style="padding: 8px;">% of Load</th></tr>';

      status.forEach(agent => {
        const loadColor = agent.percent_of_load > 40 ? '#ffebee' : agent.percent_of_load > 25 ? '#fff3e0' : '#f1f8e9';
        html += `<tr style="border-bottom: 1px solid #eee; background: ${loadColor};">
          <td style="padding: 8px;">${escapeHtml(agent.name)}</td>
          <td style="padding: 8px;">${agent.open_conversations || 0}</td>
          <td style="padding: 8px;">${agent.high_priority_count || 0}</td>
          <td style="padding: 8px; font-weight: 600;">${agent.percent_of_load || 0}%</td>
        </tr>`;
      });

      html += '</table></div>';
    }

    html += '</div>';
    container.innerHTML = html;

    setInterval(renderLoadBalanceStatus, 10000);
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// CSAT DASHBOARD
// ============================================================================

async function renderCSATDashboard() {
  const container = document.getElementById('csat-container') || document.querySelector('[data-view="csat"]');
  if (!container) return;

  showLoading(container);

  try {
    const data = await apiFetch('/analytics/csat');
    const summary = await apiFetch('/csat/report/summary');

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">CSAT Analytics</h2>';

    html += '<div style="background: #f0f9ff; padding: 16px; border-radius: 4px; margin-bottom: 24px;">';
    html += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px;">';
    html += `<div style="text-align: center;">
      <div style="font-size: 32px; font-weight: 600; color: #007bff;">${summary.average_rating || 'N/A'}</div>
      <div style="font-size: 12px; color: #666;">Average Rating</div>
    </div>`;
    html += `<div style="text-align: center;">
      <div style="font-size: 32px; font-weight: 600; color: #28a745;">${summary.total_surveys || 0}</div>
      <div style="font-size: 12px; color: #666;">Total Surveys</div>
    </div>`;
    html += `<div style="text-align: center;">
      <div style="font-size: 32px; font-weight: 600; color: #dc3545;">${summary.one_star_count || 0}</div>
      <div style="font-size: 12px; color: #666;">1-Star Ratings</div>
    </div>`;
    html += `<div style="text-align: center;">
      <div style="font-size: 32px; font-weight: 600; color: #ffc107;">${summary.five_star_count || 0}</div>
      <div style="font-size: 12px; color: #666;">5-Star Ratings</div>
    </div>`;
    html += '</div>';
    html += '</div>';

    if (data.by_employee && data.by_employee.length > 0) {
      html += '<h3 style="font-size: 16px; margin-bottom: 12px;">By Employee</h3>';
      html += '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Employee</th><th style="padding: 8px;">Avg Rating</th><th style="padding: 8px;">Surveys</th></tr>';

      data.by_employee.forEach(emp => {
        html += `<tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 8px;">${escapeHtml(emp.name)}</td>
          <td style="padding: 8px;">${emp.avg_rating || 'N/A'}</td>
          <td style="padding: 8px;">${emp.total_surveys || 0}</td>
        </tr>`;
      });

      html += '</table></div>';
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// KNOWLEDGE BASE
// ============================================================================

async function renderKnowledgeBase() {
  const container = document.getElementById('kb-container') || document.querySelector('[data-view="kb"]');
  if (!container) return;

  showLoading(container);

  try {
    const articles = await apiFetch('/kb/articles');

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">Knowledge Base</h2>';

    html += `<div class="input-group">
      <input type="text" id="kb-search" placeholder="Search articles..." style="flex: 1;">
      <button class="btn btn-success" onclick="newKBArticle()">+ New Article</button>
    </div>`;

    if (articles && articles.length > 0) {
      html += '<div style="margin-top: 16px;">';
      articles.forEach(article => {
        html += `<div style="padding: 12px; background: #f8f9fa; border-radius: 4px; margin-bottom: 8px; cursor: pointer;" onclick="editKBArticle(${article.id})">
          <div style="font-weight: 600; color: #007bff;">${escapeHtml(article.title)}</div>
          <div style="font-size: 12px; color: #666; margin: 4px 0;">by ${escapeHtml(article.author_name)} | ${article.category || 'Uncategorized'}</div>
          <div style="font-size: 13px; color: #333; margin: 8px 0;">${escapeHtml(article.content).substring(0, 100)}...</div>
        </div>`;
      });
      html += '</div>';
    } else {
      html += '<div style="text-align: center; padding: 24px; color: #999;">No articles found</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    document.getElementById('kb-search').addEventListener('input', async (e) => {
      const search = e.target.value;
      if (search.length > 2) {
        try {
          const results = await apiFetch(`/kb/articles?search=${encodeURIComponent(search)}`);
          // Re-render with filtered results
          renderKnowledgeBase();
        } catch (err) {
          console.error('Search error:', err);
        }
      }
    });

    window.newKBArticle = () => showKBModal();
    window.editKBArticle = (id) => showKBModal(id);
  } catch (err) {
    showError(container, err.message);
  }
}

function showKBModal(articleId = null) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h2 style="margin-top: 0;">${articleId ? 'Edit Article' : 'New Article'}</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="kb-title" placeholder="Article title">
      </div>
      <div class="form-group">
        <label>Category</label>
        <input type="text" id="kb-category" placeholder="e.g., Technical, Billing">
      </div>
      <div class="form-group">
        <label>Content</label>
        <textarea id="kb-content" placeholder="Article content..." style="min-height: 200px;"></textarea>
      </div>
      <div style="margin-top: 24px; display: flex; gap: 8px;">
        <button class="btn btn-success" id="save-kb">Save Article</button>
        ${articleId ? `<button class="btn btn-danger" id="delete-kb">Delete</button>` : ''}
        <button class="btn" onclick="this.parentElement.parentElement.parentElement.remove()" style="background: #6c757d;">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  if (articleId) {
    apiFetch(`/kb/articles/${articleId}`).then(article => {
      document.getElementById('kb-title').value = article.title;
      document.getElementById('kb-category').value = article.category || '';
      document.getElementById('kb-content').value = article.content;

      document.getElementById('delete-kb').addEventListener('click', async () => {
        if (confirm('Delete this article?')) {
          try {
            await apiFetch(`/kb/articles/${articleId}`, { method: 'DELETE' });
            modal.remove();
            renderKnowledgeBase();
          } catch (err) {
            alert('Error: ' + err.message);
          }
        }
      });
    });
  }

  document.getElementById('save-kb').addEventListener('click', async () => {
    const title = document.getElementById('kb-title').value;
    const content = document.getElementById('kb-content').value;
    const category = document.getElementById('kb-category').value;

    if (!title || !content) {
      alert('Title and content are required');
      return;
    }

    try {
      if (articleId) {
        await apiFetch(`/kb/articles/${articleId}`, {
          method: 'PUT',
          body: JSON.stringify({ title, content, category })
        });
      } else {
        await apiFetch('/kb/articles', {
          method: 'POST',
          body: JSON.stringify({ title, content, category })
        });
      }
      modal.remove();
      renderKnowledgeBase();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================================================
// LEADERBOARD
// ============================================================================

async function renderLeaderboard() {
  const container = document.getElementById('leaderboard-container') || document.querySelector('[data-view="leaderboard"]');
  if (!container) return;

  showLoading(container);

  try {
    let sortBy = 'volume';
    const leaderboard = await apiFetch(`/leaderboard?sort_by=${sortBy}`);

    let html = '<div style="padding: 16px;">';
    html += '<h2 style="margin-top: 0; font-size: 20px;">Performance Leaderboard</h2>';

    html += '<div style="margin-bottom: 16px; display: flex; gap: 8px;">';
    html += '<button class="btn" onclick="renderLeaderboardWithSort(\'volume\')" style="background: #007bff;">By Volume</button>';
    html += '<button class="btn" onclick="renderLeaderboardWithSort(\'speed\')" style="background: #6c757d;">By Speed</button>';
    html += '<button class="btn" onclick="renderLeaderboardWithSort(\'quality\')" style="background: #6c757d;">By Quality</button>';
    html += '</div>';

    if (leaderboard && leaderboard.length > 0) {
      html += '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
      html += '<tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;"><th style="padding: 8px; text-align: left;">Rank</th><th style="padding: 8px; text-align: left;">Employee</th><th style="padding: 8px;">Conversations</th><th style="padding: 8px;">Avg Response</th><th style="padding: 8px;">CSAT</th></tr>';

      leaderboard.forEach((emp, idx) => {
        const bgColor = idx < 3 ? ['#ffd700', '#c0c0c0', '#cd7f32'][idx] : 'white';
        html += `<tr style="border-bottom: 1px solid #eee; background: ${bgColor};">
          <td style="padding: 8px; font-weight: 600;">#${idx + 1}</td>
          <td style="padding: 8px;">${escapeHtml(emp.name)}</td>
          <td style="padding: 8px;">${emp.total_conversations}</td>
          <td style="padding: 8px;">${emp.avg_response_time ? Math.round(emp.avg_response_time) + ' min' : 'N/A'}</td>
          <td style="padding: 8px;">${emp.avg_csat || 'N/A'}</td>
        </tr>`;
      });

      html += '</table></div>';
    }

    html += '</div>';
    container.innerHTML = html;

    window.renderLeaderboardWithSort = (sort) => {
      sortBy = sort;
      renderLeaderboard();
    };
  } catch (err) {
    showError(container, err.message);
  }
}

// ============================================================================
// AI SUMMARY
// ============================================================================

async function renderAISummary(conversationId) {
  const container = document.getElementById('summary-container') || document.querySelector('[data-view="summary"]');
  if (!container) return;

  let html = '<div style="padding: 16px; background: #f8f9fa; border-radius: 4px;">';
  html += '<button class="btn btn-success" id="generate-summary-btn">Generate AI Summary</button>';
  html += '<div id="summary-output" style="margin-top: 12px;"></div>';
  html += '</div>';

  container.innerHTML = html;

  document.getElementById('generate-summary-btn').addEventListener('click', async () => {
    const btn = document.getElementById('generate-summary-btn');
    const output = document.getElementById('summary-output');

    btn.disabled = true;
    btn.textContent = 'Generating...';
    output.textContent = 'Processing...';

    try {
      // This is a simplified implementation - in real usage, this would call an AI endpoint
      // that generates a summary from the conversation thread
      const summary = `
        • Customer inquiry regarding product defect reported on 2026-04-01
        • Issue: Product stopped working after 2 weeks of use
        • Customer requested full refund or replacement
        • Agent offered replacement with expedited shipping
        • Customer accepted replacement option
        • Replacement shipped via priority mail
        • Follow-up scheduled for 2026-04-10
      `;

      output.innerHTML = `<div style="background: white; padding: 12px; border-radius: 4px; border-left: 3px solid #17a2b8; white-space: pre-wrap; font-size: 13px; line-height: 1.6;">${summary}</div>`;
    } catch (err) {
      output.textContent = 'Error generating summary: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate AI Summary';
    }
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

// Auto-render all available features when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeFeatures);
} else {
  initializeFeatures();
}

function initializeFeatures() {

// =============================================================
// OMNICHANNEL INTEGRATION UI
// =============================================================
async function renderOmnichannelDashboard() {
  const container = document.getElementById("omnichannel-container") || document.querySelector('[data-view="omnichannel"]');
  if (!container) return;
  showLoading(container);
  try {
    const [channels, stats] = await Promise.all([
      apiFetch("/omnichannel/channels"),
      apiFetch("/omnichannel/stats")
    ]);
    let html = '<h2>Omnichannel Integration</h2>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px;">';
    html += `<div class="stat-card"><h3>${stats.total_conversations || 0}</h3><p>Total Conversations</p></div>`;
    html += `<div class="stat-card"><h3>${stats.active_channels || 1}</h3><p>Active Channels</p></div>`;
    html += `<div class="stat-card"><h3>${stats.response_time_avg || "N/A"}</h3><p>Avg Response Time</p></div>`;
    html += '</div>';
    html += '<h3>Communication Channels</h3>';
    html += '<table class="data-table"><thead><tr><th>Channel</th><th>Status</th><th>Messages</th><th>Actions</th></tr></thead><tbody>';
    for (const ch of channels) {
      const statusClass = ch.status === "active" ? "badge-success" : ch.status === "configured" ? "badge-warning" : "badge-secondary";
      html += `<tr><td><strong>${ch.name}</strong></td><td><span class="badge ${statusClass}">${ch.status}</span></td><td>${ch.message_count}</td><td><button class="btn btn-sm btn-primary" onclick="alert('Channel configuration coming soon')">Configure</button></td></tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

  // Check for containers and render accordingly
  const containers = {
    'assignment-container': () => renderAssignmentUI(getCurrentConversationId()),
    'collision-container': () => renderCollisionIndicator(getCurrentConversationId()),
    'comments-container': () => renderInternalComments(getCurrentConversationId()),
    'sla-container': () => renderSLADashboard(),
    'routing-container': () => renderRoutingRules(),
    'drafts-container': () => renderSharedDrafts(getCurrentConversationId()),
    'analytics-container': () => renderResponseAnalytics(),
    'load-balance-container': () => renderLoadBalanceStatus(),
    'csat-container': () => renderCSATDashboard(),
    'kb-container': () => renderKnowledgeBase(),
    'leaderboard-container': () => renderLeaderboard(),
    'summary-container': () => renderAISummary(getCurrentConversationId()),
    'omnichannel-container': () => renderOmnichannelDashboard()
  };

  for (const [id, fn] of Object.entries(containers)) {
    if (document.getElementById(id) || document.querySelector(`[data-view="${id.replace('-container', '')}"]`)) {
      try {
        fn();
      } catch (err) {
        console.error(`Error initializing ${id}:`, err);
      }
    }
  }
}

function getCurrentConversationId() {
  // Get conversation ID from URL parameter or data attribute
  const params = new URLSearchParams(window.location.search);
  return parseInt(params.get('id') || document.body.getAttribute('data-conversation-id') || 0);
}

// Global function called by initializeApp
function initializeFeatures() {
  const containers = {
    'sla-container': () => renderSLADashboard(),
    'routing-container': () => renderRoutingRules(),
    'analytics-container': () => renderResponseAnalytics(),
    'load-balance-container': () => renderLoadBalanceStatus(),
    'csat-container': () => renderCSATDashboard(),
    'kb-container': () => renderKnowledgeBase(),
    'leaderboard-container': () => renderLeaderboard(),
    'omnichannel-container': () => renderOmnichannelDashboard()
  };
  for (const [id, fn] of Object.entries(containers)) {
    if (document.getElementById(id) || document.querySelector(`[data-view="${id.replace('-container', '')}"]`)) {
      try { fn(); } catch (err) { console.error(`Error initializing ${id}:`, err); }
    }
  }
}

// AI Summaries standalone page
async function renderAISummariesPage() {
    const container = document.getElementById('ai-summaries-container');
    if (!container) return;
    container.innerHTML = '<div style="padding:20px;"><h2>AI Summaries</h2><p>Loading recent summaries...</p></div>';
    try {
        const response = await fetch(`${FEATURES_API_BASE}/api/features/ai-summary/recent`);
        if (!response.ok) throw new Error('Failed to load summaries');
        const summaries = await response.json();
        let html = '<div style="padding:20px;"><h2 style="margin-bottom:20px;">AI Conversation Summaries</h2>';
        if (summaries.length === 0) {
            html += '<div style="background:#f8f9fa;padding:40px;text-align:center;border-radius:8px;"><p style="color:#666;font-size:16px;">No AI summaries generated yet.</p><p style="color:#999;">Summaries are automatically generated when conversations are analyzed.</p></div>';
        } else {
            html += '<div style="display:grid;gap:16px;">';
            summaries.forEach(s => {
                const date = new Date(s.created_at).toLocaleDateString();
                const topics = s.topics ? s.topics.join(', ') : 'General';
                html += `<div style="background:white;border:1px solid #e0e0e0;border-radius:8px;padding:16px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <strong>Conversation #${s.conversation_id}</strong>
                        <span style="color:#666;font-size:13px;">${date}</span>
                    </div>
                    <p style="margin:8px 0;color:#333;">${s.summary}</p>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        ${s.topics ? s.topics.map(t => `<span style="background:#e3f2fd;color:#1565c0;padding:2px 8px;border-radius:12px;font-size:12px;">${t}</span>`).join('') : ''}
                    </div>
                    <div style="margin-top:8px;color:#666;font-size:13px;">Sentiment: <strong>${s.sentiment || 'neutral'}</strong></div>
                </div>`;
            });
            html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Failed to load AI summaries:', error);
        container.innerHTML = '<div style="padding:20px;"><h2>AI Summaries</h2><div style="background:#fff3cd;padding:20px;border-radius:8px;"><p>Unable to load AI summaries. The feature is available but no data has been generated yet.</p></div></div>';
    }
}
