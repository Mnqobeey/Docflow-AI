# DocFlow AI
### Invoice and Credit Note Management System for PCG | MindRift

DocFlow AI is a published-demo-ready document management prototype with secure login, role-based access, invoice/credit-note upload, extraction fallback logic, duplicate detection, exactly three approval stages, Supabase persistence, reporting, exports, and report insights.

## What Is Implemented

- Secure JWT login with seeded demo users stored in Supabase.
- Role-based access for admin, reviewer, manager, finance/admin, and viewer.
- Dedicated upload page for PDF, JPG, JPEG, and PNG invoices or credit notes.
- OCR/rule-based extraction baseline with editable fields: vendor, date, amount, VAT, invoice number, and document type.
- Optional Gemini free-tier cleanup if `GEMINI_API_KEY` is configured.
- Optional OpenRouter backup cleanup if Gemini fails and `OPENROUTER_API_KEY` is configured.
- OCR/rule/manual fallback still works if no LLM key is configured.
- Duplicate checks by file hash, invoice number, and vendor + amount.
- Exactly three ordered approval stages: Reviewer, Manager, Finance/Admin.
- Approval history with stage, role, action, user, timestamp, and optional comment.
- Supabase-backed reports with date, vendor, status, amount, and document type filters.
- Report types for spend summary, vendor analysis, approval status, tax/VAT, and document list.
- Excel export through `xlsx` and PDF export through browser print/save as PDF.
- AI insights from real Supabase report data, with OpenRouter as backup and deterministic rule-based insights when no LLM key is available.

## Supabase Setup

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Paste and run [server/supabase/schema.sql](server/supabase/schema.sql).
4. Copy the project URL into `SUPABASE_URL`.
5. Copy the service role key into `SUPABASE_SERVICE_ROLE_KEY`.
6. Keep the service role key backend-only. Never put it in Netlify or frontend env vars.
7. Seed demo users:

```bash
cd server
cp .env.example .env
# fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm install
npm run seed:supabase
```

Optional seeded Supabase documents:

```bash
npm run seed:supabase -- --with-docs
```

## Demo Logins

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin123` | Admin, full access |
| `reviewer` | `review123` | Approval 1 |
| `manager` | `manager123` | Approval 2 |
| `finance` | `finance123` | Approval 3 / final approval |
| `viewer` | `viewer123` | Reports and insights only |

## Recruiter Test Guide

1. Log in as `admin`.
2. Open Upload and use a seeded demo document, or upload a PDF/JPG/PNG invoice or credit note.
3. Review and correct the extracted fields, then submit.
4. Log in as `reviewer` and approve Step 1.
5. Log in as `manager` and approve Step 2.
6. Log in as `finance` and approve Step 3.
7. Log in as `viewer` and open Reports.
8. Test filters for date range, vendor, status, amount, and document type.
9. Export the report to Excel and use the PDF button to print/save as PDF.
10. Open Insights and generate report insights.
11. Upload the duplicate Takealot demo after the original is active to confirm duplicate detection.

## Local Development

Backend:

```bash
cd server
cp .env.example .env
npm install
npm run seed:supabase
npm run dev
```

Frontend:

```bash
cd client
cp .env.example .env
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.
Backend runs on `http://localhost:3001`.
Vite proxies `/api` calls to the backend during local development.

## Environment Variables

Backend:

- `JWT_SECRET`: strong secret for signing login tokens.
- `FRONTEND_URL`: deployed frontend URL for CORS.
- `SUPABASE_URL`: required Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: required backend-only Supabase service role key.
- `GEMINI_API_KEY`: optional free-tier key from Google AI Studio. Enables AI cleanup and AI-written insights.
- `GEMINI_MODEL`: optional model override. Defaults to `gemini-3.5-flash`.
- `OPENROUTER_API_KEY`: optional secondary LLM fallback key.
- `OPENROUTER_MODEL`: optional model override. Defaults to `deepseek/deepseek-chat-v3.1`. Use an explicit content-returning model; avoid `openrouter/free` and `gpt-oss` models for extraction because they can return reasoning-only output. The `:free` variants can be unavailable or provider-limited, so treat them as best-effort demo options rather than reliable extraction infrastructure.
- `AI_PROVIDER_TIMEOUT_MS`: optional AI provider timeout. Defaults to `18000`.
- `SMOKE_REAL_AI`: local smoke-test switch. Defaults to off; set to `1` only when you want to spend real Gemini/OpenRouter quota.

OpenRouter free models have limited daily usage and can be unavailable or return reasoning-only output. The app still works with no Gemini or OpenRouter key.

Frontend:

- `VITE_API_URL`: deployed backend URL, for example `https://docflow-server.onrender.com`.

No secrets are stored in frontend code.

## Verification

With Supabase env vars configured:

```bash
cd server
npm run smoke:supabase
npm run smoke:ai
```

The Supabase smoke test confirms login, Supabase save/fetch, duplicate detection, reviewer approval, manager approval, finance final approval, reports, and no-Gemini insights fallback. The AI smoke test checks no-key fallback and fake-key fallback by default. Real Gemini/OpenRouter checks run only when `SMOKE_REAL_AI=1` is explicitly set.

PowerShell real-provider check:

```powershell
$env:SMOKE_REAL_AI="1"
npm run smoke:ai
```

## Deployment

See [DEPLOY.md](DEPLOY.md) for the free hosting path using Supabase, Render, and Netlify. Vercel can also host the frontend if `VITE_API_URL` points to the deployed backend.
