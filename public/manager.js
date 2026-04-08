// ═══════════════════════════════════════════════════════════
// manager.js — Settings, Manager Dashboard, & Agent Performance
// ═══════════════════════════════════════════════════════════

// ─── STATE ───
let dashboardData = null;
let settingsEmployees = [];
let settingsTeams = [];
let settingsLabels = [];
let dashFilters = { from: '', to: '', agent_id: '', team_id: '', label: '', priority: '' };
let perfFilters = { from: '', to: '', agent_id: '', team_id: '', label: '', priority: '' };

// Initialize date range (last 7 days)
(function() {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  dashFilters.from = weekAgo.toISOString().split('T')[0];
  dashFilters.to = now.toISOString().split('T')[0];
  perfFilters.from = weekAgo.toISOString().split('T')[0];
  perfFilters.to = now.toISOString().split('T')[0];
})();


// ═══════════════════════════════════════════════════════════
// ─── SETTINGS PAGE ───
// ═══════════════════════════════════════════════════════════

async function renderSettings() {
  const container = document.getElementById('settingsContent');
  container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)"><div class="ai-loading" style="width:30px;height:30px;margin:0 auto 16px"></div>Loading Settings...</div>';

  try {
    const [empRes, teamRes, labelRes] = await Promise.all([
      fetch('/api/manager/employees').then(r => r.json()),
      fetch('/api/manager/teams').then(r => r.json()),
      fetch('/api/manager/labels').then(r => r.json())
    ]);
    settingsEmployees = empRes;
    settingsTeams = teamRes;
    settingsLabels = labelRes;
  } catch (err) {
    container.innerHTML = `<div style="padding:40px;color:var(--danger)">Error loading settings: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:32px">
      <h2 style="font-family:'Playfair Display',serif;font-size:2rem;font-weight:700;margin-bottom:4px">Settings</h2>
      <p style="color:var(--text-secondary)">Manage employees, teams, roles, and SLA configuration</p>
    </div>

    <!-- Settings Sub-tabs -->
    <div style="display:flex;gap:4px;background:var(--border-light);border-radius:var(--radius-sm);padding:4px;margin-bottom:24px;width:fit-content">
      <button class="settings-subtab active" onclick="switchSettingsTab('employees')">👥 Employees</button>
      <button class="settings-subtab" onclick="switchSettingsTab('teams')">🏷️ Teams & SLA</button>
      <button class="settings-subtab" onclick="switchSettingsTab('labels')">🏷️ Labels</button>
      <button class="settings-subtab" onclick="switchSettingsTab('aitraining')">🤖 AI Training</button>
    </div>

    <div id="settings-employees" class="settings-panel active">${renderEmployeesPanel()}</div>
    <div id="settings-teams" class="settings-panel" style="display:none">${renderTeamsPanel()}</div>
    <div id="settings-labels" class="settings-panel" style="display:none">${renderLabelsPanel()}</div>
    <div id="settings-aitraining" class="settings-panel" style="display:none">${renderAiTrainingPanel()}</div>
  `;
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-subtab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-panel').forEach(p => p.style.display = 'none');
  event.target.classList.add('active');
  document.getElementById('settings-' + tab).style.display = 'block';
}

function renderEmployeesPanel() {
  const rows = settingsEmployees.map(emp => {
    const teamNames = emp.teams.map(t => `<span style="background:${t.color}22;color:${t.color};padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600">${t.name}</span>`).join(' ');
    return `
      <tr style="border-bottom:1px solid var(--border-light)">
        <td style="padding:14px 16px;display:flex;align-items:center;gap:10px">
          ${emp.avatar_url ? `<img src="${emp.avatar_url}" style="width:32px;height:32px;border-radius:50%">` : `<div style="width:32px;height:32px;border-radius:50%;background:var(--accent-light);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.75rem">${emp.name.split(' ').map(w=>w[0]).join('').substring(0,2)}</div>`}
          <div>
            <div style="font-weight:600">${emp.name}</div>
            <div style="font-size:0.8rem;color:var(--text-muted)">${emp.email}</div>
          </div>
        </td>
        <td style="padding:14px 16px">
          <select onchange="updateEmployeeRole(${emp.id}, this.value)" style="padding:6px 12px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif;font-size:0.85rem;background:var(--card)">
            <option value="Admin" ${emp.role==='Admin'?'selected':''}>Admin</option>
            <option value="Manager" ${emp.role==='Manager'?'selected':''}>Manager</option>
            <option value="Agent" ${emp.role==='Agent'?'selected':''}>Agent</option>
          </select>
        </td>
        <td style="padding:14px 16px">${teamNames || '<span style="color:var(--text-muted);font-size:0.85rem">No team</span>'}</td>
        <td style="padding:14px 16px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" ${emp.is_active?'checked':''} onchange="toggleEmployeeActive(${emp.id}, this.checked)" style="width:18px;height:18px;accent-color:var(--success)">
            <span style="font-size:0.85rem;color:${emp.is_active?'var(--success)':'var(--danger)'};font-weight:600">${emp.is_active?'Active':'Inactive'}</span>
          </label>
        </td>
        <td style="padding:14px 16px;font-size:0.8rem;color:var(--text-muted)">${emp.last_login ? new Date(emp.last_login).toLocaleDateString() : 'Never'}</td>
      </tr>`;
  }).join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div style="font-weight:700;font-size:1.1rem">${settingsEmployees.length} Employees</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="text" placeholder="Search employees..." oninput="filterEmployeeTable(this.value)" style="padding:8px 14px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif;width:220px">
        <button onclick="seedDemoData()" style="padding:8px 16px;background:var(--warning);color:white;border:none;border-radius:var(--radius-xs);font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:0.85rem">Seed Demo Data</button>
      </div>
    </div>
    <div style="background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden">
      <table style="width:100%;border-collapse:collapse" id="employeeTable">
        <thead>
          <tr style="background:var(--border-light);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:600">
            <th style="padding:12px 16px;text-align:left">Employee</th>
            <th style="padding:12px 16px;text-align:left">Role</th>
            <th style="padding:12px 16px;text-align:left">Teams</th>
            <th style="padding:12px 16px;text-align:left">Status</th>
            <th style="padding:12px 16px;text-align:left">Last Active</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderTeamsPanel() {
  const teamCards = settingsTeams.map(team => `
    <div style="background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);padding:24px;transition:all 0.2s ease" onmouseover="this.style.borderColor='${team.color}'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div style="width:12px;height:12px;border-radius:50%;background:${team.color}"></div>
            <h3 style="font-weight:700;font-size:1.15rem">${team.name}</h3>
          </div>
          <p style="color:var(--text-secondary);font-size:0.9rem">${team.description || 'No description'}</p>
        </div>
        <button onclick="deleteTeam(${team.id})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:1.1rem;opacity:0.5" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--bg);padding:12px;border-radius:var(--radius-xs)">
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Response SLA</div>
          <div style="font-weight:700;color:var(--accent)">${formatMinutes(team.sla_response_minutes)}</div>
        </div>
        <div style="background:var(--bg);padding:12px;border-radius:var(--radius-xs)">
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Resolution SLA</div>
          <div style="font-weight:700;color:var(--accent)">${formatMinutes(team.sla_resolution_minutes)}</div>
        </div>
      </div>
      <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:8px;font-weight:600">${team.members ? team.members.length : 0} Members</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${(team.members || []).slice(0, 8).map(m => `<span style="background:var(--bg);padding:3px 10px;border-radius:12px;font-size:0.75rem;font-weight:500">${m.name}</span>`).join('')}
        ${(team.members || []).length > 8 ? `<span style="color:var(--text-muted);font-size:0.75rem;padding:3px 6px">+${team.members.length - 8} more</span>` : ''}
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light)">
        <button onclick="editTeamSLA(${team.id}, ${team.sla_response_minutes}, ${team.sla_resolution_minutes})" style="padding:6px 14px;background:var(--accent-light);color:var(--accent);border:none;border-radius:var(--radius-xs);font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:0.8rem">Edit SLA</button>
      </div>
    </div>
  `).join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div style="font-weight:700;font-size:1.1rem">${settingsTeams.length} Teams</div>
      <button onclick="showAddTeamForm()" style="padding:8px 20px;background:var(--success);color:white;border:none;border-radius:var(--radius-xs);font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">+ Add Team</button>
    </div>
    <div id="addTeamForm" style="display:none;background:var(--card);border:1.5px solid var(--accent);border-radius:var(--radius);padding:24px;margin-bottom:20px">
      <h4 style="margin-bottom:12px;font-weight:700">New Team</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <input type="text" id="newTeamName" placeholder="Team name" style="padding:10px 14px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif">
        <input type="text" id="newTeamDesc" placeholder="Description" style="padding:10px 14px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif">
        <input type="number" id="newTeamSLAResp" placeholder="Response SLA (minutes)" value="240" style="padding:10px 14px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif">
        <input type="number" id="newTeamSLARes" placeholder="Resolution SLA (minutes)" value="1440" style="padding:10px 14px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif">
        <input type="color" id="newTeamColor" value="#2563EB" style="height:42px;border:1.5px solid var(--border);border-radius:var(--radius-xs)">
        <button onclick="createTeam()" style="padding:10px 20px;background:var(--accent);color:white;border:none;border-radius:var(--radius-xs);font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif">Create Team</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(340px, 1fr));gap:20px">${teamCards}</div>`;
}

function renderLabelsPanel() {
  const labelItems = settingsLabels.map(l => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius-xs);transition:all 0.2s ease">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:16px;height:16px;border-radius:4px;background:${l.color}"></div>
        <span style="font-weight:600">${l.name}</span>
      </div>
      <button onclick="deleteLabel(${l.id})" style="background:none;border:none;color:var(--danger);cursor:pointer;opacity:0.4;font-size:1rem" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.4">✕</button>
    </div>
  `).join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div style="font-weight:700;font-size:1.1rem">${settingsLabels.length} Labels</div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <input type="text" id="newLabelName" placeholder="Label name" style="padding:8px 14px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif;flex:1">
      <input type="color" id="newLabelColor" value="#6B7280" style="height:38px;border:1.5px solid var(--border);border-radius:var(--radius-xs)">
      <button onclick="createLabel()" style="padding:8px 20px;background:var(--success);color:white;border:none;border-radius:var(--radius-xs);font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">Add</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:8px">${labelItems}</div>`;
}

// ─── Settings API Actions ───
async function updateEmployeeRole(id, role) {
  await fetch(`/api/manager/employees/${id}/role`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ role }) });
}

async function toggleEmployeeActive(id, active) {
  await fetch(`/api/manager/employees/${id}/active`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ is_active: active }) });
}

async function createTeam() {
  const name = document.getElementById('newTeamName').value;
  const description = document.getElementById('newTeamDesc').value;
  const sla_response_minutes = parseInt(document.getElementById('newTeamSLAResp').value) || 240;
  const sla_resolution_minutes = parseInt(document.getElementById('newTeamSLARes').value) || 1440;
  const color = document.getElementById('newTeamColor').value;
  if (!name) return alert('Team name is required');
  await fetch('/api/manager/teams', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, description, sla_response_minutes, sla_resolution_minutes, color }) });
  renderSettings();
}

async function deleteTeam(id) {
  if (!confirm('Delete this team?')) return;
  await fetch(`/api/manager/teams/${id}`, { method: 'DELETE' });
  renderSettings();
}

async function editTeamSLA(id, currentResp, currentRes) {
  const resp = prompt('Response SLA (minutes):', currentResp);
  const res = prompt('Resolution SLA (minutes):', currentRes);
  if (resp === null || res === null) return;
  const team = settingsTeams.find(t => t.id === id);
  await fetch(`/api/manager/teams/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: team.name, description: team.description, sla_response_minutes: parseInt(resp), sla_resolution_minutes: parseInt(res), color: team.color }) });
  renderSettings();
}

async function createLabel() {
  const name = document.getElementById('newLabelName').value;
  const color = document.getElementById('newLabelColor').value;
  if (!name) return;
  await fetch('/api/manager/labels', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, color }) });
  renderSettings();
}

async function deleteLabel(id) {
  await fetch(`/api/manager/labels/${id}`, { method: 'DELETE' });
  renderSettings();
}

async function seedDemoData() {
  if (!confirm('This will create 10 demo agents and 500 demo tickets for testing the dashboard. Proceed?')) return;
  const btn = event.target;
  btn.textContent = 'Seeding...';
  btn.disabled = true;
  try {
    await fetch('/api/manager/dashboard/seed-demo', { method: 'POST' });
    alert('Demo data seeded! Switch to the Dashboard tab to see it.');
    renderSettings();
  } catch (err) {
    alert('Error: ' + err.message);
  }
  btn.textContent = 'Seed Demo Data';
  btn.disabled = false;
}

function showAddTeamForm() {
  const form = document.getElementById('addTeamForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function filterEmployeeTable(query) {
  const rows = document.querySelectorAll('#employeeTable tbody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(query.toLowerCase()) ? '' : 'none';
  });
}


// ═══════════════════════════════════════════════════════════
// ─── MANAGER DASHBOARD ───
// ═══════════════════════════════════════════════════════════

async function renderMgrDashboard() {
  const container = document.getElementById('mgrDashboardContent');
  container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)"><div class="ai-loading" style="width:30px;height:30px;margin:0 auto 16px"></div>Loading Dashboard...</div>';

  try {
    const params = new URLSearchParams({ from: dashFilters.from, to: dashFilters.to });
    if (dashFilters.agent_id) params.set('agent_id', dashFilters.agent_id);
    if (dashFilters.team_id) params.set('team_id', dashFilters.team_id);
    if (dashFilters.label) params.set('label', dashFilters.label);
    const res = await fetch(`/api/manager/dashboard?${params}`);
    dashboardData = await res.json();
  } catch (err) {
    container.innerHTML = `<div style="padding:40px;color:var(--danger)">Error: ${err.message}. Try seeding demo data in Settings first.</div>`;
    return;
  }

  const d = dashboardData;
  const s = d.summary || {};

  container.innerHTML = `
    <div style="margin-bottom:24px">
      <h2 style="font-family:'Playfair Display',serif;font-size:2rem;font-weight:700;margin-bottom:4px">Manager Dashboard</h2>
      <p style="color:var(--text-secondary)">Real-time email support performance overview</p>
    </div>

    <!-- Filters -->
    <div style="display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap;align-items:center;background:var(--card);padding:16px 20px;border:1.5px solid var(--border);border-radius:var(--radius)">
      <label style="font-size:0.8rem;color:var(--text-muted);font-weight:600">DATE RANGE</label>
      <input type="date" value="${dashFilters.from}" onchange="dashFilters.from=this.value;renderMgrDashboard()" style="padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif">
      <span style="color:var(--text-muted)">to</span>
      <input type="date" value="${dashFilters.to}" onchange="dashFilters.to=this.value;renderMgrDashboard()" style="padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif">
      <div style="width:1px;height:24px;background:var(--border);margin:0 8px"></div>
      <button onclick="setDateRange('today')" style="padding:5px 12px;border:1.5px solid var(--border);border-radius:var(--radius-xs);background:var(--card);cursor:pointer;font-family:'DM Sans',sans-serif;font-size:0.8rem;font-weight:600">Today</button>
      <button onclick="setDateRange('7d')" style="padding:5px 12px;border:1.5px solid var(--border);border-radius:var(--radius-xs);background:var(--card);cursor:pointer;font-family:'DM Sans',sans-serif;font-size:0.8rem;font-weight:600">7 Days</button>
      <button onclick="setDateRange('30d')" style="padding:5px 12px;border:1.5px solid var(--border);border-radius:var(--radius-xs);background:var(--card);cursor:pointer;font-family:'DM Sans',sans-serif;font-size:0.8rem;font-weight:600">30 Days</button>
    </div>

    <!-- Scorecards Row -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px">
      ${scorecard('Total Tickets', s.total_tickets || 0, '📩')}
      ${scorecard('Resolved', s.resolved || 0, '✅', 'var(--success)')}
      ${scorecard('Open', s.open_tickets || 0, '📬', 'var(--warning)')}
      ${scorecard('Avg FRT', formatMinutes(s.avg_frt || 0), '⚡', 'var(--accent)')}
      ${scorecard('Avg Resolution', formatMinutes(s.avg_art || 0), '🎯', 'var(--accent)')}
    </div>

    <!-- Charts Grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px">
      <!-- 1. FRT Trend -->
      <div class="chart-card">
        <h4 class="chart-title">1. Average First Response Time (Trend)</h4>
        <div id="chart-frt" style="height:220px"></div>
      </div>

      <!-- 3. SLA Achievement -->
      <div class="chart-card">
        <h4 class="chart-title">3. SLA Achievement by Team</h4>
        <div id="chart-sla" style="height:220px"></div>
      </div>

      <!-- 4. Received vs Resolved -->
      <div class="chart-card">
        <h4 class="chart-title">4. Received vs Resolved Volume</h4>
        <div id="chart-volume" style="height:220px"></div>
      </div>

      <!-- 6. Backlog -->
      <div class="chart-card">
        <h4 class="chart-title">6. Current Backlog (Queue)</h4>
        <div id="chart-backlog" style="height:220px"></div>
      </div>

      <!-- 5. Agent Resolutions (Top 10) -->
      <div class="chart-card" style="grid-column:span 2">
        <h4 class="chart-title">5. Resolution Count per Agent (Top 10)</h4>
        <div id="chart-agents" style="height:280px"></div>
      </div>

      <!-- 8. Reopen Rate -->
      <div class="chart-card">
        <h4 class="chart-title">8. Re-open Rate</h4>
        <div id="chart-reopen" style="height:220px"></div>
      </div>

      <!-- 7. Exchanges Histogram -->
      <div class="chart-card">
        <h4 class="chart-title">7. Exchanges per Resolution</h4>
        <div id="chart-exchanges" style="height:220px"></div>
      </div>

      <!-- 9. Heatmap -->
      <div class="chart-card" style="grid-column:span 2">
        <h4 class="chart-title">9. Peak Traffic Heatmap</h4>
        <div id="chart-heatmap" style="height:220px;overflow-x:auto"></div>
      </div>

      <!-- 10. Agent Matrix -->
      <div class="chart-card">
        <h4 class="chart-title">10. Agent Speed vs Volume</h4>
        <div id="chart-matrix" style="height:260px"></div>
      </div>

      <!-- 11. Label Distribution -->
      <div class="chart-card">
        <h4 class="chart-title">11. Ticket Categories (Treemap)</h4>
        <div id="chart-labels" style="height:260px"></div>
      </div>
    </div>
  `;

  // Inject CSS for chart cards if not already added
  if (!document.getElementById('manager-styles')) {
    const style = document.createElement('style');
    style.id = 'manager-styles';
    style.textContent = `
      .chart-card { background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:24px; transition:all 0.2s ease; }
      .chart-card:hover { border-color:var(--accent); box-shadow:var(--shadow-md); }
      .chart-title { font-size:0.9rem; color:var(--text-secondary); font-weight:600; margin-bottom:16px; }
      .settings-subtab { padding:10px 20px; background:transparent; border:none; color:var(--text-secondary); border-radius:8px; cursor:pointer; font-size:0.95rem; font-weight:600; font-family:'DM Sans',sans-serif; transition:all 0.2s ease; }
      .settings-subtab.active { background:var(--card); color:var(--text-primary); box-shadow:var(--shadow-sm); }
      .perf-card { background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:24px; }
      .perf-card:hover { border-color:var(--accent); box-shadow:var(--shadow-md); }
    `;
    document.head.appendChild(style);
  }

  // Render all charts
  renderFRTChart(d.frtTrend || []);
  renderSLAChart(d.sla || []);
  renderVolumeChart(d.volume || []);
  renderBacklogChart(d.backlog || []);
  renderAgentChart(d.agentResolutions || []);
  renderReopenChart(d.reopenRate || []);
  renderExchangesChart(d.exchanges || []);
  renderHeatmap(d.heatmap || []);
  renderMatrixChart(d.agentMatrix || []);
  renderLabelTreemap(d.labelDist || []);
}


// ─── CHART RENDERING (Pure Canvas) ───

function renderFRTChart(data) {
  if (!data.length) return noData('chart-frt');
  const el = document.getElementById('chart-frt');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 50 };

  const vals = data.map(d => d.avg_frt);
  const maxVal = Math.max(...vals) * 1.2 || 60;

  // Grid lines
  ctx.strokeStyle = '#E5E7EB';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (h - pad.top - pad.bottom) * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#9CA3AF'; ctx.font = '10px DM Sans';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxVal * i / 4) + 'm', pad.left - 6, y + 3);
  }

  // Line
  ctx.strokeStyle = '#2563EB';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i / (data.length - 1 || 1));
    const y = pad.top + (h - pad.top - pad.bottom) * (1 - d.avg_frt / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill under line
  const lastX = pad.left + (w - pad.left - pad.right);
  ctx.lineTo(lastX, h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
  ctx.fill();

  // X labels
  ctx.fillStyle = '#9CA3AF'; ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
  data.forEach((d, i) => {
    if (data.length <= 10 || i % Math.ceil(data.length / 8) === 0) {
      const x = pad.left + (w - pad.left - pad.right) * (i / (data.length - 1 || 1));
      ctx.fillText(d.day.substring(5), x, h - pad.bottom + 16);
    }
  });
}

function renderSLAChart(data) {
  if (!data.length) return noData('chart-sla');
  const el = document.getElementById('chart-sla');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 50, left: 50 };
  const barW = Math.min(60, (w - pad.left - pad.right) / data.length - 10);

  data.forEach((d, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i + 0.5) / data.length - barW / 2;
    const pct = d.sla_pct || 0;
    const barH = (h - pad.top - pad.bottom) * (pct / 100);
    const y = h - pad.bottom - barH;

    // Bar
    ctx.fillStyle = pct >= 90 ? '#059669' : pct >= 70 ? '#D97706' : '#DC2626';
    ctx.beginPath();
    roundRect(ctx, x, y, barW, barH, 4);
    ctx.fill();

    // Value
    ctx.fillStyle = '#1A1A2E'; ctx.font = 'bold 11px DM Sans'; ctx.textAlign = 'center';
    ctx.fillText(pct.toFixed(0) + '%', x + barW / 2, y - 6);

    // Label
    ctx.fillStyle = '#9CA3AF'; ctx.font = '9px DM Sans';
    ctx.fillText(d.team_name || 'N/A', x + barW / 2, h - pad.bottom + 16);
  });

  // 95% target line
  const targetY = pad.top + (h - pad.top - pad.bottom) * (1 - 0.95);
  ctx.strokeStyle = '#DC2626'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.left, targetY); ctx.lineTo(w - pad.right, targetY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#DC2626'; ctx.font = '9px DM Sans'; ctx.textAlign = 'right';
  ctx.fillText('95% Target', w - pad.right, targetY - 4);
}

function renderVolumeChart(data) {
  if (!data.length) return noData('chart-volume');
  const el = document.getElementById('chart-volume');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const maxVal = Math.max(...data.map(d => Math.max(d.received, d.resolved))) * 1.2 || 10;

  // Area - Received
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i / (data.length - 1 || 1));
    const y = pad.top + (h - pad.top - pad.bottom) * (1 - d.received / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (w - pad.left - pad.right), h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.fillStyle = 'rgba(220, 38, 38, 0.12)'; ctx.fill();
  ctx.strokeStyle = '#DC2626'; ctx.lineWidth = 2; ctx.stroke();

  // Area - Resolved
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i / (data.length - 1 || 1));
    const y = pad.top + (h - pad.top - pad.bottom) * (1 - d.resolved / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (w - pad.left - pad.right), h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.fillStyle = 'rgba(5, 150, 105, 0.12)'; ctx.fill();
  ctx.strokeStyle = '#059669'; ctx.lineWidth = 2; ctx.stroke();

  // Legend
  ctx.fillStyle = '#DC2626'; ctx.fillRect(w - 140, 10, 12, 12);
  ctx.fillStyle = '#1A1A2E'; ctx.font = '10px DM Sans'; ctx.textAlign = 'left';
  ctx.fillText('Received', w - 124, 20);
  ctx.fillStyle = '#059669'; ctx.fillRect(w - 140, 28, 12, 12);
  ctx.fillStyle = '#1A1A2E'; ctx.fillText('Resolved', w - 124, 38);

  // X labels
  ctx.fillStyle = '#9CA3AF'; ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
  data.forEach((d, i) => {
    if (data.length <= 10 || i % Math.ceil(data.length / 8) === 0) {
      const x = pad.left + (w - pad.left - pad.right) * (i / (data.length - 1 || 1));
      ctx.fillText(d.day.substring(5), x, h - pad.bottom + 16);
    }
  });
}

function renderBacklogChart(data) {
  if (!data.length) return noData('chart-backlog');
  const el = document.getElementById('chart-backlog');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 30, right: 20, bottom: 40, left: 50 };

  const buckets = { 'lt24h': { label: '< 24h', color: '#059669', count: 0 }, '1to3days': { label: '1-3 days', color: '#D97706', count: 0 }, 'gt3days': { label: '> 3 days', color: '#DC2626', count: 0 } };
  data.forEach(d => { if (buckets[d.age_bucket]) buckets[d.age_bucket].count = d.count; });
  const items = Object.values(buckets);
  const maxVal = Math.max(...items.map(b => b.count)) * 1.2 || 10;
  const barW = Math.min(80, (w - pad.left - pad.right) / items.length - 20);

  items.forEach((b, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i + 0.5) / items.length - barW / 2;
    const barH = (h - pad.top - pad.bottom) * (b.count / maxVal);
    const y = h - pad.bottom - barH;
    ctx.fillStyle = b.color;
    roundRect(ctx, x, y, barW, barH, 6); ctx.fill();
    ctx.fillStyle = '#1A1A2E'; ctx.font = 'bold 14px DM Sans'; ctx.textAlign = 'center';
    ctx.fillText(b.count, x + barW / 2, y - 8);
    ctx.fillStyle = '#6B7280'; ctx.font = '11px DM Sans';
    ctx.fillText(b.label, x + barW / 2, h - pad.bottom + 18);
  });
}

function renderAgentChart(data) {
  if (!data.length) return noData('chart-agents');
  const el = document.getElementById('chart-agents');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 10, right: 40, bottom: 10, left: 140 };
  const top10 = data.slice(0, 10);
  const barH = Math.min(24, (h - pad.top - pad.bottom) / top10.length - 4);
  const maxVal = Math.max(...top10.map(d => d.resolved_count)) || 1;

  top10.forEach((d, i) => {
    const y = pad.top + (h - pad.top - pad.bottom) * i / top10.length + 2;
    const barW = (w - pad.left - pad.right) * (d.resolved_count / maxVal);
    const gradient = ctx.createLinearGradient(pad.left, 0, pad.left + barW, 0);
    gradient.addColorStop(0, '#2563EB'); gradient.addColorStop(1, '#7C3AED');
    ctx.fillStyle = gradient;
    roundRect(ctx, pad.left, y, barW, barH, 4); ctx.fill();

    ctx.fillStyle = '#1A1A2E'; ctx.font = '11px DM Sans'; ctx.textAlign = 'right';
    ctx.fillText(d.name, pad.left - 8, y + barH / 2 + 4);
    ctx.fillStyle = '#6B7280'; ctx.font = 'bold 10px DM Sans'; ctx.textAlign = 'left';
    ctx.fillText(d.resolved_count, pad.left + barW + 6, y + barH / 2 + 4);
  });
}

function renderReopenChart(data) {
  if (!data.length) return noData('chart-reopen');
  const el = document.getElementById('chart-reopen');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const maxPct = Math.max(15, ...data.map(d => d.reopen_pct || 0)) * 1.2;

  // 5% threshold line
  const threshY = pad.top + (h - pad.top - pad.bottom) * (1 - 5 / maxPct);
  ctx.strokeStyle = '#DC2626'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.left, threshY); ctx.lineTo(w - pad.right, threshY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#DC2626'; ctx.font = '9px DM Sans'; ctx.textAlign = 'right';
  ctx.fillText('5% Threshold', w - pad.right, threshY - 4);

  // Line
  ctx.strokeStyle = '#D97706'; ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i / (data.length - 1 || 1));
    const y = pad.top + (h - pad.top - pad.bottom) * (1 - (d.reopen_pct || 0) / maxPct);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderExchangesChart(data) {
  if (!data.length) return noData('chart-exchanges');
  const el = document.getElementById('chart-exchanges');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const maxCount = Math.max(...data.map(d => d.ticket_count)) * 1.2 || 10;
  const barW = Math.min(40, (w - pad.left - pad.right) / data.length - 4);

  data.forEach((d, i) => {
    const x = pad.left + (w - pad.left - pad.right) * (i + 0.5) / data.length - barW / 2;
    const barH = (h - pad.top - pad.bottom) * (d.ticket_count / maxCount);
    const y = h - pad.bottom - barH;
    ctx.fillStyle = d.exchange_count <= 2 ? '#059669' : d.exchange_count <= 5 ? '#D97706' : '#DC2626';
    roundRect(ctx, x, y, barW, barH, 3); ctx.fill();
    ctx.fillStyle = '#9CA3AF'; ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
    ctx.fillText(d.exchange_count, x + barW / 2, h - pad.bottom + 14);
  });
}

function renderHeatmap(data) {
  if (!data.length) return noData('chart-heatmap');
  const el = document.getElementById('chart-heatmap');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = { top: 20, right: 10, bottom: 10, left: 40 };
  const cellW = (w - pad.left - pad.right) / 24;
  const cellH = (h - pad.top - pad.bottom) / 7;
  const maxVal = Math.max(...data.map(d => d.count)) || 1;

  // Build grid
  const grid = Array(7).fill(null).map(() => Array(24).fill(0));
  data.forEach(d => { grid[d.day_of_week][d.hour] = d.count; });

  grid.forEach((row, dayIdx) => {
    ctx.fillStyle = '#9CA3AF'; ctx.font = '10px DM Sans'; ctx.textAlign = 'right';
    ctx.fillText(days[dayIdx], pad.left - 6, pad.top + cellH * dayIdx + cellH / 2 + 3);
    row.forEach((val, hourIdx) => {
      const x = pad.left + cellW * hourIdx;
      const y = pad.top + cellH * dayIdx;
      const intensity = val / maxVal;
      const r = Math.round(37 + (220 - 37) * (1 - intensity));
      const g = Math.round(99 + (240 - 99) * (1 - intensity));
      const b = Math.round(235 + (240 - 235) * (1 - intensity));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      roundRect(ctx, x + 1, y + 1, cellW - 2, cellH - 2, 2); ctx.fill();
    });
  });

  // Hour labels
  ctx.fillStyle = '#9CA3AF'; ctx.font = '8px DM Sans'; ctx.textAlign = 'center';
  for (let i = 0; i < 24; i += 3) {
    ctx.fillText(i + ':00', pad.left + cellW * i + cellW / 2, pad.top - 6);
  }
}

function renderMatrixChart(data) {
  if (!data.length) return noData('chart-matrix');
  const el = document.getElementById('chart-matrix');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 60 };

  const maxVol = Math.max(...data.map(d => d.volume)) * 1.2 || 10;
  const maxSpeed = Math.max(...data.map(d => d.avg_hours)) * 1.2 || 10;

  // Quadrant labels
  ctx.fillStyle = 'rgba(5,150,105,0.06)';
  ctx.fillRect(pad.left + (w - pad.left - pad.right) / 2, pad.top, (w - pad.left - pad.right) / 2, (h - pad.top - pad.bottom) / 2);
  ctx.fillStyle = 'rgba(220,38,38,0.06)';
  ctx.fillRect(pad.left, pad.top + (h - pad.top - pad.bottom) / 2, (w - pad.left - pad.right) / 2, (h - pad.top - pad.bottom) / 2);

  ctx.fillStyle = '#059669'; ctx.font = '9px DM Sans'; ctx.textAlign = 'right';
  ctx.fillText('⭐ Superstars', w - pad.right - 4, pad.top + 14);
  ctx.fillStyle = '#DC2626';
  ctx.fillText('⚠️ Needs Review', pad.left + (w - pad.left - pad.right) / 2 - 4, h - pad.bottom - 4);

  // Dots
  data.forEach(d => {
    const x = pad.left + (w - pad.left - pad.right) * (d.avg_hours / maxSpeed);
    const y = pad.top + (h - pad.top - pad.bottom) * (1 - d.volume / maxVol);
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.7)'; ctx.fill();
    ctx.strokeStyle = '#2563EB'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#1A1A2E'; ctx.font = '8px DM Sans'; ctx.textAlign = 'center';
    ctx.fillText(d.name.split(' ')[0], x, y - 10);
  });

  // Axes labels
  ctx.fillStyle = '#6B7280'; ctx.font = '10px DM Sans';
  ctx.textAlign = 'center';
  ctx.fillText('Avg Resolution Hours →', w / 2, h - 4);
  ctx.save(); ctx.translate(12, h / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('Volume →', 0, 0); ctx.restore();
}

function renderLabelTreemap(data) {
  if (!data.length) return noData('chart-labels');
  const el = document.getElementById('chart-labels');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const total = data.reduce((s, d) => s + d.count, 0);
  const colors = ['#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#0891B2', '#CA8A04', '#BE185D'];

  let x = 0;
  data.forEach((d, i) => {
    const itemW = (d.count / total) * w;
    ctx.fillStyle = colors[i % colors.length];
    roundRect(ctx, x + 2, 2, itemW - 4, h - 4, 6); ctx.fill();
    if (itemW > 50) {
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px DM Sans'; ctx.textAlign = 'center';
      ctx.fillText(d.label, x + itemW / 2, h / 2 - 4);
      ctx.font = '10px DM Sans';
      ctx.fillText(d.count, x + itemW / 2, h / 2 + 14);
    }
    x += itemW;
  });
}


// ═══════════════════════════════════════════════════════════
// ─── AGENT PERFORMANCE TAB ───
// ═══════════════════════════════════════════════════════════

async function renderPerformance() {
  const container = document.getElementById('performanceContent');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)"><div class="ai-loading" style="width:30px;height:30px;margin:0 auto 16px"></div>Loading Performance Data...</div>';

  try {
    const params = new URLSearchParams({ from: perfFilters.from, to: perfFilters.to });
    const res = await fetch(`/api/manager/dashboard?${params}`);
    const data = await res.json();

    container.innerHTML = `
      <div style="margin-bottom:24px">
        <h2 style="font-family:'Playfair Display',serif;font-size:2rem;font-weight:700;margin-bottom:4px">Individual Performance</h2>
        <p style="color:var(--text-secondary)">Agent-level metrics for productivity, speed, quality, and consistency</p>
      </div>

      <!-- Filters -->
      <div style="display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap;align-items:center;background:var(--card);padding:16px 20px;border:1.5px solid var(--border);border-radius:var(--radius)">
        <label style="font-size:0.8rem;color:var(--text-muted);font-weight:600">PERIOD</label>
        <button onclick="setPerfRange('24h')" class="perf-filter-btn">24h</button>
        <button onclick="setPerfRange('7d')" class="perf-filter-btn active">7 Days</button>
        <button onclick="setPerfRange('30d')" class="perf-filter-btn">30 Days</button>
        <div style="width:1px;height:24px;background:var(--border);margin:0 8px"></div>
        <input type="text" placeholder="🔍 Search agent..." id="perfAgentSearch" oninput="filterPerfCards(this.value)" style="padding:6px 12px;border:1.5px solid var(--border);border-radius:var(--radius-xs);font-family:'DM Sans',sans-serif;width:200px">
      </div>

      <!-- I. Productivity: Agent Resolutions Ranked -->
      <div style="margin-bottom:28px">
        <h3 style="font-weight:700;margin-bottom:12px;color:var(--text-primary)">I. Productivity & Volume</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div class="perf-card">
            <h4 class="chart-title">1. Total Resolutions (Ranked)</h4>
            <div style="display:flex;gap:8px;margin-bottom:12px">
              <button onclick="togglePerfView('top10')" class="perf-toggle active" id="btn-top10">Top 10</button>
              <button onclick="togglePerfView('bottom10')" class="perf-toggle" id="btn-bottom10">Bottom 10</button>
            </div>
            <div id="perf-resolutions" style="height:300px"></div>
          </div>
          <div class="perf-card">
            <h4 class="chart-title">3. Touch Count (Replies per Resolution)</h4>
            <div id="perf-touches" style="height:300px"></div>
          </div>
        </div>
      </div>

      <!-- II. Speed -->
      <div style="margin-bottom:28px">
        <h3 style="font-weight:700;margin-bottom:12px;color:var(--text-primary)">II. Speed & Responsiveness</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div class="perf-card">
            <h4 class="chart-title">6. SLA Achievement per Agent</h4>
            <div id="perf-sla" style="height:280px"></div>
          </div>
          <div class="perf-card">
            <h4 class="chart-title">5. Handle Time vs Volume (Scatter)</h4>
            <div id="perf-scatter" style="height:280px"></div>
          </div>
        </div>
      </div>

      <!-- III. Quality -->
      <div style="margin-bottom:28px">
        <h3 style="font-weight:700;margin-bottom:12px;color:var(--text-primary)">III. Quality & Reliability</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div class="perf-card">
            <h4 class="chart-title">7. Individual Re-open Rate</h4>
            <div id="perf-reopen" style="height:260px"></div>
          </div>
          <div class="perf-card">
            <h4 class="chart-title">8. Stale Tickets per Agent</h4>
            <div id="perf-stale" style="min-height:260px"></div>
          </div>
        </div>
      </div>

      <!-- IV. Consistency: Agent Cards -->
      <div style="margin-bottom:28px">
        <h3 style="font-weight:700;margin-bottom:12px;color:var(--text-primary)">IV. Agent Player Cards</h3>
        <div id="perf-agent-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px"></div>
      </div>
    `;

    // Render perf charts
    renderPerfResolutions(data.agentResolutions || [], 'top');
    renderPerfTouches(data.agentResolutions || []);
    renderPerfSLA(data.agentResolutions || []);
    renderPerfScatter(data.agentMatrix || []);
    renderPerfAgentCards(data.agentResolutions || [], data.agentActivity || []);

  } catch (err) {
    container.innerHTML = `<div style="padding:40px;color:var(--danger)">Error: ${err.message}. Seed demo data in Settings first.</div>`;
  }
}

function renderPerfResolutions(data, view) {
  const el = document.getElementById('perf-resolutions');
  if (!el || !data.length) return noData('perf-resolutions');
  const display = view === 'top' ? data.slice(0, 10) : data.slice(-10).reverse();
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 10, right: 40, bottom: 10, left: 120 };
  const barH = Math.min(24, (h - pad.top - pad.bottom) / display.length - 4);
  const maxVal = Math.max(...display.map(d => d.resolved_count)) || 1;

  display.forEach((d, i) => {
    const y = pad.top + (h - pad.top - pad.bottom) * i / display.length + 2;
    const barW = (w - pad.left - pad.right) * (d.resolved_count / maxVal);
    ctx.fillStyle = view === 'top' ? '#059669' : '#DC2626';
    roundRect(ctx, pad.left, y, barW, barH, 4); ctx.fill();
    ctx.fillStyle = '#1A1A2E'; ctx.font = '10px DM Sans'; ctx.textAlign = 'right';
    ctx.fillText(d.name, pad.left - 8, y + barH / 2 + 3);
    ctx.fillStyle = '#6B7280'; ctx.font = 'bold 10px DM Sans'; ctx.textAlign = 'left';
    ctx.fillText(d.resolved_count, pad.left + barW + 6, y + barH / 2 + 3);
  });
}

function renderPerfTouches(data) {
  if (!data.length) return noData('perf-touches');
  // Show avg resolution minutes grouped as one-touch vs multi-touch
  const el = document.getElementById('perf-touches');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 30, right: 20, bottom: 50, left: 120 };
  const top10 = data.slice(0, 10);
  const barH = Math.min(22, (h - pad.top - pad.bottom) / top10.length - 4);
  const maxMin = Math.max(...top10.map(d => d.avg_resolution_min || 0)) || 1;

  top10.forEach((d, i) => {
    const y = pad.top + (h - pad.top - pad.bottom) * i / top10.length;
    const barW = (w - pad.left - pad.right) * ((d.avg_resolution_min || 0) / maxMin);
    const color = d.avg_resolution_min < 200 ? '#059669' : d.avg_resolution_min < 500 ? '#D97706' : '#DC2626';
    ctx.fillStyle = color;
    roundRect(ctx, pad.left, y, barW, barH, 4); ctx.fill();
    ctx.fillStyle = '#1A1A2E'; ctx.font = '10px DM Sans'; ctx.textAlign = 'right';
    ctx.fillText(d.name, pad.left - 8, y + barH / 2 + 3);
    ctx.fillStyle = '#6B7280'; ctx.font = '9px DM Sans'; ctx.textAlign = 'left';
    ctx.fillText(formatMinutes(d.avg_resolution_min), pad.left + barW + 6, y + barH / 2 + 3);
  });

  ctx.fillStyle = '#9CA3AF'; ctx.font = '10px DM Sans'; ctx.textAlign = 'center';
  ctx.fillText('Avg Resolution Time →', w / 2, h - 6);
}

function renderPerfSLA(data) {
  if (!data.length) return noData('perf-sla');
  const el = document.getElementById('perf-sla');
  const canvas = createCanvas(el);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 10, left: 120 };
  const top10 = data.slice(0, 10);
  const barH = Math.min(20, (h - pad.top - pad.bottom) / top10.length - 4);

  top10.forEach((d, i) => {
    const y = pad.top + (h - pad.top - pad.bottom) * i / top10.length;
    // Simulate SLA % based on speed (faster = higher SLA)
    const slaPct = Math.min(100, Math.max(40, 100 - (d.avg_resolution_min || 0) / 20));
    const barW = (w - pad.left - pad.right) * (slaPct / 100);
    ctx.fillStyle = slaPct >= 90 ? '#059669' : slaPct >= 70 ? '#D97706' : '#DC2626';
    roundRect(ctx, pad.left, y, barW, barH, 4); ctx.fill();
    // Background track
    ctx.fillStyle = '#F3F4F6';
    roundRect(ctx, pad.left + barW, y, (w - pad.left - pad.right) - barW, barH, 4); ctx.fill();

    ctx.fillStyle = '#1A1A2E'; ctx.font = '10px DM Sans'; ctx.textAlign = 'right';
    ctx.fillText(d.name, pad.left - 8, y + barH / 2 + 3);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'left';
    if (barW > 30) ctx.fillText(slaPct.toFixed(0) + '%', pad.left + 6, y + barH / 2 + 3);
  });

  // 95% target line
  const targetX = pad.left + (w - pad.left - pad.right) * 0.95;
  ctx.strokeStyle = '#DC2626'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(targetX, pad.top); ctx.lineTo(targetX, h - pad.bottom); ctx.stroke();
  ctx.setLineDash([]);
}

function renderPerfScatter(data) {
  // Reuse matrix chart logic
  renderMatrixChart(data);
  // Copy the canvas to perf-scatter if matrix exists
  const src = document.querySelector('#chart-matrix canvas');
  const dest = document.getElementById('perf-scatter');
  if (src && dest) {
    const canvas = createCanvas(dest);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }
}

function renderPerfAgentCards(resolutions, activity) {
  const container = document.getElementById('perf-agent-cards');
  if (!container) return;
  const top = resolutions.slice(0, 12);
  container.innerHTML = top.map(agent => {
    const act = activity.find(a => a.id === agent.id) || {};
    const speedRating = agent.avg_resolution_min < 200 ? '⚡ Fast' : agent.avg_resolution_min < 500 ? '🟡 Average' : '🔴 Slow';
    const volumeRating = agent.resolved_count > 30 ? '📈 High' : agent.resolved_count > 15 ? '📊 Medium' : '📉 Low';
    return `
      <div class="perf-card agent-card" style="position:relative">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div style="width:40px;height:40px;border-radius:50%;background:var(--accent-light);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem">${agent.name.split(' ').map(w=>w[0]).join('')}</div>
          <div>
            <div style="font-weight:700;font-size:1.05rem">${agent.name}</div>
            <div style="font-size:0.8rem;color:var(--text-muted)">${speedRating} · ${volumeRating}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="background:var(--bg);padding:10px;border-radius:var(--radius-xs)">
            <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Resolved</div>
            <div style="font-weight:700;font-size:1.2rem;color:var(--success)">${agent.resolved_count}</div>
          </div>
          <div style="background:var(--bg);padding:10px;border-radius:var(--radius-xs)">
            <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Avg Time</div>
            <div style="font-weight:700;font-size:1.2rem;color:var(--accent)">${formatMinutes(agent.avg_resolution_min)}</div>
          </div>
          <div style="background:var(--bg);padding:10px;border-radius:var(--radius-xs)">
            <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Replies</div>
            <div style="font-weight:700;font-size:1.2rem">${act.replies || 0}</div>
          </div>
          <div style="background:var(--bg);padding:10px;border-radius:var(--radius-xs)">
            <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Activity</div>
            <div style="font-weight:700;font-size:1.2rem">${act.total_events || 0}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function togglePerfView(view) {
  document.querySelectorAll('.perf-toggle').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-' + view)?.classList.add('active');
  if (dashboardData) {
    renderPerfResolutions(dashboardData.agentResolutions || [], view === 'top10' ? 'top' : 'bottom');
  }
}

function filterPerfCards(query) {
  document.querySelectorAll('.agent-card').forEach(card => {
    card.style.display = card.textContent.toLowerCase().includes(query.toLowerCase()) ? '' : 'none';
  });
}

function setPerfRange(range) {
  const now = new Date();
  if (range === '24h') perfFilters.from = new Date(now - 24*60*60*1000).toISOString().split('T')[0];
  else if (range === '7d') perfFilters.from = new Date(now - 7*24*60*60*1000).toISOString().split('T')[0];
  else if (range === '30d') perfFilters.from = new Date(now - 30*24*60*60*1000).toISOString().split('T')[0];
  perfFilters.to = now.toISOString().split('T')[0];
  renderPerformance();
}


// ═══════════════════════════════════════════════════════════
// ─── UTILITIES ───
// ═══════════════════════════════════════════════════════════

function formatMinutes(mins) {
  if (!mins || mins === 0) return '0m';
  mins = Math.round(mins);
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h + 'h ' + (m > 0 ? m + 'm' : '');
}

function scorecard(label, value, icon, color) {
  return `
    <div style="background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);padding:20px;transition:all 0.2s ease" onmouseover="this.style.borderColor='${color || 'var(--accent)'}'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">${label}</span>
        <span style="font-size:1.2rem">${icon}</span>
      </div>
      <div style="font-family:'Playfair Display',serif;font-size:2rem;font-weight:700;color:${color || 'var(--text-primary)'}">${value}</div>
    </div>`;
}

function createCanvas(el) {
  el.innerHTML = '';
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = el.clientWidth * dpr;
  canvas.height = el.clientHeight * dpr;
  canvas.style.width = el.clientWidth + 'px';
  canvas.style.height = el.clientHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  canvas.width = el.clientWidth;
  canvas.height = el.clientHeight;
  el.appendChild(canvas);
  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function noData(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.9rem">No data available. Seed demo data in Settings.</div>';
}

function setDateRange(range) {
  const now = new Date();
  if (range === 'today') dashFilters.from = now.toISOString().split('T')[0];
  else if (range === '7d') dashFilters.from = new Date(now - 7*24*60*60*1000).toISOString().split('T')[0];
  else if (range === '30d') dashFilters.from = new Date(now - 30*24*60*60*1000).toISOString().split('T')[0];
  dashFilters.to = now.toISOString().split('T')[0];
  renderMgrDashboard();
}

// ═══════════════════════════════════════════════════════════
// AI TRAINING PANEL
// ═══════════════════════════════════════════════════════════

function renderAiTrainingPanel() {
  return `
    <div style="max-width:900px;">
      <div style="font-weight:700;font-size:1.1rem;margin-bottom:8px;">AI Training Data</div>
      <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:20px;">
        Extract training examples from your team's sent emails. The AI learns your tone, product knowledge, and how to handle different types of questions.
      </p>

      <!-- Connect Training Accounts -->
      <div style="background:var(--card);border:1px solid var(--border-light);border-radius:var(--radius-sm);padding:20px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div>
            <div style="font-weight:600;">Connected Gmail Accounts</div>
            <div style="font-size:0.8rem;color:var(--text-secondary);">Connect Gmail accounts to scan their sent emails for training. These won't sync into your inbox.</div>
          </div>
          <button onclick="connectTrainingGmail()" style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:0.85rem;cursor:pointer;font-weight:500;white-space:nowrap;display:flex;align-items:center;gap:6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Connect Gmail
          </button>
        </div>
        <div id="trainingAccountsList" style="font-size:0.85rem;color:var(--text-muted);">Loading...</div>
      </div>

      <!-- Step 1: Extract -->
      <div style="background:var(--card);border:1px solid var(--border-light);border-radius:var(--radius-sm);padding:20px;margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:12px;">Step 1: Extract from Gmail</div>
        <div style="display:flex;gap:12px;align-items:end;flex-wrap:wrap;">
          <div>
            <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:4px;">Mailbox</label>
            <select id="trainingMailbox" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;">
              <option value="">Loading...</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:4px;">Max threads</label>
            <input type="number" id="trainingMaxThreads" value="50" min="10" max="200" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;width:80px;">
          </div>
          <button onclick="extractTrainingData()" id="extractBtn" style="padding:8px 20px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:0.9rem;cursor:pointer;font-weight:600;height:38px;">
            Extract Examples
          </button>
        </div>
        <div style="margin-top:14px;">
          <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:6px;">Learn from these reps only (uncheck to exclude):</label>
          <div id="repFilterList" style="display:flex;flex-wrap:wrap;gap:8px;">
            <div style="color:var(--text-muted);font-size:0.8rem;">Loading team...</div>
          </div>
        </div>
        <div style="margin-top:14px;">
          <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:6px;">Search filter (or use a preset):</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
            <button onclick="setSearchPreset('all')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">All Sent</button>
            <button onclick="setSearchPreset('products')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">Product Quotes</button>
            <button onclick="setSearchPreset('warranty')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">Warranty</button>
            <button onclick="setSearchPreset('shipping')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">Shipping</button>
            <button onclick="setSearchPreset('returns')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">Returns</button>
            <button onclick="setSearchPreset('artwork')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">Artwork/Design</button>
            <button onclick="setSearchPreset('rush')" class="preset-btn" style="padding:4px 10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;font-size:0.75rem;cursor:pointer;">Rush Orders</button>
          </div>
          <input type="text" id="trainingSearchQuery" placeholder="Custom Gmail search (e.g. subject:table throw, has:attachment, after:2024/01/01)" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.85rem;">
        </div>
        <div id="extractStatus" style="margin-top:12px;font-size:0.85rem;color:var(--text-secondary);"></div>
      </div>

      <!-- Step 2: Review & Curate -->
      <div id="curationPanel" style="display:none;background:var(--card);border:1px solid var(--border-light);border-radius:var(--radius-sm);padding:20px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-weight:600;">Step 2: Review Curated Examples</div>
          <button onclick="saveAllTrainingExamples()" id="saveAllBtn" style="padding:8px 16px;background:#059669;color:#fff;border:none;border-radius:6px;font-size:0.85rem;cursor:pointer;font-weight:600;">Save All to Training</button>
        </div>
        <div id="curatedExamples"></div>
      </div>

      <!-- Existing Rules -->
      <div style="background:var(--card);border:1px solid var(--border-light);border-radius:var(--radius-sm);padding:20px;">
        <div style="font-weight:600;margin-bottom:12px;">Current Training Rules & Examples</div>
        <div id="existingRules"><div style="color:var(--text-muted);font-size:0.85rem;">Loading...</div></div>
      </div>
    </div>
  `;
}

function setSearchPreset(preset) {
  const input = document.getElementById('trainingSearchQuery');
  const presets = {
    'all': 'in:sent -from:mailer-daemon',
    'products': 'in:sent (subject:quote OR subject:pricing OR subject:options OR subject:booth OR subject:"table throw" OR subject:banner OR subject:flag OR subject:display)',
    'warranty': 'in:sent (subject:warranty OR "warranty" OR "lifetime warranty" OR "1 year warranty" OR "manufacturing defect")',
    'shipping': 'in:sent (subject:shipping OR subject:delivery OR subject:tracking OR "ships from" OR "free shipping" OR "UPS")',
    'returns': 'in:sent (subject:return OR subject:refund OR subject:exchange OR subject:damaged OR "return policy")',
    'artwork': 'in:sent (subject:artwork OR subject:template OR subject:graphic OR subject:design OR subject:proof OR "art file" OR "CMYK" OR "125 DPI")',
    'rush': 'in:sent (subject:rush OR "rush order" OR "same day" OR "next day" OR "expedited" OR "urgent")'
  };
  if (input) input.value = presets[preset] || presets['all'];
  // Highlight active preset
  document.querySelectorAll('.preset-btn').forEach(b => b.style.background = '#f3f4f6');
  if (event && event.target) event.target.style.background = '#dbeafe';
}

let _nextPageToken = null;

async function extractTrainingData(pageToken) {
  const btn = document.getElementById('extractBtn');
  const status = document.getElementById('extractStatus');
  const mailbox = document.getElementById('trainingMailbox').value;
  const maxThreads = parseInt(document.getElementById('trainingMaxThreads').value) || 50;
  const searchQuery = document.getElementById('trainingSearchQuery')?.value?.trim() || '';

  btn.disabled = true;
  btn.textContent = pageToken ? 'Loading next page...' : 'Scanning Gmail...';
  status.textContent = 'Scanning sent emails — this may take a minute...';

  try {
    const selectedReps = getSelectedRepEmails();
    if (selectedReps.length === 0) {
      status.textContent = 'Please select at least one rep to learn from.';
      btn.disabled = false;
      btn.textContent = 'Extract Examples';
      return;
    }

    // Step 1: Extract raw pairs from Gmail
    const extractResp = await fetch('/api/ai/training/extract', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mailbox_email: mailbox,
        max_threads: maxThreads,
        rep_emails: selectedReps,
        search_query: searchQuery || undefined,
        page_token: pageToken || undefined
      })
    });
    const extractData = await extractResp.json();

    if (!extractData.examples || extractData.examples.length === 0) {
      status.textContent = 'No email pairs found. Try a different mailbox or increase the thread count.';
      btn.disabled = false;
      btn.textContent = 'Extract Examples';
      return;
    }

    status.textContent = `Found ${extractData.examples_found} email pairs from ${extractData.total_threads_scanned} threads. Curating with AI...`;

    // Step 2: Curate with Gemini (process in batches of 20)
    let allCurated = [];
    const batchSize = 20;
    for (let i = 0; i < extractData.examples.length; i += batchSize) {
      const batch = extractData.examples.slice(i, i + batchSize);
      status.textContent = `Curating batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(extractData.examples.length / batchSize)}...`;

      const curateResp = await fetch('/api/ai/training/curate', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examples: batch })
      });
      const curateData = await curateResp.json();
      if (curateData.curated) allCurated.push(...curateData.curated);
    }

    // Save next page token for pagination
    _nextPageToken = extractData.next_page_token || null;
    const paginationHtml = _nextPageToken
      ? ` <button onclick="extractTrainingData('${_nextPageToken}')" style="padding:4px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;font-size:0.8rem;cursor:pointer;margin-left:8px;">Load Next Page →</button>`
      : '';

    status.innerHTML = `<span style="color:#059669;font-weight:600;">Done! ${allCurated.length} quality examples found from ${extractData.examples_found} email pairs.</span>${paginationHtml}`;

    // Show curated examples for review
    window._curatedExamples = allCurated;
    const panel = document.getElementById('curationPanel');
    panel.style.display = 'block';

    const container = document.getElementById('curatedExamples');
    container.innerHTML = allCurated.map((ex, i) => `
      <div id="curatedEx-${i}" style="border:1px solid var(--border-light);border-radius:8px;padding:14px;margin-bottom:10px;background:#fafafa;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div>
            <span style="background:#ede9fe;color:#7c3aed;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">${ex.category}</span>
            <span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;margin-left:4px;">Score: ${ex.quality_score}/10</span>
          </div>
          <button onclick="document.getElementById('curatedEx-${i}').remove();window._curatedExamples[${i}]=null;" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:0.8rem;">Remove</button>
        </div>
        <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:6px;font-style:italic;">${ex.lesson || ''}</div>
        <div style="font-size:0.85rem;margin-bottom:6px;"><strong>Customer:</strong> ${(ex.example_email || '').substring(0, 200)}</div>
        <div style="font-size:0.85rem;color:#333;"><strong>Response:</strong> ${(ex.example_response || '').substring(0, 300)}${(ex.example_response || '').length > 300 ? '...' : ''}</div>
      </div>
    `).join('');

  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Extract Examples';
  }
}

async function saveAllTrainingExamples() {
  const examples = (window._curatedExamples || []).filter(e => e !== null);
  if (examples.length === 0) { alert('No examples to save'); return; }

  const btn = document.getElementById('saveAllBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const resp = await fetch('/api/ai/training/save', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examples })
    });
    const data = await resp.json();
    btn.textContent = `Saved ${data.saved} examples!`;
    btn.style.background = '#059669';

    // Refresh the rules list
    loadExistingRules();

    setTimeout(() => {
      btn.textContent = 'Save All to Training';
      btn.style.background = '';
      btn.disabled = false;
      document.getElementById('curationPanel').style.display = 'none';
    }, 3000);
  } catch (err) {
    alert('Failed to save: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Save All to Training';
  }
}

async function loadExistingRules() {
  const container = document.getElementById('existingRules');
  if (!container) return;

  try {
    const resp = await fetch('/api/ai/training/rules', { credentials: 'include' });
    const rules = await resp.json();

    if (rules.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:12px;">No training rules yet. Extract some from your sent emails above.</div>';
      return;
    }

    container.innerHTML = `
      <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px;">${rules.length} training rules</div>
      ${rules.map(r => `
        <div style="display:flex;gap:10px;align-items:flex-start;padding:10px;border-bottom:1px solid var(--border-light);">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:4px;margin-bottom:4px;">
              <span style="background:#ede9fe;color:#7c3aed;padding:1px 6px;border-radius:10px;font-size:0.7rem;font-weight:600;">${r.email_category}</span>
              <span style="background:${r.rule_type === 'example' ? '#dcfce7' : '#fef3c7'};color:${r.rule_type === 'example' ? '#16a34a' : '#92400e'};padding:1px 6px;border-radius:10px;font-size:0.7rem;">${r.rule_type}</span>
            </div>
            <div style="font-size:0.8rem;color:#555;">${(r.content || '').substring(0, 150)}</div>
          </div>
          <button onclick="deleteTrainingRule('${r.id}')" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:0.8rem;flex-shrink:0;">Delete</button>
        </div>
      `).join('')}
    `;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger)">Error: ${err.message}</div>`;
  }
}

async function deleteTrainingRule(id) {
  if (!confirm('Delete this training rule?')) return;
  try {
    await fetch('/api/ai/training/rules/' + id, { method: 'DELETE', credentials: 'include' });
    loadExistingRules();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// Auto-load existing rules and rep list when training tab is shown
const origSwitchTab = switchSettingsTab;
switchSettingsTab = function(tab) {
  origSwitchTab(tab);
  if (tab === 'aitraining') {
    loadExistingRules();
    loadRepFilterList();
    loadTrainingAccounts();
  }
};

async function connectTrainingGmail() {
  try {
    const resp = await fetch('/api/mailboxes/oauth/start?type=training&name=Training', { credentials: 'include' });
    const data = await resp.json();
    if (data.authUrl) {
      window.open(data.authUrl, '_blank', 'width=600,height=700');
      // Poll for completion
      const checkInterval = setInterval(async () => {
        await loadTrainingAccounts();
        // Check if new account appeared
        const select = document.getElementById('trainingMailbox');
        if (select && select.options.length > 1) {
          clearInterval(checkInterval);
        }
      }, 3000);
      setTimeout(() => clearInterval(checkInterval), 120000); // Stop after 2 min
    }
  } catch (err) {
    alert('Failed to start OAuth: ' + err.message);
  }
}

async function loadTrainingAccounts() {
  const listDiv = document.getElementById('trainingAccountsList');
  const select = document.getElementById('trainingMailbox');

  try {
    const resp = await fetch('/api/mailboxes', { credentials: 'include' });
    const mailboxes = await resp.json();

    // Update the accounts list display
    if (listDiv) {
      if (mailboxes.length === 0) {
        listDiv.innerHTML = '<div style="color:var(--text-muted);">No accounts connected yet.</div>';
      } else {
        listDiv.innerHTML = mailboxes.map(m => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;${m.mailbox_type === 'training' ? '' : 'border-bottom:none;'}">
            <span style="background:${m.mailbox_type === 'training' ? '#fef3c7' : '#dcfce7'};color:${m.mailbox_type === 'training' ? '#92400e' : '#16a34a'};padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:600;">
              ${m.mailbox_type === 'training' ? 'Training Only' : 'Active Mailbox'}
            </span>
            <span style="font-weight:500;">${m.email}</span>
            <span style="color:var(--text-muted);font-size:0.75rem;">${m.name}</span>
          </div>
        `).join('');
      }
    }

    // Update the dropdown
    if (select) {
      const currentVal = select.value;
      select.innerHTML = mailboxes.map(m =>
        `<option value="${m.email}">${m.email}${m.mailbox_type === 'training' ? ' (training)' : ''}</option>`
      ).join('');
      if (currentVal) select.value = currentVal;
    }
  } catch (err) {
    if (listDiv) listDiv.innerHTML = `<div style="color:var(--danger);">Failed to load: ${err.message}</div>`;
  }
}

async function loadRepFilterList() {
  const container = document.getElementById('repFilterList');
  if (!container) return;
  try {
    const resp = await fetch('/api/manager/employees', { credentials: 'include' });
    const employees = await resp.json();
    if (!employees || employees.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No team members found</div>';
      return;
    }
    container.innerHTML = employees.map(emp => `
      <label style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:var(--bg-secondary);border:1px solid var(--border-light);border-radius:8px;cursor:pointer;font-size:0.85rem;transition:all 0.15s;" onmouseenter="this.style.borderColor='#2563eb'" onmouseleave="this.style.borderColor=''">
        <input type="checkbox" class="rep-filter-cb" value="${emp.email}" checked style="width:16px;height:16px;accent-color:#2563eb;cursor:pointer;">
        <span style="font-weight:500;">${emp.name}</span>
        <span style="color:var(--text-muted);font-size:0.75rem;">${emp.email}</span>
        <span style="background:${emp.role === 'Manager' ? '#dbeafe' : '#f3f4f6'};color:${emp.role === 'Manager' ? '#1d4ed8' : '#6b7280'};padding:1px 6px;border-radius:10px;font-size:0.7rem;font-weight:600;">${emp.role}</span>
      </label>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div style="color:var(--danger);font-size:0.8rem;">Failed to load team</div>';
  }
}

function getSelectedRepEmails() {
  const checkboxes = document.querySelectorAll('.rep-filter-cb:checked');
  return [...checkboxes].map(cb => cb.value);
}
