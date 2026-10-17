import type { ChannelType, DeliveryStatus } from '@alertly/shared';
import { exec, query, queryOne, type Queryable } from '../../db/pool';
import { cursorWhere } from '../../lib/pagination';
import { Where } from '../../lib/sql';

export interface DeliveryRow {
  id: number;
  user_id: number;
  notification_id: number;
  channel_id: number;
  status: DeliveryStatus;
  priority: number;
  attempt_count: number;
  total_attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null; // NULL when no attempt is scheduled (see migration 002)
  locked_by: string | null;
  locked_at: Date | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // joined from channels
  channel_name: string;
  channel_type: ChannelType;
}

export interface AttemptRow {
  id: number;
  delivery_id: number;
  attempt_no: number;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  outcome: 'success' | 'retryable_error' | 'permanent_error';
  http_status: number | null;
  error: string | null;
}

const SELECT_DELIVERY = `
  SELECT d.*, c.name AS channel_name, c.type AS channel_type
    FROM deliveries d
    JOIN channels c ON c.id = d.channel_id`;

/** One query for all deliveries of several notifications (no N+1). */
export const listDeliveriesForNotifications = (db: Queryable, notificationIds: number[]) =>
  notificationIds.length === 0
    ? Promise.resolve([] as DeliveryRow[])
    : query<DeliveryRow>(db, `${SELECT_DELIVERY} WHERE d.notification_id IN (?) ORDER BY d.id`, [
        notificationIds,
      ]);

/** One query for all attempts of several deliveries (no N+1). */
export const listAttemptsForDeliveries = (db: Queryable, deliveryIds: number[]) =>
  deliveryIds.length === 0
    ? Promise.resolve([] as AttemptRow[])
    : query<AttemptRow>(
        db,
        'SELECT * FROM delivery_attempts WHERE delivery_id IN (?) ORDER BY delivery_id, attempt_no',
        [deliveryIds],
      );

export interface DeliveryFilters {
  status?: DeliveryStatus;
  channelId?: number;
  from?: Date;
  to?: Date;
}

export async function listDeliveries(
  db: Queryable,
  userId: number,
  f: DeliveryFilters,
  limit: number,
  cursor?: string,
): Promise<DeliveryRow[]> {
  const w = new Where()
    .add('d.user_id = ?', userId)
    .addIf(f.status, 'd.status = ?', f.status)
    .addIf(f.channelId, 'd.channel_id = ?', f.channelId)
    .addIf(f.from, 'd.created_at >= ?', f.from)
    .addIf(f.to, 'd.created_at < ?', f.to);
  const c = cursorWhere(cursor, 'd');
  return query<DeliveryRow>(
    db,
    `${SELECT_DELIVERY} WHERE ${w.sql}${c.sql} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
    [...w.params, ...c.params, limit + 1],
  );
}

export const findDelivery = (db: Queryable, userId: number, id: number) =>
  queryOne<DeliveryRow>(db, `${SELECT_DELIVERY} WHERE d.id = ? AND d.user_id = ?`, [id, userId]);

/**
 * Manual retry from failed/dead: a fresh round of attempts, due now.
 * attempt_count resets (so backoff starts short again); total_attempts keeps counting.
 * The status condition in WHERE makes this safe against double clicks and races.
 */
export const resetForManualRetry = (db: Queryable, id: number, now: Date) =>
  exec(
    db,
    `UPDATE deliveries
        SET status = 'retrying', attempt_count = 0, next_attempt_at = ?, last_error = NULL
      WHERE id = ? AND status IN ('failed', 'dead')`,
    [now, id],
  );
