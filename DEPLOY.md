# DocFlow AI Deployment Guide
## Free hosting: Supabase + Render backend + Netlify frontend

This project is intentionally deployable without paid services. Supabase stores users, documents, approvals, extraction metadata, and report data so the published app does not lose data when Render restarts or redeploys. Gemini is the primary optional LLM, OpenRouter is a secondary optional fallback, and if both are missing or quota-limited, extraction and insights fall back to OCR/text rules.

## Step 1 - Create Supabase Database

1. Go to `https://supabase.com` and create a free project.
2. Open **SQL Editor**.
3. Paste and run `server/supabase/schema.sql`.
4. Open **Project Settings > API**.
5. Copy:
   - `SUPABASE_URL`: the project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the service role key

Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only. Do not add it to Netlify.

## Step 2 - Seed Demo Users

Locally, create `server/.env` from `server/.env.example`, fill the Supabase values, then run:

```bash
cd server
npm install
npm run seed:supabase
```

Optional demo documents:

```bash
npm run seed:supabase -- --with-docs
```

## Step 3 - Push To GitHub

Create two repos, or use one monorepo:

- `docflow-server`: upload the contents of `/server`
- `docflow-client`: upload the contents of `/client`

Do not commit `.env` files or API keys. The `.gitignore` files already exclude local env files.

## Step 4 - Deploy The Backend On Render

1. Go to `https://render.com` and sign up.
2. Click **New > Web Service**.
3. Connect the `docflow-server` GitHub repo.
4. Use these settings:
   - Environment: `Node`
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
5. Add environment variables:
   - `JWT_SECRET`: a long random secret
   - `FRONTEND_URL`: leave blank until the Netlify URL is ready
   - `SUPABASE_URL`: your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: your Supabase service role key
   - `GEMINI_API_KEY`: optional free-tier Google AI Studio key
   - `GEMINI_MODEL`: optional, defaults to `gemini-3.5-flash`
   - `OPENROUTER_API_KEY`: optional secondary LLM fallback key
   - `OPENROUTER_MODEL`: optional, defaults to `deepseek/deepseek-chat-v3.1`; use an explicit content-returning model and avoid `openrouter/free`/`gpt-oss` for extraction. Free variants can be unavailable or provider-limited.
   - `AI_PROVIDER_TIMEOUT_MS`: optional, defaults to `18000`
6. Click **Create Web Service**.
7. Copy the Render URL, for example `https://docflow-server.onrender.com`.

## Step 5 - Deploy The Frontend On Netlify

1. Go to `https://netlify.com` and sign up.
2. Click **Add new site > Import from Git**.
3. Connect the `docflow-client` GitHub repo.
4. Use these build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
5. Add this environment variable:
   - `VITE_API_URL`: your Render backend URL, for example `https://docflow-server.onrender.com`
6. Click **Deploy site**.
7. Copy the Netlify URL, for example `https://docflow-ai.netlify.app`.

## Step 6 - Link Frontend And Backend

Go back to Render, open the backend service, and set:

- `FRONTEND_URL`: your Netlify URL, for example `https://docflow-ai.netlify.app`

Save the environment variable. Render will redeploy automatically.

## Step 7 - Test End To End

Open the Netlify URL and use these seeded demo accounts:

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin123` | Full access |
| `reviewer` | `review123` | Step 1 approver |
| `manager` | `manager123` | Step 2 approver |
| `finance` | `finance123` | Step 3 final approver |
| `viewer` | `viewer123` | Reports and insights only |

Recommended workflow:

1. Log in as `admin`.
2. Upload a supported PDF/JPG/PNG document, or use a seeded demo document.
3. Review and correct the extracted fields.
4. Submit the document for approval.
5. Log in as `reviewer` and approve Step 1.
6. Log in as `manager` and approve Step 2.
7. Log in as `finance` and approve Step 3.
8. Log in as `viewer` and test Reports and Insights.
9. Export Reports to Excel and PDF.
10. Upload the duplicate demo document to confirm duplicate detection.

## Local Verification

After Supabase env vars are configured:

```bash
cd server
npm run smoke:supabase
npm run smoke:ai
```

The Supabase smoke test starts a temporary backend and verifies login, Supabase document save/fetch, duplicate detection, all three approval stages, reports, and no-Gemini insights fallback. The AI provider smoke test verifies no-key fallback and fake-key fallback by default. Real Gemini/OpenRouter checks run only when you explicitly set `SMOKE_REAL_AI=1`, because free-tier provider calls can be quota-limited.

PowerShell real-provider check:

```powershell
$env:SMOKE_REAL_AI="1"
npm run smoke:ai
```

## Architecture

```text
Browser (Netlify)
  |
  | /api requests to VITE_API_URL
  v
Express server (Render)
  |
  | JWT auth, workflow rules, duplicate detection
  | SUPABASE_SERVICE_ROLE_KEY stays server-side
  | optional GEMINI_API_KEY for primary free-tier AI cleanup
  | optional OPENROUTER_API_KEY for secondary fallback AI cleanup
  v
Supabase Postgres
  |
  | users, documents, approval_history
  v
Persistent reports and insights
```

The browser never receives backend secrets. Supabase service-role access, Gemini keys, and OpenRouter keys live only in Render environment variables. OpenRouter free models have limited daily usage and can be unavailable or return reasoning-only output, so use an explicit content-returning model for a reliable demo.
