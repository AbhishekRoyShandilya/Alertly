# Alertly: project design report

**What it is:** a notification and alert delivery service. Users create alerts, for example "tell me when BTC crosses 70,000". Other apps can also send notifications through its API. Alertly delivers every notification **reliably** by email, webhook or Telegram. It retries failures, never sends duplicates, signs webhooks, and shows a full delivery log in a dashboard.

**Why it exists (the story to tell).** PTIS, my trading system, has a Telegram alert system built after a live failure: on 2026-09-24 the market-data websocket died silently and nothing noticed for an hour. The rule became "the system tells you when something is wrong". Alertly rebuilds that idea as a standalone product in the JavaScript stack:
- reliable delivery
- no duplicates
- a record of every attempt

Delivery reliability is also the heart of any email or notification infrastructure.

**Stack:** Node.js 20 LTS (or newer), TypeScript, Express, MySQL 8, Next.js (App Router), Tailwind CSS, Zod, Vitest + Supertest, Docker Compose, GitHub Actions.

**Size target:** about 2–3 weeks part-time. Everything is small enough to explain end to end in an interview.

Name and branding are placeholders; rename freely.

---

## Contents

1. Goals, scope, and the JD mapping
2. Architecture
3. Key concepts (read before coding)
4. Repository layout
5. Database design (every table)
6. API design (every endpoint)
7. Module-by-module design (files, functions, responsibilities)
8. Worker and scheduler design
9. Frontend design (Next.js + Tailwind)
10. Security
11. Performance
12. Testing strategy
13. DevOps: local setup, CI, deployment
14. Build plan, week by week
15. Interview guide: talking points and likely questions
16. Stretch goals (only after the core is done)

---

## 1. Goals, scope, and the JD mapping

### 1.1 Goals
1. A user can sign up, add delivery channels (an email address, a webhook URL, a Telegram chat) and test each one.
2. A user can create **alert rules** on prices (above / below / crosses / % move) that trigger notifications.
3. Any app can send a notification through the **REST API** with an API key. Delivery is reliable:
   - **at-least-once** delivery with **idempotent** creation
   - **retries with exponential backoff**
   - a **dead-letter** state after the last attempt
4. Every delivery attempt is logged and visible in the dashboard. A failed delivery can be retried by hand.
5. The API is documented (OpenAPI / Swagger), tested (unit + integration) and **hosted live**.

### 1.2 Out of scope (say so in the README)
- Organisations, roles and billing.
- Mailbox (SMTP) verification of recipient addresses: slow, often blocked, and abuse-prone.
- Multi-region or high-availability deployment.
- A Redis queue. The queue lives in MySQL on purpose (see 3.3); swapping in Redis/BullMQ is a stretch goal.

### 1.3 JD mapping (put a version of this table in the README)

| JD requirement | Where Alertly shows it |
| --- | --- |
| Node.js, JavaScript, TypeScript | The whole backend and frontend are TypeScript |
| Scalable server-side architecture | API, worker and scheduler as separate processes; stateless API; DB-backed queue with row locking |
| MySQL, database design, data integrity | 11 tables, foreign keys, unique keys for idempotency, indexes for the queue and logs, transactions |
| API design and documentation | Versioned REST `/api/v1`, consistent errors, cursor pagination, OpenAPI at `/docs` |
| React/Next.js and Tailwind | Dashboard: channels, alerts, notifications, delivery timeline, API keys |
| Third-party APIs | SMTP / email provider, Telegram Bot API, crypto price API |
| Performance (lazy loading, code splitting) | Charts loaded with `next/dynamic`, batched queue claims, indexes, pooled connections |
| Unit and integration tests | Vitest + Supertest; a mock webhook server for failure cases |
| Git/GitHub, code reviews, docs | Small commits, PRs per feature, CI on every push, README and design docs |
| Debugging and troubleshooting | Request IDs in every log line, attempt logs with error text and duration |

---

## 2. Architecture

```
            ┌──────────────────────── Next.js dashboard (Vercel) ───────────────────────┐
            │ pages: login · dashboard · channels · alerts · notifications · deliveries │
            └───────────────┬───────────────────────────────────────────────────────────┘
                            │  /api/* (Next.js rewrite → same-origin cookies)
                            ▼
┌──────────────────── API server (Express, stateless) ─────────────────────┐
│ auth · api keys · channels · notifications · deliveries · alerts · usage │
│ validation (Zod) · rate limit · request id · errors · OpenAPI /docs      │
└───────┬──────────────────────────────────────────────────────────────────┘
        │ SQL (mysql2 pool)
        ▼
┌──────────────────────────── MySQL 8 ────────────────────────────┐
│ users · api_keys · channels · notifications · deliveries        │
│ delivery_attempts · alert_rules · alert_rule_channels           │
│ price_snapshots · alert_events · usage_daily · schema_migrations│
└───────▲─────────────────────────────────────▲───────────────────┘
        │ claim due deliveries                 │ read active rules, write notifications
        │ (SELECT … FOR UPDATE SKIP LOCKED)    │
┌───────┴──────────────┐              ┌────────┴─────────────────┐
│ Worker (Node)         │              │ Scheduler (Node)         │
│ email · webhook ·     │              │ fetch prices · evaluate  │
│ telegram senders,     │              │ rules · create alert     │
│ retries, dead letter  │              │ notifications            │
└───────┬──────────────┘              └────────┬─────────────────┘
        ▼                                      ▼
  SMTP provider · user webhooks · Telegram     Price API (crypto) / simulated feed
```

**The three processes share one codebase** (`apps/api`) and start from different entry files: `server.ts`, `worker.ts`, `scheduler.ts`.
- The API never sends anything itself. It writes rows; the worker delivers them.
- This keeps API responses fast and makes delivery retryable.

**The main flow:** a notification is created, fanned out to deliveries, then delivered.
1. A client calls `POST /api/v1/notifications` with an `Idempotency-Key` header.
2. In **one transaction**, the API inserts the `notifications` row and one `deliveries` row per target channel, with status `pending` and `next_attempt_at = now`. This is the **transactional outbox pattern**: the work to do is saved atomically with the data.
3. The worker claims due deliveries in batches, sends each one, records a `delivery_attempts` row, and sets the status:
   - `delivered` on success
   - `retrying` with a later `next_attempt_at` on a retryable failure
   - `failed` on a permanent failure
   - `dead` after the maximum number of attempts
4. The dashboard reads these rows to show a timeline per notification.

---

## 3. Key concepts (read before coding)

### 3.1 At-least-once delivery and idempotency
- Networks fail mid-request, so a sender can never be sure a message arrived. Systems therefore choose **at-least-once** delivery: retry until confirmed, and accept that a receiver may occasionally see a duplicate.
- **Duplicates are handled with IDs:**
  - Every notification has an `id`. Every webhook carries it in a header, so receivers can ignore a repeat.
  - Clients send an `Idempotency-Key` when creating a notification. If the same key arrives twice (for example, a client retried after a timeout), Alertly returns the **original** notification instead of creating a second one.
  - This is enforced by a **unique key** in MySQL `(user_id, idempotency_key)`, not by application code that checks first. A check-then-insert has a race condition; a unique index does not.

### 3.2 Retries with exponential backoff and jitter
- If delivery fails for a temporary reason (timeout, HTTP 5xx, 429), wait and retry. Each wait grows: about 30 s, 2 min, 8 min, 30 min, 2 h.
- **Jitter** (a random part of the delay) stops thousands of failed deliveries from retrying at the same second.
- A **permanent** failure (HTTP 400/401/403/404/410, an invalid email address) is not retried; it is marked `failed`.
- After the last attempt, the delivery becomes `dead`, a dead-letter state the user can inspect and retry by hand.

### 3.3 A job queue inside MySQL (why not Redis?)
- MySQL 8 supports `SELECT … FOR UPDATE SKIP LOCKED`. Several workers can claim different rows at the same time without blocking each other or taking the same row.
- That is enough for this scale, and it means one less service to run and host.
- **The trade-off to explain:** at very high volume, a dedicated queue (Redis/BullMQ, SQS, Kafka) is better. The `DeliveryQueue` interface keeps that swap small.

### 3.4 Signed webhooks
- Each webhook channel has a secret. Every request carries `X-Alertly-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
- The receiver recomputes the HMAC and compares it in **constant time**. It also rejects timestamps older than 5 minutes, which prevents replays.
- This is the same idea Stripe and GitHub use.

### 3.5 Alert rules as a small state machine
- A rule like "BTC above 70,000" should not fire every 15 seconds while BTC stays above 70,000.
- Each rule keeps a **state**: `armed` → condition met → `triggered` (notify once) → wait for the **cooldown** → re-arm only when the condition has **reset** (price back below the threshold). That reset requirement is called hysteresis.
- "Crosses above" fires only when the previous price was ≤ the threshold and the current price is > it.

### 3.6 SSRF protection
- A webhook URL is supplied by the user. Without checks, someone could point it at `http://169.254.169.254/` (the cloud metadata service) or `http://localhost:3306`, and the server would call internal systems for them. That is Server-Side Request Forgery.
- Alertly resolves the hostname and **refuses private, loopback and link-local addresses**. It also requires `https` in production.

---

## 4. Repository layout

npm workspaces monorepo:

```
alertly/
├── apps/
│   ├── api/                      # Express API + worker + scheduler (TypeScript)
│   │   ├── src/
│   │   │   ├── server.ts         # entry: HTTP server
│   │   │   ├── worker.ts         # entry: delivery worker
│   │   │   ├── scheduler.ts      # entry: price polling + alert evaluation
│   │   │   ├── app.ts            # builds the Express app (used by server + tests)
│   │   │   ├── config/env.ts
│   │   │   ├── db/               # pool, transactions, migrations, seed
│   │   │   ├── lib/              # errors, logger, crypto, time, net-guard, pagination
│   │   │   ├── middleware/       # auth, api-key, validate, rate-limit, request-id, errors
│   │   │   ├── modules/
│   │   │   │   ├── auth/         # register, login, logout, me
│   │   │   │   ├── api-keys/
│   │   │   │   ├── channels/     # CRUD + senders/ (email, webhook, telegram)
│   │   │   │   ├── notifications/
│   │   │   │   ├── deliveries/   # repo for the queue + retry policy
│   │   │   │   ├── alerts/       # rules + evaluator
│   │   │   │   ├── prices/       # providers + cache
│   │   │   │   └── usage/
│   │   │   └── docs/openapi.ts
│   │   ├── migrations/           # 001_init.sql, 002_….sql
│   │   └── test/                 # unit/ + integration/ + helpers/
│   └── web/                      # Next.js App Router + Tailwind
│       ├── app/                  # routes (see section 9)
│       ├── components/
│       └── lib/                  # api client, hooks, formatters
├── packages/
│   └── shared/                   # Zod schemas + TypeScript types used by api AND web
├── docker-compose.yml            # mysql (+ api, worker, scheduler, web for a full local run)
├── .github/workflows/ci.yml
└── docs/PROJECT_DESIGN.md        # this file
```

**Why a `shared` package?** Request and response schemas are written once in Zod. The API validates with them, the frontend types its forms and API calls from them, and OpenAPI is generated from them. One source of truth means no drift between frontend and backend.

---

## 5. Database design

**Conventions:**
- `id` is `BIGINT UNSIGNED AUTO_INCREMENT`; public IDs exposed in the API use a short prefixed form (`ntf_…`, `dlv_…`). See `lib/ids.ts`.
- Times are `DATETIME(3)` in **UTC**.
- `created_at` defaults to `CURRENT_TIMESTAMP(3)`.
- Every foreign key is indexed.
- Engine InnoDB, charset `utf8mb4`.

### 5.1 `users`
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| email | VARCHAR(255) UNIQUE NOT NULL | stored lower-cased |
| password_hash | VARCHAR(255) NOT NULL | argon2id (or bcrypt cost 12) |
| name | VARCHAR(100) NULL | |
| created_at | DATETIME(3) | |

### 5.2 `api_keys`
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED FK → users | INDEX |
| name | VARCHAR(100) | for example "production server" |
| key_prefix | CHAR(12) | first characters shown in the UI (`alr_3fA9xK2`) |
| key_hash | CHAR(64) UNIQUE | SHA-256 of the full key. Keys are random 32-byte strings, so a fast hash is safe; bcrypt is only needed for low-entropy passwords |
| last_used_at | DATETIME(3) NULL | updated at most once a minute (to avoid a write on every request) |
| revoked_at | DATETIME(3) NULL | revoked keys are kept for audit |
| created_at | DATETIME(3) | |

The full key is shown **once** at creation and never stored.

### 5.3 `channels`
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED FK | INDEX |
| type | ENUM('email','webhook','telegram') | |
| name | VARCHAR(100) | |
| config | JSON NOT NULL | email: `{ "to": "a@b.com" }`; webhook: `{ "url": "https://…" }`; telegram: `{ "chatId": "12345" }` |
| secret_enc | VARBINARY(512) NULL | webhook signing secret, encrypted with AES-256-GCM (see 10.3) |
| status | ENUM('active','disabled') DEFAULT 'active' | |
| verified_at | DATETIME(3) NULL | set after a successful test send |
| created_at / updated_at | DATETIME(3) | |

### 5.4 `notifications`
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED FK | |
| idempotency_key | VARCHAR(128) NULL | UNIQUE (user_id, idempotency_key) |
| request_hash | CHAR(64) NULL | SHA-256 of the request body: the same key with a different body gives 409 |
| source | ENUM('api','alert','test') | |
| title | VARCHAR(200) | |
| body | TEXT | |
| data | JSON NULL | arbitrary payload forwarded to webhooks |
| priority | ENUM('normal','high') DEFAULT 'normal' | high priority is claimed first |
| created_at | DATETIME(3) | INDEX (user_id, created_at) for listing |

### 5.5 `deliveries` (the queue)
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| notification_id | BIGINT UNSIGNED FK | INDEX |
| channel_id | BIGINT UNSIGNED FK | INDEX |
| status | ENUM('pending','sending','retrying','delivered','failed','dead') | |
| priority | TINYINT DEFAULT 0 | copied from the notification (1 = high) |
| attempt_count | INT DEFAULT 0 | |
| max_attempts | INT DEFAULT 6 | |
| next_attempt_at | DATETIME(3) NOT NULL | when the worker may try next |
| locked_by | VARCHAR(64) NULL | worker id holding the row |
| locked_at | DATETIME(3) NULL | used to recover rows from a crashed worker |
| last_error | VARCHAR(500) NULL | |
| delivered_at | DATETIME(3) NULL | |
| created_at / updated_at | DATETIME(3) | |

Indexes:
- **`idx_due (status, priority DESC, next_attempt_at)`**: the queue query uses it.
- `idx_stuck (status, locked_at)`: for crash recovery.
- `UNIQUE (notification_id, channel_id)`: one delivery per channel per notification.

### 5.6 `delivery_attempts` (the audit log)
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| delivery_id | BIGINT UNSIGNED FK | INDEX (delivery_id, attempt_no) |
| attempt_no | INT | |
| started_at / finished_at | DATETIME(3) | |
| duration_ms | INT | |
| outcome | ENUM('success','retryable_error','permanent_error') | |
| http_status | SMALLINT NULL | for webhooks |
| error | VARCHAR(500) NULL | truncated error text |

### 5.7 `alert_rules`
| Column | Type | Notes |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED FK | |
| name | VARCHAR(100) | |
| symbol | VARCHAR(20) | for example `BTCUSDT` |
| provider | ENUM('simulated','coingecko','binance') | |
| condition_type | ENUM('above','below','cross_above','cross_below','pct_move') | |
| threshold | DECIMAL(20,8) | a price, or a percentage for `pct_move` |
| window_minutes | INT NULL | for `pct_move` (for example 5% in 60 minutes) |
| cooldown_minutes | INT DEFAULT 60 | |
| state | ENUM('armed','triggered','cooldown') DEFAULT 'armed' | see 3.5 |
| last_price | DECIMAL(20,8) NULL | the previous evaluated price, needed for "crosses" |
| last_triggered_at | DATETIME(3) NULL | |
| is_active | BOOLEAN DEFAULT TRUE | INDEX (is_active, symbol) |
| created_at / updated_at | DATETIME(3) | |

### 5.8 `alert_rule_channels`
Join table `(rule_id, channel_id)` with a composite PK. Both are FKs with `ON DELETE CASCADE`.

### 5.9 `price_snapshots`
`(id, provider, symbol, price DECIMAL(20,8), observed_at DATETIME(3))`
- INDEX `(provider, symbol, observed_at DESC)`.
- Keep 7 days; the scheduler deletes older rows.
- Used for `pct_move` windows and the dashboard sparkline.

### 5.10 `alert_events`
`(id, rule_id, price, condition_type, threshold, triggered_at, notification_id)`
The history of every trigger, shown on the rule page.

### 5.11 `usage_daily`
`(user_id, day DATE, api_requests INT, notifications INT, deliveries INT)` with PK `(user_id, day)`.
- Incremented with `INSERT … ON DUPLICATE KEY UPDATE`.
- Used for the dashboard chart and a free-plan quota (for example 1,000 notifications a day).

### 5.12 `schema_migrations`
`(version VARCHAR(50) PK, applied_at)`, written by the migration runner.

**Plain SQL migrations, not an ORM.** The JD asks for MySQL and queries. Writing the SQL yourself (with `mysql2`) shows you understand indexes, transactions and locking. A thin repository layer keeps queries out of the route handlers.

---

## 6. API design

**Base path** `/api/v1`. JSON in and out.

**Two ways to authenticate:**
- **Dashboard session:** an httpOnly cookie holding a signed JWT, for the web app.
- **API key:** `Authorization: Bearer alr_…`, for other programs. Only the notification and read endpoints accept API keys.

**Errors** use one shape (inspired by RFC 7807 "problem details"):
```json
{ "type": "validation_error", "title": "Invalid request", "status": 422,
  "detail": "title: String must contain at least 1 character", "requestId": "req_8f3a…" }
```

**Pagination:** cursor-based. `?limit=20&cursor=<opaque>` returns `{ "data": [...], "nextCursor": "…" | null }`. A cursor encodes `(created_at, id)`, so pages stay stable when new rows arrive; offset pagination would skip or repeat rows.

**Rate-limit headers** on API-key requests: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. Over the limit returns 429 with `Retry-After`.

### 6.1 Auth
| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| POST | /auth/register | none | `{ email, password, name? }` | 201 `{ user }` + session cookie |
| POST | /auth/login | none | `{ email, password }` | 200 `{ user }` + cookie (401 on bad credentials, same message for both cases) |
| POST | /auth/logout | session | – | 204, cookie cleared |
| GET | /auth/me | session | – | 200 `{ user }` |

### 6.2 API keys
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | /api-keys | session | list: prefix, name, last used, revoked |
| POST | /api-keys | session | `{ name }` → 201 `{ id, name, key }`. The **full key is returned only here** |
| DELETE | /api-keys/:id | session | revoke (sets `revoked_at`) → 204 |

### 6.3 Channels
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | /channels | session or key | list |
| POST | /channels | session | `{ type, name, config }`. A webhook gets a generated `secret`, returned once |
| GET | /channels/:id | session or key | |
| PATCH | /channels/:id | session | rename, change config, enable or disable |
| DELETE | /channels/:id | session | 409 if active alert rules still use it |
| POST | /channels/:id/test | session | creates a `source='test'` notification to only this channel; returns the notification id so the UI can poll its delivery |
| POST | /channels/:id/rotate-secret | session | webhooks only; returns the new secret once |

### 6.4 Notifications
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | /notifications | session or key | `Idempotency-Key` header recommended. Body below. 201 on create; 200 + `Idempotent-Replayed: true` on a repeat; 409 if the key is reused with a different body |
| GET | /notifications | session or key | filters: `source`, `from`, `to`; cursor pagination |
| GET | /notifications/:id | session or key | includes its deliveries and their attempts (the timeline) |

Body of `POST /notifications`:
```json
{
  "title": "Disk almost full",
  "body": "server-3 at 92%",
  "data": { "host": "server-3", "pct": 92 },
  "channelIds": ["ch_12", "ch_15"],
  "priority": "high"
}
```
`channelIds` is optional. When omitted, the notification goes to all active channels.

### 6.5 Deliveries
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | /deliveries | session or key | filters: `status`, `channelId`, `from`, `to`; newest first |
| GET | /deliveries/:id | session or key | with attempts |
| POST | /deliveries/:id/retry | session | allowed for `failed` / `dead`: resets `attempt_count`, sets `retrying` and `next_attempt_at = now` |

### 6.6 Alert rules
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | /alerts | session | list with current state and last trigger |
| POST | /alerts | session | `{ name, symbol, provider, conditionType, threshold, windowMinutes?, cooldownMinutes, channelIds }` |
| GET | /alerts/:id | session | includes recent `alert_events` |
| PATCH | /alerts/:id | session | edit, or pause/resume (`isActive`) |
| DELETE | /alerts/:id | session | |
| POST | /alerts/:id/evaluate | session | dry run: "would this fire at the current price?" Returns the evaluation without notifying |

### 6.7 Prices, usage, health
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | /prices/:symbol?provider= | session | latest price + last 24 h of snapshots (for the sparkline) |
| GET | /usage?days=30 | session | rows from `usage_daily` |
| GET | /health | none | liveness: the process is up |
| GET | /ready | none | readiness: DB reachable, migrations applied |
| GET | /docs | none | Swagger UI generated from the Zod schemas |

### 6.8 Outgoing webhook format (document it for receivers)
```
POST <channel url>
Content-Type: application/json
X-Alertly-Notification-Id: ntf_7Kp2…      ← use this to ignore duplicates
X-Alertly-Delivery-Attempt: 2
X-Alertly-Signature: t=1760612345,v1=5f2b…
User-Agent: Alertly-Webhooks/1.0

{ "id": "ntf_7Kp2…", "title": "...", "body": "...", "data": {...}, "createdAt": "2026-10-16T09:31:02.114Z" }
```
- A 2xx response within 10 seconds counts as delivered.
- Ship a tiny **verification snippet** in the README (Node and Python) so receivers can check signatures.

---

## 7. Module-by-module design

Each feature module has the same layers:
- **`routes.ts`** (HTTP only): parse, validate and call the service.
- **`service.ts`** (business rules, transactions).
- **`repo.ts`** (SQL only).
- **`schemas.ts`** (re-exported from `packages/shared`).

Route handlers never contain SQL, and repositories never know about HTTP. That separation is easy to test and easy to explain.

### 7.1 `config/env.ts`
- **`loadEnv(): Env`**: parses `process.env` with a Zod schema and **fails fast at startup** if something is missing. Keys:
  - `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` (32 bytes, base64)
  - `SMTP_*` or `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`
  - `PRICE_PROVIDER_DEFAULT`, `WEB_ORIGIN`, `NODE_ENV`
  - `WORKER_CONCURRENCY`, `SCHEDULER_INTERVAL_SEC`
- Export a typed `env` object. Nothing else reads `process.env` directly.

### 7.2 `db/`
- **`pool.ts`: `createPool(url)`** returns a `mysql2/promise` pool with `connectionLimit` from env, `timezone: 'Z'` and `dateStrings: false`.
  - `query<T>(sql, params)`: small typed helper.
  - **Always use `?` placeholders.** Never build SQL by string concatenation (SQL injection).
- **`tx.ts`: `withTransaction<T>(fn: (conn) => Promise<T>): Promise<T>`** gets a connection, runs `BEGIN`, calls `fn(conn)`, then `COMMIT` or, on any error, `ROLLBACK` and rethrow. Always releases the connection. Every multi-row write uses this.
- **`migrate.ts`: `runMigrations()`** reads `migrations/*.sql` in name order, skips versions already in `schema_migrations`, and runs each new file in a transaction. CLI: `npm run migrate`.
- **`seed.ts`: `seedDemo()`** creates a demo user, channels and two alert rules, used by the live demo and tests.

### 7.3 `lib/`
- **`errors.ts`**
  - `class AppError extends Error { status; type; detail }`, with helpers `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `tooManyRequests(retryAfterSec)`.
  - `toProblem(err, requestId)`: maps any error to the problem JSON. Unknown errors become 500 with **no internal detail leaked**.
- **`logger.ts`**: a `pino` logger. In dev, pretty print; in prod, JSON lines. `childLogger({ requestId, userId })`.
- **`crypto.ts`**
  - `generateApiKey(): { key, prefix, hash }`: `alr_` plus 32 random bytes in base62; the hash is SHA-256 hex.
  - `hashApiKey(key)`.
  - `hashPassword(pw)` / `verifyPassword(pw, hash)`: argon2id.
  - `encrypt(plain): Buffer` / `decrypt(buf): string`: AES-256-GCM with a random 12-byte IV, stored as `iv | tag | ciphertext`.
  - `signWebhook(secret, timestamp, rawBody): string`: HMAC-SHA256 hex.
  - `verifyWebhook(secret, header, rawBody, toleranceSec=300): boolean`: uses `crypto.timingSafeEqual`.
  - `sha256(str)`.
- **`ids.ts`: `encodeId(prefix, n)` / `decodeId(str)`**: public IDs like `ntf_8Gk2`. Internal numeric IDs are never exposed, so they can't be enumerated.
- **`net-guard.ts`: `assertPublicHttpUrl(url): Promise<void>`**
  - parses the URL; requires `https` (unless dev)
  - resolves DNS (`dns.promises.lookup` with `all: true`)
  - rejects private / loopback / link-local / multicast IPv4 and IPv6 ranges
  - **checks again at send time**, because DNS can change after saving (DNS rebinding)
- **`backoff.ts`**
  - **`nextDelayMs(attempt, opts={ baseMs: 30_000, factor: 4, maxMs: 2h })`**: `min(maxMs, base * factor^(attempt-1))` scaled by a random 50–100% (jitter). A pure function: unit-test it.
  - `isRetryable(result)`: retry network errors, timeouts, 408, 429 and 5xx; not other 4xx.
- **`pagination.ts`: `encodeCursor({ createdAt, id })` / `decodeCursor(str)`**, using base64url JSON; `pageQuery(limit, cursor)` builds the `WHERE (created_at, id) < (?, ?)` clause.
- **`time.ts`: `now()`**, injectable so tests can freeze time.

### 7.4 `middleware/`
- **`requestId.ts`**: reads `X-Request-Id` or creates one, sets it on `res`, and attaches a child logger to `req.log`.
- **`auth.ts`**
  - `requireSession`: reads the cookie, verifies the JWT (`jose` library), loads the user and sets `req.user`. 401 otherwise.
  - `requireSessionOrApiKey`: tries the session first, then `Authorization: Bearer`. For keys it hashes the key, finds an active key, sets `req.user` and `req.apiKey`, and throttles the `last_used_at` update.
- **`validate.ts`: `validate({ body?, query?, params? })`**: runs Zod schemas and replaces `req.body` and others with the parsed, typed values. Failures become 422 with field messages.
- **`rateLimit.ts`: `rateLimit({ windowSec: 60, max: 60, keyFn })`**: a sliding-window counter per API key in memory (Map of timestamps). Sets the RateLimit headers.
  - Explain in the README: this works for one instance. Multiple instances need a shared store (Redis), which is a stretch goal.
- **`errorHandler.ts`**: the final handler. Logs the error with the request id and sends `toProblem(...)`.

### 7.5 `modules/auth`
- **`service.register({ email, password, name })`**: normalises the email, checks the password policy (≥ 10 characters), hashes and inserts (a duplicate email gives 409), then returns the user.
- **`service.login({ email, password })`**: finds the user and verifies the password. A wrong email and a wrong password give the **same** 401, so attackers can't discover which emails exist. Returns the user plus a signed JWT (`sub`, `exp` 7 days).
- **`routes`**: set the cookie with `httpOnly`, `secure` (prod), `sameSite: 'lax'`, `path: '/'`.
- **`repo`**: `findUserByEmail`, `insertUser`, `findUserById`.

### 7.6 `modules/api-keys`
- **`service.create(userId, name)`**: `generateApiKey()`, insert prefix + hash, return the full key once.
- **`service.list(userId)`**, **`service.revoke(userId, id)`**: revoking checks ownership (404 if not the user's key, never 403, so other users' IDs stay hidden).
- **`repo.findActiveByHash(hash)`**: used by the auth middleware; served by the UNIQUE index on `key_hash`.

### 7.7 `modules/channels`
- **`service.create(userId, input)`**
  - validates the config per type (a discriminated union in Zod)
  - for a webhook: `await assertPublicHttpUrl(url)`, then generates a secret (32 random bytes) and stores it encrypted
  - returns the channel plus the plain secret **once**
- **`service.update / remove / list / get`**: ownership checks everywhere. `remove` refuses (409) while active alert rules reference the channel.
- **`service.sendTest(userId, channelId)`**: calls `notifications.service.create(... source='test', channelIds=[id])`.
- **`service.rotateSecret(userId, id)`**.
- **`senders/`**: one file per channel type, all implementing:
  ```ts
  interface ChannelSender {
    type: 'email' | 'webhook' | 'telegram';
    send(input: { notification: NotificationRow; channel: ChannelRow; attemptNo: number }): Promise<SendResult>;
  }
  type SendResult =
    | { ok: true; httpStatus?: number; durationMs: number }
    | { ok: false; retryable: boolean; httpStatus?: number; error: string; retryAfterSec?: number; durationMs: number };
  ```
  - **`emailSender.ts`**: Nodemailer over SMTP, or the Resend API. Builds a plain-text + simple HTML message. A provider 4xx (bad address) is permanent; a timeout or 5xx is retryable.
  - **`webhookSender.ts`**: re-checks `assertPublicHttpUrl`, serialises the body **once** (the exact bytes are signed and sent), adds the headers from 6.8, and posts with `fetch` and an `AbortController` 10-second timeout. Maps the status with `isRetryable`; on 429 it reads `Retry-After`.
  - **`telegramSender.ts`**: `POST https://api.telegram.org/bot<token>/sendMessage` with `chat_id` and text. Telegram's 429 includes `parameters.retry_after`; use it.
  - **`index.ts`: `getSender(type)`**: a registry, so the worker never uses `switch`.

### 7.8 `modules/notifications`
**`service.create(userId, input, { idempotencyKey, source })`**, the most important function in the project:
1. `requestHash = sha256(stableStringify(input))`.
2. Resolve target channels: `input.channelIds` (verify each belongs to the user and is active), or all active channels. Zero channels gives 422.
3. Check the daily quota (`usage_daily`). Over the limit gives 429.
4. `withTransaction(conn => …)`:
   - `INSERT INTO notifications (...)`. On `ER_DUP_ENTRY` for `(user_id, idempotency_key)`, roll back, load the existing row, and compare `request_hash`:
     - same body: return `{ notification: existing, replayed: true }`
     - different body: throw `conflict('Idempotency-Key reused with a different request')`
   - Bulk `INSERT INTO deliveries (notification_id, channel_id, status, priority, next_attempt_at) VALUES ...` (status `pending`, `next_attempt_at = NOW(3)`).
   - Increment `usage_daily`.
5. Return `{ notification, replayed: false }`.

**Also:**
- **`service.list(userId, filters, page)`**, **`service.getWithTimeline(userId, id)`**: the timeline query joins deliveries and attempts. Use **two queries** (deliveries, then attempts `WHERE delivery_id IN (...)`), never one query per delivery (the N+1 problem).
- **`repo`**: `insertNotification`, `findByIdempotencyKey`, `insertDeliveries`, `listNotifications`, `getNotification`, `listDeliveriesForNotification`, `listAttemptsForDeliveries`.

### 7.9 `modules/deliveries` (the queue)
- **`repo.claimDue(conn, workerId, batchSize)`**: inside a transaction:
  ```sql
  SELECT id FROM deliveries
   WHERE status IN ('pending','retrying') AND next_attempt_at <= NOW(3)
   ORDER BY priority DESC, next_attempt_at
   LIMIT ?
   FOR UPDATE SKIP LOCKED;
  UPDATE deliveries SET status='sending', locked_by=?, locked_at=NOW(3), attempt_count=attempt_count+1
   WHERE id IN (?);
  ```
  It then loads the claimed rows with their notification and channel (one join query).
- **`repo.markDelivered(id, attempt)`**: status `delivered`, `delivered_at`, clears the lock. Then insert the attempt row.
- **`repo.markRetry(id, attempt, nextAt, error)`**: status `retrying`, `next_attempt_at = nextAt`, `last_error`, clears the lock. Insert the attempt.
- **`repo.markFailed(id, attempt, error)`**: permanent failure.
- **`repo.markDead(id, attempt, error)`**: the last attempt was used up.
- **`repo.recoverStuck(olderThanSec=300)`**: rows still `sending` with an old `locked_at` (a worker crashed mid-send) go back to `retrying`.
- **`service.decide(delivery, result): Decision`**: a pure function that turns a `SendResult` plus `attempt_count` / `max_attempts` into one of `delivered | retry(nextAt) | failed | dead`. Unit-test it thoroughly.
- **`service.retryManually(userId, id)`**: only from `failed` / `dead`. Resets `attempt_count` to 0.
- **`service.list / get`** for the API.

### 7.10 `modules/prices`
- **`interface PriceProvider { name; getPrices(symbols: string[]): Promise<Record<string, number>> }`**
- **`simulatedProvider.ts`**: a seeded random walk per symbol (same seed, same series), so demos and **tests are deterministic**. Supports `setPrice(symbol, value)` in tests to force a cross.
- **`coingeckoProvider.ts`** (or `binanceProvider.ts`): public price endpoints, with no key needed for basic use. Respect its rate limit, map symbols, timeout 5 s, retry once.
  - **Check which one is reachable from your hosting region before relying on it.** Keep `simulated` as the default for the live demo.
- **`priceService.ts`**
  - `getLatest(provider, symbols)`: caches for 10 s in memory and writes `price_snapshots`.
  - `getHistory(provider, symbol, sinceMinutes)`.
  - `pruneOld(days=7)`.

### 7.11 `modules/alerts`
- **`evaluator.ts`**, pure and the second most important piece to unit-test:
  ```ts
  evaluate(rule: RuleState, price: number, now: Date, history?: Snapshot[]):
    { fire: boolean; nextState: 'armed'|'triggered'|'cooldown'; reason?: string }
  ```
  - `above`: fire when armed and `price > threshold`; re-arm when `price <= threshold` and the cooldown has passed.
  - `below`: the mirror image.
  - `cross_above`: fire when `last_price <= threshold < price` (needs `last_price`; the first evaluation only records the price).
  - `cross_below`: the mirror image.
  - `pct_move`: find the price `window_minutes` ago in history; fire when `|price/old - 1| * 100 >= threshold`.
  - **Cooldown:** after firing, state `cooldown` until `last_triggered_at + cooldown_minutes`, then `armed` again only if the condition is no longer true (hysteresis, section 3.5).
- **`service.create / update / remove / list / get`**: validate the threshold by type (positive price; % between 0.1 and 100) and that the channels belong to the user. Writes `alert_rules` plus `alert_rule_channels` in one transaction.
- **`service.dryRun(userId, id)`**: gets the current price and returns `evaluate(...)` **without** saving or notifying.
- **`service.applyEvaluation(rule, result, price)`**: called by the scheduler. Updates `state`, `last_price`, `last_triggered_at`.
  - When `fire`: inserts an `alert_events` row and calls `notifications.service.create(rule.user_id, {title, body, data, channelIds}, { source: 'alert', idempotencyKey: 'alert:' + rule.id + ':' + minuteBucket(now) })`.
  - The idempotency key means a scheduler restart in the same minute can **never** double-notify.

### 7.12 `modules/usage`
- **`service.increment(conn, userId, field, by=1)`**: `INSERT … ON DUPLICATE KEY UPDATE field = field + ?`.
- **`service.get(userId, days)`**.

### 7.13 `docs/openapi.ts`
Registers every Zod schema and route with `@asteasolutions/zod-to-openapi`, generates the OpenAPI 3 document, and serves it with `swagger-ui-express` at `/docs`, plus raw JSON at `/docs/openapi.json`.

### 7.14 `app.ts` / `server.ts`
- **`buildApp({ db, clock })`**: Express app with this middleware order:
  1. `requestId`
  2. JSON parser (limit 100 kb)
  3. CORS (only `WEB_ORIGIN`)
  4. `helmet`
  5. the routes
  6. 404 handler
  7. `errorHandler`

  Tests call `buildApp` with a test DB.
- **`server.ts`**: `loadEnv()`, then `createPool`, then `buildApp`, then `listen`. Shuts down gracefully on SIGTERM: stop accepting requests, finish the current ones, close the pool.

---

## 8. Worker and scheduler design

### 8.1 `worker.ts`
```
workerId = hostname + pid
every POLL_INTERVAL (1 s when work was found, up to 5 s when idle):
    recoverStuck() every 60 s
    batch = claimDue(workerId, BATCH_SIZE=20)          # one transaction
    run batch with concurrency limit WORKER_CONCURRENCY=5 (p-limit):
        sender = getSender(channel.type)
        result = await sender.send(...)                 # never throws; returns SendResult
        decision = decide(delivery, result)
        persist decision + attempt row                  # one transaction
    log a summary line: claimed, delivered, retried, failed, dead, ms
on SIGTERM: stop claiming, wait for in-flight sends (max 20 s), exit
```
**Points to explain:**
- Claiming in a transaction and **sending outside it**: never hold a DB lock during a network call.
- Concurrency limits protect external APIs and the DB pool.
- Several worker processes can run safely thanks to `SKIP LOCKED`.

### 8.2 `scheduler.ts`
```
every SCHEDULER_INTERVAL_SEC (default 15):
    rules = active rules grouped by (provider, symbol)
    for each provider: prices = getLatest(provider, symbols)       # one call per provider
    for each rule: result = evaluate(rule, prices[symbol], now, history)
                   applyEvaluation(rule, result, price)
    once an hour: pruneOld()
```
- Only one scheduler should run. On free hosting, just run one instance.
- To be safe, take a MySQL advisory lock (`SELECT GET_LOCK('alertly_scheduler', 0)`). If it isn't acquired, skip the tick. That's a good talking point about leader election.

---

## 9. Frontend design (Next.js + Tailwind)

**Stack:**
- Next.js App Router, TypeScript, Tailwind.
- TanStack Query for server state (caching, refetch, loading and error states).
- React Hook Form + Zod resolver for forms, using the shared schemas.
- `next/dynamic` for heavy client-only pieces, such as the usage chart (Recharts).

**Same-origin API:** `next.config` rewrites `/api/:path*` to `API_URL/api/v1/:path*`. The browser talks to its own origin, so the httpOnly session cookie works with `SameSite=Lax` and there are no CORS headaches in production.

### 9.1 Routes
| Route | Purpose | Main components |
| --- | --- | --- |
| `/login`, `/register` | auth forms | `AuthForm` |
| `/` (dashboard) | today's deliveries by status, success rate, recent failures, usage chart | `StatCard`, `StatusBadge`, `UsageChart` (dynamic import), `RecentFailures` |
| `/channels` | list + "Add channel" | `ChannelTable`, `ChannelForm` (type-specific fields), `TestSendButton` (sends, then polls the delivery until final) |
| `/alerts` | list with state badges (armed / cooldown) and last trigger | `AlertTable`, `AlertForm` (condition-specific fields), `PriceSparkline` |
| `/alerts/[id]` | rule detail, trigger history, dry-run button | `AlertEvents`, `DryRunPanel` |
| `/notifications` | filterable list | `DataTable` with cursor pagination |
| `/notifications/[id]` | **delivery timeline**: per channel, each attempt with time, status, HTTP code, error, next retry | `DeliveryTimeline` |
| `/deliveries` | log with status filter + manual retry | `DeliveryTable`, `RetryButton` |
| `/api-keys` | create (shown once, with a copy button), list, revoke | `ApiKeyDialog` |
| `/docs` | link to the API's Swagger page + quick-start snippets (curl, Node) | – |

### 9.2 `lib/`
- **`api.ts`: `apiFetch<T>(path, init)`**: wraps `fetch` with `credentials: 'include'`, JSON parsing, and maps the problem JSON to a typed `ApiError`. Hooks per resource, for example `useChannels()`, `useCreateChannel()`, `useNotification(id)`; mutations invalidate the related queries.
- **`format.ts`**: relative times, status colours, price formatting.
- **Auth guard:** `middleware.ts` (Next.js) redirects to `/login` when the session cookie is missing. The API still enforces auth on every call.

### 9.3 UX details that look professional
- Empty states with one clear action ("No channels yet: add your first").
- Optimistic UI only for safe toggles, such as pausing an alert.
- Toasts for success and error.
- Accessible forms: labels, focus rings, errors next to their fields.
- Dark mode via Tailwind `dark:` classes.
- Responsive down to phone width.

---

## 10. Security

1. **Passwords:** argon2id; same error for unknown email and wrong password; a basic login rate limit (5 per minute per IP).
2. **API keys:** random 32 bytes, stored only as a SHA-256 hash, shown once, revocable, prefixed (`alr_`) so leaked keys are easy to spot.
3. **Secrets at rest:** webhook secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY` from env. Never log secrets, keys or tokens; redact `Authorization` in logs.
4. **SSRF guard** on webhook URLs at save time **and** send time (section 3.6).
5. **Webhook signatures** with a timestamp and a 5-minute tolerance (section 3.4).
6. **Ownership checks** in every service function. Return 404 for other users' resources.
7. **Input validation** on every route (Zod), body size limit, parameterised SQL everywhere.
8. **Headers:** `helmet` (CSP, no-sniff, etc.), CORS restricted to the web origin, cookies httpOnly + Secure + SameSite=Lax.
9. **Secrets in env only:** `.env.example` is committed; `.env` never is. Rotating `JWT_SECRET` logs everyone out; document it.

---

## 11. Performance

- **Indexes match queries:** `idx_due` for the queue, `(user_id, created_at)` for lists, the unique `key_hash` for auth. Run `EXPLAIN` on the queue and list queries and paste the output into `docs/` as evidence.
- **Batched claims** (20 rows per transaction) and **bulk inserts** for the delivery fan-out.
- **No N+1 queries:** the timeline uses two queries (section 7.8).
- **Connection pool** sized to `WORKER_CONCURRENCY` + headroom; never hold a connection during network I/O.
- **Throttled writes:** `last_used_at` updates at most once a minute per key.
- **Caching:** prices are cached for 10 s, so 100 rules on BTC cost one provider call.
- **Frontend:** the chart is loaded with `next/dynamic` (code splitting), lists are paginated, TanStack Query avoids duplicate fetches, and server components serve static parts.
- **Measure it:** a small load script (`autocannon` against `POST /notifications`), with the numbers recorded in the README, before and after an index or batching change. Measured evidence beats claims in an interview.

---

## 12. Testing strategy

**Tools:**
- Vitest (unit + integration).
- Supertest (HTTP).
- A MySQL 8 container (Docker Compose locally, a service container in CI).
- A **mock webhook server** (Node `http.createServer`) that can return 200, 500, 429 or hang, on command.

### 12.1 Unit tests (fast, no DB)
- `backoff.nextDelayMs`: grows, caps at the max, jitter stays within its bounds.
- `isRetryable`: 500/502/503/504/408/429 retry; 400/401/403/404/410 do not; network errors retry.
- `deliveries.decide`: every branch (delivered, retry, failed, dead at `max_attempts`).
- `alerts.evaluate`: above/below with cooldown and re-arm, cross_above needing `last_price`, pct_move with history, no double fire while triggered.
- `crypto.signWebhook` / `verifyWebhook`: valid, tampered body, old timestamp.
- `net-guard`: rejects `http://127.0.0.1`, `http://10.0.0.5`, `http://169.254.169.254`, `http://[::1]`; accepts a public https URL (mock DNS).
- `pagination` cursor round-trip.

### 12.2 Integration tests (real MySQL)
- **Setup:** each test file runs migrations into a fresh database (`alertly_test_<random>`) and drops it afterwards.
- Register, log in, `/auth/me` works; a wrong password gives 401.
- API key: create, call with the key, revoke, call again gives 401.
- Channels: a webhook to a private IP is rejected (422); a test send creates a notification.
- **Idempotency:**
  - the same key + same body twice gives one row, the second response 200 + `Idempotent-Replayed`
  - the same key + a different body gives 409
- **Worker against the mock server:**
  - 200: `delivered`, one attempt.
  - 500 then 200: one retry, then `delivered`; `next_attempt_at` respected (inject the clock).
  - always 500: `dead` after `max_attempts`; manual retry resets it.
  - 404: `failed` immediately (not retried).
  - Two workers in parallel claim **disjoint** rows (no row delivered twice).
- **Alerts:** use the simulated provider, force a cross, run one scheduler tick, and check exactly one notification. Running the tick again in the same minute creates none (idempotency key).
- Rate limit: request 61 within a minute gives 429 with the headers.

### 12.3 Frontend
- A few component tests (React Testing Library): `DeliveryTimeline` renders attempts; `AlertForm` shows the window field only for `pct_move`.
- Optional: one Playwright smoke test (log in, add a webhook channel, test send, see delivered).

**Coverage target:** focus on the core modules (notifications, deliveries, alerts, crypto, net-guard) rather than a global percentage.

---

## 13. DevOps: local setup, CI, deployment

### 13.1 Local
- `docker compose up -d mysql`, then `npm install`, `npm run migrate -w apps/api`, `npm run seed -w apps/api`.
- `npm run dev` starts the API, worker, scheduler and web together (with `concurrently`).
- `.env.example` documents every variable.

### 13.2 CI (`.github/workflows/ci.yml`)
On every push and PR:
1. MySQL 8 service container.
2. `npm ci`.
3. `npm run lint` (ESLint + Prettier check).
4. `npm run typecheck` (`tsc --noEmit` in all workspaces).
5. `npm test`.

Show the CI badge in the README.

### 13.3 Deployment (free or low-cost tiers; check current limits when you deploy)
- **Web:** Vercel (Next.js); env `API_URL`.
- **API + worker + scheduler:** Railway / Render / Fly.io, as **three processes from one image** with different start commands.
- **MySQL:** a managed MySQL 8 (Railway, Aiven or similar). Run migrations on deploy (`npm run migrate` as a release step).
- **Email:** Resend or Brevo free tier (verify a sender domain or use their test domain).
- **Telegram:** one bot for the app; users link a chat by messaging the bot (document the steps).
- **Live demo:** a seeded **demo account** (read-only for others) with simulated-price alerts firing every few minutes into a demo webhook (for example a request inspector) and Telegram. A reviewer sees real deliveries without signing up.

### 13.4 README checklist
- What it is, plus a GIF or screenshot.
- Live links: app, API docs.
- The architecture diagram.
- Key design decisions (sections 3.1–3.6, short).
- How to run locally; the API quick start.
- Testing: how to run, and what's covered.
- Performance numbers measured.
- The JD-style skills table (1.3).
- What's out of scope, and what I'd do at scale.
- **"Built with AI pair-programming (Claude Code) for design review and debugging; all code written and understood by me."** Keep this honest, and make sure you can explain every file.

---

## 14. Build plan, week by week

### Week 1: foundation (backend skeleton, auth, data model)
1. Repo + workspaces + TypeScript configs + ESLint/Prettier + Vitest + CI (green on an empty test).
2. `config/env.ts`, `lib/logger.ts`, `lib/errors.ts`, `middleware/requestId` + `errorHandler`, `app.ts`, `server.ts`, `/health`.
3. Docker MySQL, `db/pool.ts`, `db/tx.ts`, migration runner, `001_init.sql` (all tables from section 5).
4. Auth module (register / login / logout / me) + integration tests.
5. API keys module + `requireSessionOrApiKey` + tests.
6. Channels CRUD (no sending yet) + `net-guard` + `crypto.encrypt` + tests.
7. OpenAPI skeleton at `/docs`.

**Learn this week:** Express middleware order; async error handling; `mysql2` pools and transactions; Zod; JWT basics; how cookies work.

### Week 2: the core (notifications, queue, worker, senders)
1. Notifications `create` with idempotency + fan-out in one transaction; list / get; tests for replay and 409.
2. Deliveries repo: `claimDue` with `SKIP LOCKED`, `mark*`, `recoverStuck`; `decide` + `backoff` + unit tests.
3. The worker loop with p-limit and graceful shutdown.
4. Senders: webhook (signature, timeout, SSRF re-check) → email → Telegram.
5. The mock webhook server + integration tests (success, retry, dead, permanent, two workers).
6. Delivery endpoints + manual retry.

**Learn this week:** transactions and locking (`FOR UPDATE SKIP LOCKED`), `fetch` + `AbortController`, HMAC, designing for failure.

### Week 3: alerts, dashboard, deploy, polish
1. Prices: simulated provider + one real provider + `priceService` + snapshots.
2. Alerts: `evaluate` (+ thorough unit tests), CRUD, dry run, the scheduler with the advisory lock, idempotent alert notifications.
3. Next.js: login, dashboard, channels (with test send), alerts, notification timeline, deliveries, API keys.
4. Rate limiting + usage quota + usage chart (dynamic import).
5. Deploy all pieces; seed the demo account; write the README; record a 1–2 minute demo video.
6. One measured performance improvement (add or verify an index, or batching) with before/after numbers.

**Done means:** a live link works for a stranger, CI is green, the README answers "why" for every key decision, and you can draw the architecture and walk through `notifications.create`, `claimDue`, `decide` and `evaluate` without notes.

---

## 15. Interview guide

### 15.1 The two-minute pitch
"Alertly delivers notifications reliably by email, webhook and Telegram, and fires alerts on price conditions. It started from the alert system in my trading project, where a silent data-feed failure taught me that alerts must be reliable themselves. The interesting parts:
- **idempotent creation** with a unique key
- a **MySQL-backed queue** using `SKIP LOCKED` so several workers never take the same job
- **retries with backoff and a dead-letter state**
- **signed webhooks**
- an **SSRF guard**

It's TypeScript end to end, Node/Express plus Next.js and Tailwind, with integration tests that run a fake webhook server to prove the retry behaviour."

### 15.2 Questions to be ready for
- *Why at-least-once and not exactly-once?* Exactly-once across a network is not achievable in general. Instead: at-least-once, plus idempotency keys on our side and notification IDs for receivers.
- *What if a worker crashes mid-send?* The row stays `sending` with an old `locked_at`. `recoverStuck` returns it to `retrying`, and the receiver may see a duplicate, which is exactly why it gets an ID.
- *Why MySQL as a queue?* It's enough at this scale: one less service, transactional with the data (outbox pattern). At high volume I'd move to Redis/BullMQ or SQS behind the same interface.
- *How does `SKIP LOCKED` work?* Rows locked by another transaction are skipped instead of waited on, so workers claim disjoint batches without contention.
- *Why not hold the transaction during the send?* Network calls are slow and unpredictable. Holding row locks and connections during them would exhaust the pool and block other workers.
- *How do you stop alert spam?* The state machine with cooldown and hysteresis, plus a per-minute idempotency key.
- *How would you scale it?*
  - more worker processes (already safe)
  - partition the queue by priority
  - move rate limiting to Redis
  - move price polling to a stream
  - archive `delivery_attempts` into monthly tables
- *What would you change with more time?* Organisations and roles, per-channel templates, delivery status webhooks back to the sender, metrics (Prometheus) and tracing.
- *Show me a bug you fixed.* Keep a short `docs/DEBUG_LOG.md` while building: real bugs, how you found them, the fix. That's your best answer material.

### 15.3 Honesty notes
- Say where AI helped (design discussion, review, debugging) and what you wrote.
- Don't claim production users or scale you didn't measure. Quote the load-test numbers you actually ran.

---

## 16. Stretch goals (only after the core is done)
1. Per-channel message templates (Handlebars) with a preview.
2. Digest mode: batch low-priority notifications into one hourly email.
3. Status callbacks: notify the sender's webhook when a delivery ends `delivered` / `dead`.
4. Swap the queue for BullMQ (Redis) behind the `DeliveryQueue` interface, and compare.
5. Organisations, members and roles.
6. Metrics endpoint (Prometheus) + a small Grafana dashboard.
7. Email-address checks before sending: syntax, the domain's MX record, and a disposable-domain list (no SMTP probing).

---

*Prepared 2026-10-16 as the build plan. Implementation happens step by step: write each module yourself, run the tests, then move on.*
