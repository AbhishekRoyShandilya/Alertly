# Performance: what was measured, and what changed because of it

All numbers come from `npm run bench -w @alertly/api` ([apps/api/scripts/bench.ts](../apps/api/scripts/bench.ts)) on a
development laptop: Windows 11, Node 22, MySQL 8.4 in Docker Desktop. Each run uses a fresh
database. These are **local** numbers, useful for comparing before and after, not a claim about
production capacity.

## 1. The queue index (found with EXPLAIN)

The worker claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`. The first version:

```sql
SELECT id FROM deliveries
 WHERE status IN ('pending','retrying') AND next_attempt_at <= NOW(3)
 ORDER BY priority DESC, next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED;
```

```
type=index  key=idx_due  Extra: Using where; Using index; Using filesort
```

`Using filesort` means MySQL reads every matching row and sorts them. With `FOR UPDATE`,
InnoDB locks every row it reads, so one worker could lock the whole backlog and parallel
workers would skip it all.

**Fix ([migration 002](../apps/api/migrations/002_queue_index.sql)):** `next_attempt_at` is
NULL when nothing is scheduled, the index is `(priority, next_attempt_at)`, and the claim runs
once per priority. With 50,000 deliveries (5,000 due):

| Query                                           | type      | key         | Extra                                                  |
| ----------------------------------------------- | --------- | ----------- | ------------------------------------------------------ |
| before (status IN, two-column sort)             | range     | idx_stuck   | Using index condition; Using where; **Using filesort** |
| after (`priority = ? AND next_attempt_at <= ?`) | **range** | **idx_due** | Using where; Using index                               |

The new claim reads due rows already in order from the index, and only the claimed batch is
locked. Delivered, failed and dead rows (NULL) are never scanned.

## 2. Worker throughput: batching and concurrency

600 webhook deliveries to a local receiver that waits 20 ms per request (a fast webhook).
Three runs:

| Batch size | Concurrency | Deliveries/s (3 runs) |
| ---------- | ----------- | --------------------- |
| 1          | 1           | 18 – 21               |
| 20         | 1           | 26 – 28               |
| 20         | 5           | **81 – 116**          |
| 20         | 10          | 62 – 129              |

- **Claiming in batches + sending concurrently: about 4–5× faster** than one at a time.
- Going from concurrency 5 to 10 doesn't help reliably. The limit isn't the receiver; see
  section 4.

## 3. API throughput: fewer commits per request

`POST /notifications` with an API key, 20 connections for 10 s (autocannon), two target
channels per notification:

| Version                                       | Requests/s  | p50 latency  | p99 latency    |
| --------------------------------------------- | ----------- | ------------ | -------------- |
| Usage counter written per request             | 32          | 472 ms       | 1,512 ms       |
| **Usage counter buffered, flushed every 5 s** | **74 – 88** | 133 – 267 ms | 341 – 1,138 ms |

**What changed:** every API-key request used to run its own autocommit `INSERT … ON DUPLICATE
KEY UPDATE` for the `api_requests` counter, which is a second commit per request. Counts are now
buffered in memory per user and written once every 5 s
([usage/service.ts](../apps/api/src/modules/usage/service.ts)), flushed on shutdown. Trade-off:
a crash can lose up to 5 s of request counts, which is acceptable for a usage chart and would
not be for billing.

## 4. How the bottleneck was identified

Both the worker and the API plateaued at about 66 commits per second. To test the hypothesis
"commit latency (fsync) is the limit", the benchmark was re-run once with durability relaxed
(`innodb_flush_log_at_trx_commit=2`, `sync_binlog=0`), then the settings were restored:

|                                                | Durable (default) | fsync relaxed (diagnosis only) |
| ---------------------------------------------- | ----------------- | ------------------------------ |
| API requests/s                                 | 32                | 377 (p50 51 ms)                |
| Worker deliveries/s (batch 20, concurrency 10) | 62 – 129          | 233                            |

Throughput rose 3–10× without changing any code, which confirms that **each transaction commit
waiting for disk** dominates. Docker Desktop on Windows has slow fsync, and a managed MySQL on
SSDs commits much faster. The code-level lesson holds anywhere: **count commits per request.**

## What I would do next

- **Batch the worker's result writes:** one transaction per claimed batch instead of one per
  delivery. That means fewer commits, at the cost of losing a few results if the worker crashes
  mid-batch (they'd be re-sent, and receivers de-duplicate anyway).
- Run the same benchmark against the hosted MySQL and record the numbers here.
- Move the rate-limit counters to Redis once there is more than one API instance.

## Reproduce

```bash
docker compose up -d mysql
npm run bench -w @alertly/api
```
