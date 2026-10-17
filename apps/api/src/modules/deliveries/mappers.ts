import {
  ID_PREFIX,
  type Delivery,
  type DeliveryAttempt,
  type DeliveryWithAttempts,
} from '@alertly/shared';
import { encodeId } from '../../lib/ids';
import { toIsoOrNull } from '../../lib/time';
import type { AttemptRow, DeliveryRow } from './repo';

/** DB row (snake_case, numeric ids) â†’ API shape (camelCase, public ids). */
export const toDelivery = (r: DeliveryRow): Delivery => ({
  id: encodeId(ID_PREFIX.delivery, r.id),
  notificationId: encodeId(ID_PREFIX.notification, r.notification_id),
  channelId: encodeId(ID_PREFIX.channel, r.channel_id),
  channelName: r.channel_name,
  channelType: r.channel_type,
  status: r.status,
  attemptCount: r.attempt_count,
  maxAttempts: r.max_attempts,
  // Only meaningful while the delivery is still waiting to be tried.
  nextAttemptAt: toIsoOrNull(r.next_attempt_at),
  lastError: r.last_error,
  deliveredAt: toIsoOrNull(r.delivered_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export const toAttempt = (a: AttemptRow): DeliveryAttempt => ({
  attemptNo: a.attempt_no,
  startedAt: a.started_at.toISOString(),
  finishedAt: a.finished_at.toISOString(),
  durationMs: a.duration_ms,
  outcome: a.outcome,
  httpStatus: a.http_status,
  error: a.error,
});

/** Groups attempts under their delivery. Input: rows from the two batched queries. */
export function withAttempts(
  deliveries: DeliveryRow[],
  attempts: AttemptRow[],
): DeliveryWithAttempts[] {
  const byDelivery = new Map<number, DeliveryAttempt[]>();
  for (const a of attempts) {
    const list = byDelivery.get(a.delivery_id) ?? [];
    list.push(toAttempt(a));
    byDelivery.set(a.delivery_id, list);
  }
  return deliveries.map((d) => ({ ...toDelivery(d), attempts: byDelivery.get(d.id) ?? [] }));
}
