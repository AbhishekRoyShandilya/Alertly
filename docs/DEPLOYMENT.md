# Deployment

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
