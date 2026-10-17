import type { ChannelType } from '@alertly/shared';
import { exec, query, type Db, type Queryable } from '../../db/pool';
import { withTransaction } from '../../db/tx';
import { markVerified } from '../channels/repo';
import type { Decision } from './decide';

/** A claimed delivery with everything a sender needs, loaded in one join. */
export interface ClaimedDelivery {
  id: number;
  user_id: number;
  notification_id: number;
  channel_id: number;
  attempt_count: number;
  total_attempts: number;
  max_attempts: number;
  n_title: string;
  n_body: string;
  n_data: Record<string, unknown> | null;
  n_source: 'api' | 'alert' | 'test';
  n_created_at: Date;
  c_type: ChannelType;
  c_name: string;
  c_config: Record<string, unknown>;
  c_secret_enc: Buffer | null;
}

export interface AttemptRecord {
  attemptNo: number;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  outcome: 'success' | 'retryable_error' | 'permanent_error';
  httpStatus: number | null;
  error: string | null;
}

/**
 * Claims up to `batchSize` due deliveries for this worker, in one short transaction:
 *
 * 1. SELECT … FOR UPDATE SKIP LOCKED: lock due rows, but *skip* rows another worker has
 *    already locked instead of waiting for them. N workers grab N disjoint batches at once.
 * 2. UPDATE them to `sending`, owned by this worker (locked_by/locked_at), attempt counters +1.
 * 3. COMMIT: row locks are released, but the rows are now `sending` with next_attempt_at NULL,
 *    so no other worker's SELECT will match them.
 *
 * The actual network send happens AFTER this transaction. Holding a lock (and a pooled
 * connection) during a 10-second HTTP call would block other workers and drain the pool.
 *
 * High priority first, then normal (two in-order index range scans; see migration 002).
 */
export async function claimDue(
  db: Db,
  workerId: string,
  batchSize: number,
  now: Date,
): Promise<ClaimedDelivery[]> {
  return withTransaction(db, async (conn) => {
    const ids: number[] = [];
    for (const priority of [1, 0]) {
      const remaining = batchSize - ids.length;
      if (remaining <= 0) break;
      const rows = await query<{ id: number }>(
        conn,
        `SELECT id FROM deliveries
          WHERE priority = ? AND next_attempt_at <= ?
          ORDER BY next_attempt_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [priority, now, remaining],
      );
      ids.push(...rows.map((r) => r.id));
    }
    if (ids.length === 0) return [];

    await exec(
      conn,
      `UPDATE deliveries
          SET status = 'sending', next_attempt_at = NULL, locked_by = ?, locked_at = ?,
              attempt_count = attempt_count + 1, total_attempts = total_attempts + 1
        WHERE id IN (?)`,
      [workerId, now, ids],
    );

    return query<ClaimedDelivery>(
      conn,
      `SELECT d.id, d.user_id, d.notification_id, d.channel_id,
              d.attempt_count, d.total_attempts, d.max_attempts,
              n.title AS n_title, n.body AS n_body, n.data AS n_data,
              n.source AS n_source, n.created_at AS n_created_at,
              c.type AS c_type, c.name AS c_name, c.config AS c_config, c.secret_enc AS c_secret_enc
         FROM deliveries d
         JOIN notifications n ON n.id = d.notification_id
         JOIN channels c ON c.id = d.channel_id
        WHERE d.id IN (?)`,
      [ids],
    );
  });
}

async function insertAttempt(db: Queryable, deliveryId: number, a: AttemptRecord) {
  await exec(
    db,
    `INSERT INTO delivery_attempts
       (delivery_id, attempt_no, started_at, finished_at, duration_ms, outcome, http_status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deliveryId,
      a.attemptNo,
      a.startedAt,
      a.finishedAt,
      a.durationMs,
      a.outcome,
      a.httpStatus,
      a.error?.slice(0, 500) ?? null,
    ],
  );
}

/**
 * Persists the outcome of one send: the attempt log row + the new delivery state, atomically.
 *
 * `AND locked_by = ?` guards against a slow worker: if this worker took so long that
 * recoverStuck() handed the row to someone else, its late result must not overwrite the new
 * owner's state. The attempt is still logged, because it really happened.
 * Returns false when the row was no longer ours.
 */
export async function persistOutcome(
  db: Db,
  d: ClaimedDelivery,
  workerId: string,
  decision: Decision,
  attempt: AttemptRecord,
  now: Date,
): Promise<boolean> {
  return withTransaction(db, async (conn) => {
    await insertAttempt(conn, d.id, attempt);
    const unlock = 'locked_by = NULL, locked_at = NULL';
    const owned = 'WHERE id = ? AND status = ? AND locked_by = ?';
    let r;
    switch (decision.kind) {
      case 'delivered':
        r = await exec(
          conn,
          `UPDATE deliveries SET status = 'delivered', delivered_at = ?, last_error = NULL, ${unlock} ${owned}`,
          [now, d.id, 'sending', workerId],
        );
        if (r.affectedRows) await markVerified(conn, d.channel_id, now);
        break;
      case 'retry':
        r = await exec(
          conn,
          `UPDATE deliveries SET status = 'retrying', next_attempt_at = ?, last_error = ?, ${unlock} ${owned}`,
          [decision.nextAt, decision.error.slice(0, 500), d.id, 'sending', workerId],
        );
        break;
      case 'failed':
      case 'dead':
        r = await exec(
          conn,
          `UPDATE deliveries SET status = ?, last_error = ?, ${unlock} ${owned}`,
          [decision.kind, decision.error.slice(0, 500), d.id, 'sending', workerId],
        );
        break;
    }
    return r.affectedRows === 1;
  });
}

/**
 * Crash recovery. A worker that dies mid-send leaves rows stuck in `sending`. After
 * `olderThanSec` they go back to the queue (or to `dead` if no attempts are left).
 * The receiver may then get the message twice, which is why every webhook carries the
 * notification id for de-duplication (at-least-once delivery).
 * Served by INDEX idx_stuck (status, locked_at).
 */
export async function recoverStuck(db: Db, now: Date, olderThanSec = 300): Promise<number> {
  const r = await exec(
    db,
    `UPDATE deliveries
        SET status = IF(attempt_count >= max_attempts, 'dead', 'retrying'),
            next_attempt_at = IF(attempt_count >= max_attempts, NULL, ?),
            last_error = 'Worker stopped responding during the send; re-queued',
            locked_by = NULL, locked_at = NULL
      WHERE status = 'sending' AND locked_at < ?`,
    [now, new Date(now.getTime() - olderThanSec * 1000)],
  );
  return r.affectedRows;
}
