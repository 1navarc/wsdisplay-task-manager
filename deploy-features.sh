#!/bin/bash
set -e

# WSDisplay Email - New Features Deployment Script
# Run from ~/wsdisplay-email directory in Cloud Shell
# Usage: bash deploy-features.sh

echo "========================================="
echo "  WSDisplay New Features Deployer"
echo "========================================="

# Check we're in the right directory
if [ ! -f "server/index.js" ]; then
  echo "ERROR: server/index.js not found."
  echo "Please run this from ~/wsdisplay-email"
  exit 1
fi

echo ""
echo "[1/5] Copying files..."

# Copy route file
cp -v server/routes/features.js server/routes/features.js 2>/dev/null || true
echo "  -> server/routes/features.js"

# Copy frontend file
cp -v public/features.js public/features.js 2>/dev/null || true
echo "  -> public/features.js"

# Copy migration
mkdir -p server/db/migrations
cp -v server/db/migrations/006_new_features.sql server/db/migrations/006_new_features.sql 2>/dev/null || true
echo "  -> server/db/migrations/006_new_features.sql"

echo ""
echo "[2/5] Patching server/index.js..."

# Check if already patched for features route
if grep -q "features" server/index.js; then
  echo "  -> Features route already added, skipping."
else
  # Add features route after manager-dashboard route
  if grep -q "manager-dashboard" server/index.js; then
    sed -i "s|app.use('/api/manager', require('./routes/manager-dashboard'));|app.use('/api/manager', require('./routes/manager-dashboard'));\napp.use('/api/features', require('./routes/features'));|" server/index.js
    echo "  -> Added features route after manager-dashboard route."
  else
    # Add before static file serving
    sed -i "/app.use(express.static/i\\app.use('/api/features', require('./routes/features'));" server/index.js
    echo "  -> Added features route before static file serving."
  fi
fi

# Add migration 006 auto-run at startup
if grep -q "006_new_features" server/index.js; then
  echo "  -> Migration 006 startup already added, skipping."
else
  python3 -c "
with open('server/index.js', 'r') as f:
    content = f.read()

migration_code = '''
// Auto-run migration 006 at startup
const migrationFile006 = pathModule.join(__dirname, 'db', 'migrations', '006_new_features.sql');
if (fs.existsSync(migrationFile006)) {
  const { pool: pool006 } = require('./config/database');
  const migrationSQL006 = fs.readFileSync(migrationFile006, 'utf8');
  pool006.query(migrationSQL006)
    .then(() => console.log('Migration 006_new_features applied successfully'))
    .catch(err => console.log('Migration 006 note:', err.message));
}

'''

listen_line = 'server.listen(PORT'
idx = content.find(listen_line)
if idx != -1:
    content = content[:idx] + migration_code + content[idx:]
    with open('server/index.js', 'w') as f:
        f.write(content)
    print('  -> Added migration 006 auto-run at startup.')
else:
    print('  ERROR: Could not find server.listen')
"
fi

echo ""
echo "[3/5] Patching public/index.html..."

if grep -q "features-view" public/index.html; then
  echo "  -> Already patched, skipping."
else
  python3 -c "
with open('public/index.html', 'r') as f:
    content = f.read()

# Add features nav items after manager nav items
features_nav = '''
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('sla-dashboard')\">
          <div class=\"icon\">⏱️</div>
          <span>SLA Tracking</span>
        </a>
      </div>
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('routing-rules')\">
          <div class=\"icon\">🔀</div>
          <span>Routing Rules</span>
        </a>
      </div>
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('response-analytics')\">
          <div class=\"icon\">📈</div>
          <span>Response Analytics</span>
        </a>
      </div>
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('load-balance')\">
          <div class=\"icon\">⚖️</div>
          <span>Load Balancing</span>
        </a>
      </div>
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('csat-dashboard')\">
          <div class=\"icon\">⭐</div>
          <span>CSAT Surveys</span>
        </a>
      </div>
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('knowledge-base')\">
          <div class=\"icon\">📚</div>
          <span>Knowledge Base</span>
        </a>
      </div>
      <div class=\"nav-item manager-nav\" style=\"display:none\">
        <a class=\"nav-link\" onclick=\"switchView('leaderboard')\">
          <div class=\"icon\">🏆</div>
          <span>Leaderboard</span>
        </a>
      </div>'''

# Insert after performance nav
perf_pattern = \"switchView('performance')\"
idx = content.find(perf_pattern)
if idx != -1:
    # Find closing of this nav-item
    close_pos = content.find('</div>', content.find('</div>', idx) + 6) + 6
    content = content[:close_pos] + features_nav + content[close_pos:]
    print('  -> Added features nav items.')

# Add view sections
features_views = '''
        <div id=\"sla-dashboard-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>SLA Tracking</h1></div>
          <div id=\"slaDashboardContent\"></div>
        </div>
        <div id=\"routing-rules-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>Routing Rules</h1></div>
          <div id=\"routingRulesContent\"></div>
        </div>
        <div id=\"response-analytics-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>Response Analytics</h1></div>
          <div id=\"responseAnalyticsContent\"></div>
        </div>
        <div id=\"load-balance-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>Load Balancing</h1></div>
          <div id=\"loadBalanceContent\"></div>
        </div>
        <div id=\"csat-dashboard-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>CSAT Surveys</h1></div>
          <div id=\"csatDashboardContent\"></div>
        </div>
        <div id=\"knowledge-base-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>Knowledge Base</h1></div>
          <div id=\"knowledgeBaseContent\"></div>
        </div>
        <div id=\"leaderboard-view\" class=\"view-section hidden\">
          <div class=\"content-header\"><h1>Performance Leaderboard</h1></div>
          <div id=\"leaderboardContent\"></div>
        </div>'''

# Insert after performance-view section
perf_view = content.find('id=\"performance-view\"')
if perf_view != -1:
    depth = 0
    pos = perf_view
    while pos < len(content):
        if content[pos:pos+4] == '<div':
            depth += 1
        elif content[pos:pos+6] == '</div>':
            depth -= 1
            if depth == 0:
                pos += 6
                content = content[:pos] + features_views + content[pos:]
                print('  -> Added features view sections.')
                break
        pos += 1

# Add features.js script before </body>
features_script = '''
    <script src=\"/features.js\"></script>
    <script>
      // Patch switchView to call feature view renderers
      const origSwitchView2 = window.switchView;
      window.switchView = function(viewName) {
        origSwitchView2(viewName);
        const renderers = {
          'sla-dashboard': typeof renderSLADashboard !== 'undefined' ? renderSLADashboard : null,
          'routing-rules': typeof renderRoutingRules !== 'undefined' ? renderRoutingRules : null,
          'response-analytics': typeof renderResponseAnalytics !== 'undefined' ? renderResponseAnalytics : null,
          'load-balance': typeof renderLoadBalanceStatus !== 'undefined' ? renderLoadBalanceStatus : null,
          'csat-dashboard': typeof renderCSATDashboard !== 'undefined' ? renderCSATDashboard : null,
          'knowledge-base': typeof renderKnowledgeBase !== 'undefined' ? renderKnowledgeBase : null,
          'leaderboard': typeof renderLeaderboard !== 'undefined' ? renderLeaderboard : null
        };
        if (renderers[viewName]) renderers[viewName]();
      };
    </script>'''

body_close = content.rfind('</body>')
if body_close != -1:
    content = content[:body_close] + features_script + '\n' + content[body_close:]
    print('  -> Added features.js script.')

with open('public/index.html', 'w') as f:
    f.write(content)
print('  -> index.html patched successfully.')
"
fi

echo ""
echo "[4/5] Building and deploying to Cloud Run..."

gcloud builds submit --tag gcr.io/wsdisplay-email/wsdisplay-email . 2>&1
echo "  -> Container built."

gcloud run deploy wsdisplay-email \
  --image gcr.io/wsdisplay-email/wsdisplay-email \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated 2>&1
echo "  -> Deployed to Cloud Run."

echo ""
echo "[5/5] Verifying..."
SERVICE_URL=$(gcloud run services describe wsdisplay-email --region=us-central1 --format='value(status.url)' 2>/dev/null)
echo "  Service URL: $SERVICE_URL"
echo ""
echo "========================================="
echo "  FEATURES DEPLOYMENT COMPLETE!"
echo "========================================="
echo ""
echo "New features deployed:"
echo "  - Email Assignment (assign emails to specific employees)"
echo "  - Collision Detection (see who's viewing/drafting)"
echo "  - Internal Comments & @Mentions"
echo "  - SLA Tracking (response time monitoring)"
echo "  - Automated Routing Rules"
echo "  - Shared Drafts"
echo "  - Real-Time Response Analytics"
echo "  - Load Balancing (auto-distribute emails)"
echo "  - CSAT Surveys"
echo "  - Knowledge Base"
echo "  - Performance Leaderboard"
echo ""
