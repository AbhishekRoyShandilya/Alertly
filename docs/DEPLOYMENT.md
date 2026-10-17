# Deployment

## Free setup: Aiven MySQL + Render + Vercel (what the live demo uses)

```
Vercel (dashboard) ──/api/* rewrite──▶ Render free web service ──TLS──▶ Aiven free MySQL
                                       (API + worker + scheduler in one process)
```

Free plans change; check current limits. Known trade-off: a free Render service **sleeps after
~15 minutes without traffic**. The first request then takes up to a minute to wake it, and
alerts don't fire while it sleeps.

### Step 0: code on GitHub

Render and Vercel deploy from a GitHub repo, so push this repository first.

### Step 1: MySQL on Aiven

1. Sign up at aiven.io → **Create service** → **MySQL** → **Free plan** → pick a region close
   to your Render region.
2. When it's running, open the service **Overview** and copy:
   - **Service URI** → this is `DATABASE_URL`
     (`mysql://avnadmin:…@….aivencloud.com:PORT/defaultdb?ssl-mode=REQUIRED`)
   - **CA certificate** (download or show) → this is `DATABASE_CA_CERT`
   - The API strips `ssl-mode` from the URL and verifies the server with the CA certificate.

### Step 2: backend on Render

1. render.com → sign in with GitHub → **New** → **Blueprint** → select the `alertly` repo.
   Render reads [`render.yaml`](../render.yaml).
2. Fill in the prompted values:
   - `DATABASE_URL` and `DATABASE_CA_CERT` from step 1 (paste the whole PEM, including the
     BEGIN/END lines)
   - `WEB_ORIGIN`: your Vercel URL (you can fill it in after step 3 and redeploy)
   - optional `DEMO_WEBHOOK_URL`: open webhook.site and copy your unique URL, so the demo's
     alerts post somewhere visible
   - optional `RESEND_API_KEY` and `EMAIL_FROM` for real emails
3. Deploy. In the logs you should see `migration applied 001_init`, `002_queue_index`,
   `demo account checked`, then `API listening`.
4. Check `https://<your-service>.onrender.com/api/v1/ready` →
   `{"status":"ready","migration":"002_queue_index"}`, and that `/docs` shows Swagger UI.

### Step 3: dashboard on Vercel

1. vercel.com/new → import the `alertly` repo.
2. **Root Directory:** `apps/web` (Vercel detects Next.js and the npm workspace).
3. **Environment variables** (set them **before** the first build, because the rewrite target
   is fixed at build time):
   - `API_URL` = `https://<your-service>.onrender.com`
   - `NEXT_PUBLIC_API_DOCS_URL` = the same URL
4. Deploy, open the site, and log in with `demo@alertly.dev` / `demo-password-123`.
5. Put the Vercel URL into Render's `WEB_ORIGIN` if you haven't yet.

### Step 4: README

Replace `OWNER` and the live-demo placeholders at the top of `README.md` with your URLs.

---

## Scaling up: separate processes

Four pieces: **MySQL**, the **API image** (run three times: api, worker, scheduler), and the
**dashboard** (Vercel). Free and low-cost tiers change often, so check current limits when
you deploy.

```
Vercel (Next.js dashboard)  ──/api/* rewrite──▶  API service ──┐
                                                 worker      ──┼──▶ managed MySQL 8
                                                 scheduler   ──┘
```

## 1. MySQL

Create a managed MySQL 8 database (Railway, Aiven or similar) and note its connection URL:
`mysql://user:password@host:port/dbname`. If the provider requires TLS, follow its docs for the
connection string.

## 2. API, worker, scheduler (one image)

Any platform that runs a Dockerfile works (Railway, Render, Fly.io). Create **three services
from the same repo and Dockerfile** (`apps/api/Dockerfile`, build context = repo root) with
different start commands:

| Service   | Start command            | Notes                                                                              |
| --------- | ------------------------ | ---------------------------------------------------------------------------------- |
| api       | `node dist/server.js`    | Public HTTP, port 4000. Health check: `/api/v1/health`; readiness: `/api/v1/ready` |
| worker    | `node dist/worker.js`    | No public port. Can run more than one instance (SKIP LOCKED)                       |
| scheduler | `node dist/scheduler.js` | No public port. Run one (an advisory lock keeps extras idle)                       |

**Release step** (before the new version starts; most platforms call it "pre-deploy command"):

```
node dist/migrate.js && node dist/seed.js
```

**Environment variables** (all three services):

| Variable                        | Value                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      | `production`                                                                                                                                       |
| `DATABASE_URL`                  | from step 1                                                                                                                                        |
| `JWT_SECRET`                    | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`                                                                   |
| `ENCRYPTION_KEY`                | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Keep it safe: losing it makes stored webhook secrets unreadable** |
| `WEB_ORIGIN`                    | your Vercel URL, e.g. `https://alertly.vercel.app`                                                                                                 |
| `RESEND_API_KEY` + `EMAIL_FROM` | from Resend (verify a sender domain, or use their test sender)                                                                                     |
| `TELEGRAM_BOT_TOKEN`            | from @BotFather (optional)                                                                                                                         |
| `PRICE_PROVIDER_DEFAULT`        | `simulated` (works from any region)                                                                                                                |
| `DEMO_WEBHOOK_URL`              | optional: a request-inspector URL so reviewers see live webhook deliveries                                                                         |

Rotating `JWT_SECRET` logs everyone out. `WEBHOOK_ALLOW_PRIVATE` must stay unset in production
(the API refuses to start with it).

## 3. Dashboard on Vercel

- Import the repo, set **Root Directory** to `apps/web` (Vercel detects Next.js and the npm
  workspace).
- Environment variables:
  - `API_URL` = the public URL of the API service (e.g. `https://alertly-api.up.railway.app`)
  - `NEXT_PUBLIC_API_DOCS_URL` = the same URL (for the "Open Swagger UI" link)

The browser only talks to the Vercel domain. Next forwards `/api/*` to `API_URL`, so the
session cookie is first-party and no CORS setup is needed.

## 4. Telegram (optional)

1. Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`.
2. Each user sends any message to the bot, then finds their chat id (e.g. by messaging
   @userinfobot) and adds a Telegram channel with that id.
3. Press **Test** on the channel.

## 5. After deploying

- `GET https://<api>/api/v1/ready` → `{"status":"ready","migration":"002_queue_index"}`
- Log in to the dashboard with the demo account (`demo@alertly.dev` / `demo-password-123`, or your
  `DEMO_PASSWORD`). Within a few minutes the simulated BTC rule fires and deliveries appear.
- Put the live links at the top of the README.

## Known limits of this setup

- Rate limits are in memory per API instance; more than one API instance needs Redis.
- Behind the Vercel rewrite, the API sees Vercel's IP for every request, so the per-IP login
  limit becomes shared. Fixing it means trusting and reading the forwarded client IP header from
  the rewrite.
