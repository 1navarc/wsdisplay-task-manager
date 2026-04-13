# WSDisplay Email — Developer Setup Guide

## Step 1: Install Prerequisites

You need these installed on your computer:

- **Node.js** (v18 or newer) — https://nodejs.org/
- **Git** — https://git-scm.com/downloads
- **Google Cloud CLI** (for deploying) — https://cloud.google.com/sdk/docs/install

## Step 2: Get Access to the GitHub Repo

You'll need a GitHub account. Give your GitHub username to Craig so he can add you as a collaborator.

- Repo: https://github.com/1navarc/wsdisplay-task-manager
- Once invited, accept the invitation from your GitHub notifications

## Step 3: Clone the Repo

Open Terminal (Mac) or Command Prompt (Windows) and run:

```
git clone https://github.com/1navarc/wsdisplay-task-manager.git
cd wsdisplay-task-manager
git checkout claude/wsdisplay-email-dev-9ojDC
npm install
```

## Step 4: Set Up the Environment File

Create a file called `.env` in the root of the project folder. Craig will send you the contents of this file — it contains all the passwords and API keys needed.

The `.env` file should contain:

```
# Database (PostgreSQL on Cloud SQL)
DATABASE_URL=<Craig will provide>

# Google OAuth (for user login + Gmail)
GOOGLE_CLIENT_ID=<Craig will provide>
GOOGLE_CLIENT_SECRET=<Craig will provide>
GOOGLE_REDIRECT_URI=http://localhost:8080/api/auth/google/callback

# Gemini AI
GEMINI_API_KEY=<Craig will provide>

# Session
SESSION_SECRET=<Craig will provide>

# Port
PORT=8080
```

**IMPORTANT: Never commit the .env file to GitHub. It contains secrets.**

## Step 5: Run the App Locally

```
npm run dev
```

Then open http://localhost:8080 in your browser.

## Step 6: Make Changes

1. Create a new branch for your work: `git checkout -b your-name/feature-name`
2. Make your changes
3. Test locally at http://localhost:8080
4. Commit: `git add . && git commit -m "Description of what you changed"`
5. Push: `git push -u origin your-name/feature-name`
6. Let Craig know when it's ready to review

---

## Where to Find API Keys & Logins

| What | Where to find it |
|------|-----------------|
| Gemini API Key | https://aistudio.google.com/apikey |
| Google OAuth credentials | https://console.cloud.google.com/apis/credentials (project: wsdisplay-ai-apps) |
| Cloud SQL database | https://console.cloud.google.com/sql (project: wsdisplay-ai-apps) |
| Cloud Run deployment | https://console.cloud.google.com/run (project: wsdisplay-ai-apps) |
| GitHub repo | https://github.com/1navarc/wsdisplay-task-manager |

Craig controls access to the Google Cloud project. Ask him to add you if you need direct access.

---

## Project Structure (Quick Reference)

```
server/
  index.js            — App entry point
  routes/             — API endpoints (16 files)
  services/           — Business logic (AI, Gmail sync, SLA, etc.)
  middleware/auth.js   — Authentication
  config/database.js   — Database connection
  db/migrations/       — Database schema (17 migrations)

public/
  index.html           — Main frontend (single-page app)
  features.js          — Assignments, collision detection, canned responses
  manager.js           — Manager dashboard
```

---

## Deploying to Production

Only do this when Craig approves:

```
gcloud run deploy wsdisplay-email --source . --region us-central1 --project wsdisplay-ai-apps
```

Live URL: https://wsdisplay-email-345944651769.us-central1.run.app/
