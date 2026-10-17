import type { UsageDay } from '@alertly/shared';
import type { Deps } from '../../context';
import { exec, query, queryOne, type Queryable } from '../../db/pool';
import { utcDay } from '../../lib/time';

export type UsageField = 'api_requests' | 'notifications' | 'deliveries';
// Column names can't be `?` placeholders, so they come only from this fixed list.
const FIELDS: ReadonlySet<UsageField> = new Set(['api_requests', 'notifications', 'deliveries']);

interface UsageRow {
  day: Date;
  api_requests: number;
  notifications: number;
  deliveries: number;
}

/**
 * One row per (user, day). INSERT ... ON DUPLICATE KEY UPDATE is an atomic "upsert":
 * the first event of the day inserts the row, later ones increment it, and two concurrent
 * requests can't lose an update (no read-modify-write in application code).
 */
export async function incrementUsage(
  db: Queryable,
  userId: number,
  field: UsageField,
  now: Date,
  by = 1,
): Promise<void> {
  if (!FIELDS.has(field)) throw new Error(`unknown usage field ${field}`);
  await exec(
    db,
    `INSERT INTO usage_daily (user_id, day, ${field}) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${field} = ${field} + VALUES(${field})`,
    [userId, utcDay(now), by],
  );
}

export async function notificationsToday(
  db: Queryable,
  userId: number,
  now: Date,
): Promise<number> {
  const row = await queryOne<{ notifications: number }>(
    db,
    'SELECT notifications FROM usage_daily WHERE user_id = ? AND day = ?',
    [userId, utcDay(now)],
  );
  return row?.notifications ?? 0;
}

export function createUsageService({ db, clock, env }: Deps) {
  return {
    increment: (userId: number, field: UsageField, by = 1) =>
      incrementUsage(db, userId, field, clock.now(), by),

    async get(
      userId: number,
      days: number,
    ): Promise<{ dailyNotificationQuota: number; days: UsageDay[] }> {
      const since = new Date(clock.now().getTime() - (days - 1) * 86_400_000);
      const rows = await query<UsageRow>(
        db,
        `SELECT day, api_requests, notifications, deliveries FROM usage_daily
          WHERE user_id = ? AND day >= ? ORDER BY day`,
        [userId, utcDay(since)],
      );
      return {
        dailyNotificationQuota: env.DAILY_NOTIFICATION_QUOTA,
        days: rows.map((r) => ({
          day: utcDay(r.day),
          apiRequests: r.api_requests,
          notifications: r.notifications,
          deliveries: r.deliveries,
        })),
      };
    },
  };
}
export type UsageService = ReturnType<typeof createUsageService>;
