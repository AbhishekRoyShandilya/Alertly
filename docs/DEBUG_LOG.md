# Debug log

Real problems found while building Alertly: the symptom, how it was found, and the fix.

### 1. The queue query locked the whole backlog

- **Symptom:** none yet; caught before it could hurt.
- **Found by:** running `EXPLAIN` on the worker's claim query before relying on it: `Using
filesort`. With `FOR UPDATE`, InnoDB locks every row it reads before sorting, so parallel
  workers would have serialised.
- **Fix:** migration 002, with nullable `next_attempt_at`, index `(priority, next_attempt_at)`
  and one claim per priority. Verified with EXPLAIN on 50k rows (`range`, no filesort). Details
  in [PERFORMANCE.md](PERFORMANCE.md).

### 2. The SSRF guard blocked every IPv4 address

- **Symptom:** the unit test "accepts a public https URL" failed: `93.184.216.34` was reported as
  private.
- **Found by:** a one-line Node script showed that `net.BlockList` maps IPv4 and IPv4-mapped
  IPv6 **in both directions**, so a rule for `::ffff:0:0/96` matched every IPv4 address.
- **Fix:** removed that rule, because the IPv4 rules already cover mapped addresses (a test
  checks `::ffff:7f00:1`). Left a comment explaining why.

### 3. `delivered_at` and `verified_at` written as NULL

- **Symptom:** the worker test "channel verified after a successful delivery" failed;
  TypeScript also reported "Expected 6 arguments, but got 5".
- **Cause:** `persistOutcome(…)` was called without its `now` argument, so mysql2 sent
  `undefined` → NULL.
- **Fix:** pass `now`. A good reminder to run the typechecker before the tests.

### 4. A test that tested the wrong thing (default parameters)

- **Symptom:** the "Telegram not configured" test received `ok: true`.
- **Cause:** the helper was `send(f, token = 'TOKEN')`, and calling `send(f, undefined)` uses the
  **default**, so a token was sent after all.
- **Fix:** removed the default value from the helper.

### 5. Flaky alert test at minute boundaries

- **Symptom:** "idempotency key absorbs a re-fire" failed about one run in several.
- **Cause:** the alert idempotency key is per rule **per minute**. The fake clock started at the
  real time, so two ticks one second apart sometimes fell in different minutes and correctly
  produced two notifications.
- **Fix:** pin the test clock 5 s into a fresh minute. It then passed 4/4 consecutive runs.

### 6. Advisory lock shared across databases

- **Found by:** code review of the scheduler. `GET_LOCK` names are global to the **MySQL server**,
  not per database, so a dev and a staging scheduler on one server would block each other.
- **Fix:** lock name `alertly_scheduler:<DATABASE()>`.

### 7. `/deliveries/stats` returned "Delivery not found"

- **Symptom:** in the end-to-end check, the stats endpoint returned 404 with a delivery error.
- **Cause:** the running API was an **old build**, in which `/deliveries/:id` matched "stats".
- **Fix:** rebuilt. In the source the stats route is registered before `/:id`, because Express
  matches routes in order.

### 8. Production container crashed on start

- **Symptom:** `docker compose --profile app up`: the migrate container exited with "unable to
  determine transport target for pino-pretty".
- **Cause:** `.env.docker` sets `NODE_ENV=development`, so the logger requested `pino-pretty`,
  which is a devDependency and isn't installed in the production image.
- **Fix:** use pretty logs only when `pino-pretty` can be resolved; otherwise plain JSON.

### 9. Mojibake in source files

- **Symptom:** `…` and `→` in comments and messages turned into `â€¦` and `â†’`.
- **Cause:** files edited with Windows PowerShell 5.1 `Get-Content`/`Set-Content`, which read UTF-8
  as the ANSI code page.
- **Found by:** `grep -rn "â"`. **Fix:** repaired with a UTF-8-safe Node script; switched to
  encoding-safe editing.

### 10. API throughput limited by commits

- **Symptom:** the load test gave 32 req/s with a p50 of 472 ms for ~10 small queries per
  request.
- **Found by:** forming a hypothesis (fsync-bound) and testing it by relaxing durability once:
  377 req/s.
- **Fix:** buffer the per-request usage counter and flush every 5 s, giving 74–88 req/s with
  full durability. See [PERFORMANCE.md](PERFORMANCE.md).
