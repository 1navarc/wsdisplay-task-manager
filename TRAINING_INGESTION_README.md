# Training Mailbox Ingestion — Phase 1 + 2

Built for: reading `info@sdsign.com` (or any "training" mailbox) and extracting
Q/A training examples + factual knowledge into the knowledge base.

## What was added

### Migration
- `server/db/migrations/018_training_ingestion.sql` — new tables:
  - `training_ingestion_runs` — one row per "Run Now" execution
  - `training_ingestion_log` — per-thread outcome (processed / skipped / error)
  - `knowledge_conflicts` — when a newly-extracted fact contradicts an existing KB entry
  - New columns on `ai_training_rules` and `knowledge_base_articles`:
    `source`, `source_ref`, `status`, `superseded_by`, `ingestion_run_id`
  - Default filter config row in `app_settings` (`training_ingestion_config`)

Migrations auto-apply at startup (see `server/index.js` `runMigrations`).

### Service
- `server/services/training-ingestion.js` — full worker:
  - Reads filter config from `app_settings`
  - Builds Gmail query (`after:`, `in:sent`, subject exclusions)
  - Lists threads paginated up to `max_threads_per_run`
  - Filters each thread (min length, whitelisted rep, excluded domain,
    subject/body keyword rules, reply length)
  - Calls Gemini 2.5 Flash to extract `qa[]` + `facts[]` from each thread
  - Writes Q/A pairs as `ai_training_rules` rows with `source='email_ingest'`
  - Writes facts as `knowledge_base_articles` rows
  - Detects conflicts: if existing KB fact for the same product+field differs,
    inserts a row in `knowledge_conflicts` for human review
  - ERP precedence stub: if an existing KB row has `source='erp'`, the new
    email-sourced fact is inserted as `status='superseded'` (not active)
  - Tracks cost per thread using Gemini Flash pricing
    ($0.075/M in, $0.30/M out)
  - Supports mid-run cancel

### Routes (prefixed `/api/ai`)
Manager role required on all.
- `GET  /ingestion/config` — current filter settings
- `PUT  /ingestion/config` — save filter settings
- `POST /ingestion/runs` — start a run (body optional: `{ filterOverrides }`)
- `GET  /ingestion/runs?limit=20` — recent runs list
- `GET  /ingestion/runs/:id/status` — single run (polled by UI)
- `GET  /ingestion/runs/:id/log?limit=500` — per-thread log rows
- `POST /ingestion/runs/:id/cancel` — request cancel

### UI (Settings > AI Settings)
Two new pieces between "Per-Mailbox Settings" and "Training Rules & Examples":

1. **Training Mailbox Ingestion** card
   - "Filters" button — opens modal with all filter knobs
   - "Run Now" button — kicks off a run
   - Status card with progress bar, counts (processed / skipped / errors /
     Q/A / facts / conflicts / cost / elapsed), current status line, Cancel
   - Polls `/status` every 2s while a run is active

## Filter knobs
All stored in `app_settings.training_ingestion_config`:

| key | type | default | purpose |
|-----|------|---------|---------|
| `mailbox_email` | string | `info@sdsign.com` | which mailbox to read |
| `date_range_days` | int | 90 | how far back to look |
| `rep_whitelist` | string[] | `[]` | only accept threads where rep is in this list (blank = all) |
| `min_thread_messages` | int | 2 | skip single-message threads |
| `min_reply_chars` | int | 100 | skip "thanks!" replies |
| `excluded_domains` | string[] | `["wsdisplay.com","modco.com"]` | skip internal threads |
| `subject_include_keywords` | string[] | `[]` | subject must contain any (blank = no constraint) |
| `subject_exclude_keywords` | string[] | `["out of office","auto-reply","automatic reply"]` | skip these |
| `body_include_keywords` | string[] | `[]` | customer body must contain any |
| `body_exclude_keywords` | string[] | `[]` | skip if customer body contains any |
| `max_threads_per_run` | int | 500 | safety cap |
| `skip_ai_drafted` | bool | true | (Hook reserved; UI exposes, backend wiring requires `is_ai_generated` tagging in sent messages) |
| `closed_only` | bool | false | (Hook reserved; requires conversation join) |
| `thumbs_up_only` | bool | false | (Hook reserved; requires feedback join) |

## How to deploy

### 1. Pull these changes into the real repo
The edits landed in `/sessions/eloquent-pensive-curie/mnt/wsdisplay-email`
(the Cowork copy). Copy to the real working folder:

```bash
# from the Mac terminal:
WS=/Users/cravan/Downloads/wsdisplay-email
COWORK=~/Library/Application\ Support/Cowork/.../wsdisplay-email # actual cowork mount

# Easier — use git. From the cowork mount:
cd <cowork mount>/wsdisplay-email
git add server/db/migrations/018_training_ingestion.sql \
        server/services/training-ingestion.js \
        server/routes/ai.js \
        public/index.html \
        TRAINING_INGESTION_README.md
git status                 # review
git diff --stat HEAD       # review
git commit -m "feat: training mailbox ingestion (Phase 1+2)"
git push                   # to wsdisplayAI/wsdisplay-email
```

Then pull in the real folder:
```bash
cd /Users/cravan/Downloads/wsdisplay-email
git pull
```

### 2. Deploy to Cloud Run
Your existing deploy pipeline. The migration auto-applies on container
start-up, so no manual SQL step is needed.

### 3. Verify in DB
```sql
SELECT * FROM app_settings WHERE key = 'training_ingestion_config';
SELECT count(*) FROM training_ingestion_runs;
```

### 4. Test end-to-end
1. Open Settings > AI Settings (as a manager)
2. Scroll to "Training Mailbox Ingestion"
3. Click "Filters" — confirm `info@sdsign.com` shows
4. (Optional) Lower `max_threads_per_run` to 5 for a quick test
5. Click "Run Now"
6. Watch the status card update every 2s
7. When it finishes, check the Training Rules & Examples card — new
   entries with type=EXAMPLE should be visible

### 5. Direct API test (skip UI)
```bash
# get session cookie first by logging in via the UI, then:
curl -X POST https://YOUR_HOST/api/ai/ingestion/runs \
  -H 'Content-Type: application/json' \
  -H 'Cookie: connect.sid=...' \
  -d '{"filterOverrides":{"max_threads_per_run":5}}'
# returns { "run_id": "...uuid..." }

curl https://YOUR_HOST/api/ai/ingestion/runs/<run_id>/status \
  -H 'Cookie: connect.sid=...'
```

## What's NOT in Phase 1+2 (coming in later phases)

- **Phase 3**: Activity log + run history UI (data is captured in
  `training_ingestion_log` — just no UI yet)
- **Phase 4**: Review queue UI — extracted Q/A are written as `active`
  right now; a gate for manager approval before they go live can be
  toggled by changing `status` default to `pending_review` in writers
- **Phase 5**: Conflicts UI — `knowledge_conflicts` is populated but there
  is no Settings tab to review them yet

## Gotchas

- The mailbox `info@sdsign.com` MUST already have a valid `refresh_token`
  row in the `mailboxes` table (it does — you connected it in the UI).
- Gemini API key must be present in `GEMINI_API_KEY` env var (it is).
- The normal auto-sync still excludes `mailbox_type='training'`, so
  training mailboxes still don't pollute the inbox. Good.
- Cost: ~500 threads at ~$0.0005 each ≈ $0.25 per full run.
