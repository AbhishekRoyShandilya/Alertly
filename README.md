# Alertly

**Reliable notification delivery by email, webhook and Telegram, plus price alerts.**
Apps send notifications through a REST API, and users create alert rules like _"tell me when BTC
crosses 70,000"_. Alertly delivers every notification with retries and exponential backoff,
never creates duplicates, signs its webhooks, and records every delivery attempt in a dashboard.

[![CI](https://github.com/OWNER/alertly/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/alertly/actions/workflows/ci.yml)

> **Live demo:** _dashboard URL_ · **API docs:** _API URL/docs_
> Log in with the read-only demo account: `demo@alertly.dev` / `demo-password-123`

## Why I built it

My trading system's market-data websocket once died silently, and nothing noticed for an
hour. The rule I took from that: _the system must tell you when something is wrong, and that
alerting must itself be reliable._ Alertly rebuilds that idea as a standalone product:

- **reliable delivery**: at-least-once, with retries and a dead-letter state
- **no duplicates**: idempotency keys enforced by the database
- **a record of every attempt**: the full delivery timeline, visible and retryable

## Architecture

```
          ┌──────────── Next.js dashboard ────────────┐
          │  channels · alerts · notifications · logs │
          └─────────────────────┬─────────────────────┘
                                │ /api/* rewrite (same-origin, httpOnly cookie)
                                ▼
┌────────────── API (Express, stateless) ──────────────┐
│ auth · API keys · channels · notifications · alerts  │
│ Zod validation · rate limits · request ids · OpenAPI │
└──────────────────────────┬───────────────────────────┘
                           │ writes notification + deliveries in ONE transaction
                           ▼
┌─────────────────────────── MySQL 8 ──────────────────────────┐
│ notifications · deliveries (the queue) · delivery_attempts   │
│ alert_rules · price_snapshots · usage_daily · …               │
└──────▲────────────────────────────────────────▲──────────────┘
       │ SELECT … FOR UPDATE SKIP LOCKED         │ active rules, price snapshots
┌──────┴───────────────┐               ┌────────┴──────────────┐
│ Worker (1..N)        │               │ Scheduler (leader)    │
│ email · webhook ·    │               │ fetch prices, run the │
│ Telegram, retries,   │               │ alert state machine,  │
│ dead letter          │               │ create notifications  │
└──────────────────────┘               └───────────────────────┘
```

Three processes from one codebase and one Docker image. **The API never sends anything:** it
records the work, and workers deliver it. API responses stay fast, and every send can be
retried.

## Key design decisions

| Decision                                  | Why                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transactional outbox**                  | The notification and its delivery rows are written in one transaction, so nothing can be saved-but-never-sent.                                                                                                                                |
| **Idempotency via a UNIQUE index**        | `UNIQUE (user_id, idempotency_key)`. Retrying a request returns the original (200 + `Idempotent-Replayed`); reusing a key with a different body gives 409. A test fires 8 concurrent requests with one key and gets exactly one notification. |
| **Queue in MySQL with `SKIP LOCKED`**     | Workers claim disjoint batches without blocking each other, with no extra infrastructure. Claims happen in a short transaction; **sends happen outside it**.                                                                                  |
| **Retries: exponential backoff + jitter** | About 30 s → 2 min → 8 min → 32 min → 2 h, randomised so retries don't stampede. 4xx is permanent; 5xx/429/timeouts retry; `dead` after 6 attempts, with manual retry.                                                                        |
| **At-least-once, honestly**               | A crashed worker's rows are re-queued after 5 min. Receivers de-duplicate using `X-Alertly-Notification-Id`.                                                                                                                                  |
| **Signed webhooks**                       | `X-Alertly-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`, constant-time comparison, 5-minute replay window (as Stripe does).                                                                                                               |
| **SSRF protection**                       | Webhook URLs resolving to private, loopback or link-local addresses are refused, both at save time **and at connect time** (defeats DNS rebinding). Redirects are not followed.                                                               |
| **Alert state machine**                   | `armed → triggered → cooldown → armed`, re-arming only after the condition resets (hysteresis), plus a per-minute idempotency key, so no alert spam.                                                                                          |
| **Leader election**                       | The scheduler holds a MySQL advisory lock on a dedicated connection; a standby takes over if it dies.                                                                                                                                         |
| **One schema source**                     | Zod schemas in `packages/shared` validate the API, type the dashboard's forms and generate the OpenAPI docs.                                                                                                                                  |

## Tech stack and skills shown

| Area                         | Where it shows                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Node.js, TypeScript          | Entire backend and frontend, strict mode                                                                                     |
| Scalable server-side design  | Stateless API; separate worker and scheduler processes; DB-backed queue with row locking; horizontally scalable workers      |
| MySQL, data integrity        | Plain-SQL migrations, foreign keys, unique keys for idempotency, indexes chosen with `EXPLAIN`, transactions, advisory locks |
| API design and documentation | Versioned REST `/api/v1`, problem+json errors, cursor pagination, rate-limit headers, OpenAPI 3.1 at `/docs`                 |
| React / Next.js, Tailwind    | App Router dashboard, TanStack Query, React Hook Form, optimistic updates, live polling, dark mode, responsive               |
| Performance                  | Code splitting with `next/dynamic`, batched claims, bulk inserts, no N+1 queries, buffered writes, measured with a load test |
| Third-party APIs             | SMTP / Resend, Telegram Bot API, CoinGecko / Binance price APIs                                                              |
| Testing                      | 155 API tests (unit + integration against real MySQL and a mock webhook server) and React component tests                    |
| DevOps                       | Docker multi-stage builds, Docker Compose full stack, GitHub Actions CI with a MySQL service                                 |

**Stack:** Node.js 22 · TypeScript · Express 5 · MySQL 8 · Next.js 16 · Tailwind CSS 4 · Zod 4 ·
TanStack Query · Vitest · Supertest · Docker · GitHub Actions

## Run it locally

Requirements: Node.js 22+, Docker.

```bash
git clone https://github.com/OWNER/alertly.git && cd alertly
cp .env.example .env
docker compose up -d          # MySQL + Mailpit (fake SMTP with an inbox at http://localhost:8025)
npm install
npm run migrate
npm run seed                  # demo account + two simulated-price alert rules
npm run dev                   # API :4000, worker, scheduler, dashboard :3000
```

Open http://localhost:3000. Swagger UI is at http://localhost:4000/docs.

**Everything in containers instead:** `docker compose --profile app up --build`

## Send your first notification

Create an API key in the dashboard, then:

```bash
curl -X POST http://localhost:4000/api/v1/notifications \
  -H "Authorization: Bearer alr_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deploy-42" \
  -d '{"title":"Deploy finished","body":"v1.4.2 is live","data":{"version":"1.4.2"}}'
```

Send it again with the same `Idempotency-Key`: you get `200` and `Idempotent-Replayed: true`,
and nothing new is created.

### Verifying webhooks (receiver side)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyAlertly(secret, header, rawBody, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

```python
import hmac, hashlib, time

def verify_alertly(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(kv.split("=", 1) for kv in header.split(","))
    t = int(parts.get("t", 0))
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

Use `X-Alertly-Notification-Id` to ignore duplicates: delivery is at-least-once.

## Testing

```bash
docker compose up -d mysql
npm test
```

- **Unit:** backoff and retry classification, `decide()` (every branch), the alert state
  machine, webhook signatures, AES-GCM, SSRF ranges, cursor pagination.
- **Integration (real MySQL, a fresh database per test file):** auth and sessions, API keys,
  idempotency including concurrent races, the worker against a mock webhook server (200, 500→200,
  always-500 → dead → manual retry, 404, 429 + Retry-After, timeouts, crash recovery, **two
  parallel workers never deliver the same row twice**), alert firing and leader election.
- **Frontend:** the delivery timeline and the alert form (React Testing Library).

## Performance

Measured on a laptop (MySQL in Docker Desktop); details and method in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md):

- **Queue claim:** EXPLAIN showed a filesort that would make parallel workers lock the whole
  backlog. A reshaped index (migration 002) now gives a range scan with no sort.
- **Worker:** batched claims + concurrency 5: **81–116 deliveries/s vs 18–21** one at a time.
- **API:** `POST /notifications` **32 → 74–88 req/s** after removing a commit per request
  (buffered usage counters). The bottleneck (commit fsync) was confirmed experimentally before
  changing code.

## Project layout

```
apps/api        Express API, delivery worker, alert scheduler (one codebase, three entry points)
  migrations/   plain SQL migrations
  src/modules/  auth · api-keys · channels (+ senders) · notifications · deliveries · alerts · prices · usage
  test/         unit/ · integration/ · helpers/ (test DBs, mock webhook server)
apps/web        Next.js dashboard
packages/shared Zod schemas + types shared by API and dashboard
docs/           design, performance, deployment, debug log
```

## Scope

Not included on purpose: organisations and roles, billing, SMTP mailbox verification, multi-region.

**At larger scale I would:**

- run more worker processes (already safe)
- move the queue to Redis/BullMQ or SQS behind the same claim/persist boundary
- move rate limits to Redis
- batch the worker's result writes
- archive `delivery_attempts` monthly
- add metrics (Prometheus) and tracing

## More

- [Design document](docs/PROJECT_DESIGN.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Performance](docs/PERFORMANCE.md)
- [Debug log](docs/DEBUG_LOG.md): real bugs found while building, and how

---

Built with Claude Code as an AI pair programmer for design review, implementation and debugging. I
designed the system, reviewed every change, and can explain every file.
