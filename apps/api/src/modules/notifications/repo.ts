import { exec, query, queryOne, type Queryable } from '../../db/pool';
import { cursorWhere } from '../../lib/pagination';
import { Where } from '../../lib/sql';

export interface NotificationRow {
  id: number;
  user_id: number;
  idempotency_key: string | null;
  request_hash: string | null;
  source: 'api' | 'alert' | 'test';
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  priority: 'normal' | 'high';
  created_at: Date;
}

export async function insertNotification(
  db: Queryable,
  n: {
    userId: number;
    idempotencyKey: string | null;
    requestHash: string | null;
    source: NotificationRow['source'];
    title: string;
    body: string;
    data: Record<string, unknown> | null;
    priority: NotificationRow['priority'];
    createdAt: Date;
  },
): Promise<number> {
  const r = await exec(
    db,
    `INSERT INTO notifications
       (user_id, idempotency_key, request_hash, source, title, body, data, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      n.userId,
      n.idempotencyKey,
      n.requestHash,
      n.source,
      n.title,
      n.body,
      n.data === null ? null : JSON.stringify(n.data),
      n.priority,
      n.createdAt,
    ],
  );
  return r.insertId;
}

/**
 * The fan-out: one delivery row per target channel, in a single multi-row INSERT.
 * `VALUES ?` with an array of arrays is expanded by mysql2 into (…), (…), (…).
 */
export async function insertDeliveries(
  db: Queryable,
  rows: {
    userId: number;
    notificationId: number;
    channelId: number;
    priority: number;
    dueAt: Date;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec(
    db,
    `INSERT INTO deliveries (user_id, notification_id, channel_id, status, priority, next_attempt_at, created_at)
     VALUES ?`,
    [
      rows.map((r) => [
        r.userId,
        r.notificationId,
        r.channelId,
        'pending',
        r.priority,
        r.dueAt,
        r.dueAt,
      ]),
    ],
  );
}

export const findByIdempotencyKey = (db: Queryable, userId: number, key: string) =>
  queryOne<NotificationRow>(
    db,
    'SELECT * FROM notifications WHERE user_id = ? AND idempotency_key = ?',
    [userId, key],
  );

export const findNotification = (db: Queryable, userId: number, id: number) =>
  queryOne<NotificationRow>(db, 'SELECT * FROM notifications WHERE id = ? AND user_id = ?', [
    id,
    userId,
  ]);

export interface NotificationFilters {
  source?: NotificationRow['source'];
  from?: Date;
  to?: Date;
}

/** Served by INDEX (user_id, created_at, id): filter by user, already in sort order. */
export async function listNotifications(
  db: Queryable,
  userId: number,
  f: NotificationFilters,
  limit: number,
  cursor?: string,
): Promise<NotificationRow[]> {
  const w = new Where()
    .add('n.user_id = ?', userId)
    .addIf(f.source, 'n.source = ?', f.source)
    .addIf(f.from, 'n.created_at >= ?', f.from)
    .addIf(f.to, 'n.created_at < ?', f.to);
  const c = cursorWhere(cursor, 'n');
  return query<NotificationRow>(
    db,
    `SELECT n.* FROM notifications n WHERE ${w.sql}${c.sql}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    [...w.params, ...c.params, limit + 1],
  );
}
