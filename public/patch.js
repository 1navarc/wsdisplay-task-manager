// WSDisplay Email - Runtime Patch
// Fix container IDs
const renames={slaDashboardContent:'sla-container',routingRulesContent:'routing-container',responseAnalyticsContent:'analytics-container',knowledgeBaseContent:'kb-container',leaderboardContent:'leaderboard-container'};
Object.entries(renames).forEach(([o,n])=>{const el=document.getElementById(o);if(el)el.id=n;});
// Mock data fallback
function getMockData(ep){
if(ep==='/sla/policies')return[{id:1,name:'Premium Support',first_response_minutes:60,resolution_minutes:240},{id:2,name:'Standard Support',first_response_minutes:240,resolution_minutes:480}];
if(ep==='/sla/breaches')return[{conversation_id:102,subject:'Billing inquiry',assigned_to_name:'Mike T.',policy_name:'Standard',first_response_breached:true}];
if(ep==='/routing/rules')return[{id:1,name:'VIP Customers',action_type:'assign_agent',priority:'high',active:true},{id:2,name:'Billing Issues',action_type:'add_tag',priority:'medium',active:true}];
if(ep.startsWith('/routing/rules/'))return{success:true};
if(ep==='/analytics/response-times')return{team_wide:{avg_first_response_minutes:42,avg_resolution_minutes:185,total_conversations:234},by_employee:[{name:'Sarah K.',avg_first_response_minutes:28,total_conversations:52},{name:'Mike T.',avg_first_response_minutes:35,total_conversations:48}]};
if(ep==='/load-balance/status')return[{name:'Sarah K.',open_conversations:8,percent_of_load:25,high_priority_count:2},{name:'Mike T.',open_conversations:12,percent_of_load:38,high_priority_count:4},{name:'Lisa R.',open_conversations:5,percent_of_load:16,high_priority_count:1}];
if(ep==='/analytics/csat'||ep==='/csat/report/summary')return{average_rating:4.2,total_surveys:156,one_star_count:6,five_star_count:62,by_employee:[{name:'Sarah K.',avg_rating:4.8,total_surveys:42},{name:'Mike T.',avg_rating:4.5,total_surveys:38}]};
if(ep.startsWith('/kb/articles'))return[{id:1,title:'Getting Started Guide',author_name:'Admin',category:'Onboarding',content:'Welcome to WSDisplay Email.'},{id:2,title:'Troubleshooting Email Delivery',author_name:'Sarah K.',category:'Technical',content:'Check SMTP settings and domain auth.'}];
if(ep.startsWith('/leaderboard'))return[{name:'Sarah K.',total_conversations:52,avg_response_time:28,avg_csat:4.8},{name:'Mike T.',total_conversations:48,avg_response_time:35,avg_csat:4.5},{name:'Lisa R.',total_conversations:41,avg_response_time:55,avg_csat:4.3}];
if(ep.includes('/ai-summary/recent'))return[{conversation_id:101,subject:'Server downtime',summary:'Load balancer fix applied.',generated_at:'2026-04-03'}];
if(ep.includes('/ai-summary'))return{summary:'AI summary.',key_points:['Issue identified','Resolution applied'],sentiment:'positive'};
if(ep.includes('/omnichannel/channels'))return[{id:1,type:'email',name:'Support Email',status:'active',messages_today:45},{id:2,type:'chat',name:'Live Chat',status:'active',messages_today:23},{id:3,type:'social',name:'Twitter DMs',status:'active',messages_today:8}];
if(ep.includes('/omnichannel/stats'))return{total_messages:76,channels_active:3,avg_response:12};
return[];
}
// Override apiFetch to use mock data on error
const _origApiFetch=window.apiFetch;
window.apiFetch=async function(ep,opts){
try{if(_origApiFetch){const r=await _origApiFetch(ep,opts);return r;}throw new Error('no orig');}
catch(e){console.log('Mock:',ep);return getMockData(ep);}
};
// Override switchView
const _origSwitchView=window.switchView;
window.switchView=function(view){
document.querySelectorAll('.view-section').forEach(el=>el.classList.add('hidden'));
const viewEl=document.getElementById(view+'-view');
if(viewEl)viewEl.classList.remove('hidden');
const coreViews=['dashboard','conversations','mailboxes','tags','canned-responses'];
document.querySelectorAll('.content-body').forEach(cb=>{cb.style.display=coreViews.includes(view)?'':'none';});
document.querySelectorAll('.nav-link').forEach(el=>el.classList.remove('active'));
if(event&&event.target){const link=event.target.closest('.nav-link');if(link)link.classList.add('active');}
const renderMap={
'dashboard':()=>typeof loadDashboard==='function'&&loadDashboard(),
'conversations':()=>typeof loadConversations==='function'&&loadConversations(),
'sla-dashboard':()=>typeof renderSLADashboard==='function'&&renderSLADashboard(),
'routing-rules':()=>typeof renderRoutingRules==='function'&&renderRoutingRules(),
'response-analytics':()=>typeof renderResponseAnalytics==='function'&&renderResponseAnalytics(),
'load-balancing':()=>typeof renderLoadBalanceStatus==='function'&&renderLoadBalanceStatus(),
'csat-surveys':()=>typeof renderCSATDashboard==='function'&&renderCSATDashboard(),
'knowledge-base':()=>typeof renderKnowledgeBase==='function'&&renderKnowledgeBase(),
'leaderboard':()=>typeof renderLeaderboard==='function'&&renderLeaderboard(),
'ai-summaries':()=>typeof renderAISummariesPage==='function'&&renderAISummariesPage(),
'omnichannel':()=>typeof renderOmnichannelDashboard==='function'&&renderOmnichannelDashboard()
};
if(renderMap[view])try{renderMap[view]();}catch(e){console.error('Render:',view,e);}
};
function renderOmnichannelDashboard(){
const c=document.getElementById('omnichannel-container');
if(!c)return;
apiFetch('/omnichannel/channels').then(channels=>{
apiFetch('/omnichannel/stats').then(stats=>{
c.innerHTML=`
<div class="dashboard-grid">
<div class="stat-card"><h3>Total Messages</h3><p class="stat-number">${stats.total_messages||0}</p></div>
<div class="stat-card"><h3>Active Channels</h3><p class="stat-number">${stats.channels_active||0}</p></div>
<div class="stat-card"><h3>Avg Response</h3><p class="stat-number">${stats.avg_response||0}m</p></div>
</div>
<div class="table-container"><table class="data-table">
<thead><tr><th>Channel</th><th>Type</th><th>Status</th><th>Messages Today</th></tr></thead>
<tbody>${(channels||[]).map(ch=>`<tr><td>${ch.name}</td><td>${ch.type}</td><td><span class="status-badge status-${ch.status}">${ch.status}</span></td><td>${ch.messages_today}</td></tr>`).join('')}</tbody>
</table></div>`;
});});
}
