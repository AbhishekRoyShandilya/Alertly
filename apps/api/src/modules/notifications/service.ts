import { ID_PREFIX, type Notification, type NotificationDetail, type Page } from '@alertly/shared';
import type { Deps } from '../../context';
import { withTransaction } from '../../db/tx';
import { conflict, isDbError, notFound, tooManyRequests, validationError } from '../../lib/errors';
import { sha256, stableStringify } from '../../lib/crypto';
import { encodeId } from '../../lib/ids';
import { toPage } from '../../lib/pagination';
import { incrementUsage, notificationsToday } from '../usage/service';
import { findActiveChannelsByIds, listActiveChannels } from '../channels/repo';
import { listAttemptsForDeliveries, listDeliveriesForNotifications } from '../deliveries/repo';
import { withAttempts } from '../deliveries/mappers';
import * as repo from './repo';

export interface CreateNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Internal numeric channel ids. Omitted = every active channel of the user. */
  channelIds?: number[];
  priority: 'normal' | 'high';
}

export interface CreateOptions {
  source: repo.NotificationRow['source'];
  idempotencyKey?: string;
}

export const toNotification = (r: repo.NotificationRow): Notification => ({
  id: encodeId(ID_PREFIX.notification, r.id),
  source: r.source,
  title: r.title,
  body: r.body,
  data: r.data,
  priority: r.priority,
  createdAt: r.created_at.toISOString(),
});

export function createNotificationsService({ db, env, clock }: Deps) {
  /** Same key + same body → replay the original. Same key + different body → 409. */
  function replayOrConflict(existing: repo.NotificationRow, requestHash: string) {
    if (existing.request_hash !== requestHash) {
      throw conflict('Idempotency-Key was already used with a different request body');
    }
    return { notification: toNotification(existing), replayed: true };
  }

  return {
    /**
     * The most important function in the project. Creates a notification and its
     * deliveries atomically ("transactional outbox"): either both exist or neither does,
     * so a crash can never leave a notification that will silently never be delivered.
     */
    async create(
      userId: number,
      input: CreateNotification,
      opts: CreateOptions,
    ): Promise<{ notification: Notification; replayed: boolean }> {
      const now = clock.now();
      const key = opts.idempotencyKey ?? null;
      const requestHash = sha256(stableStringify(input));

      // 1. Fast path for retries: the key was already used.
      if (key) {
        const existing = await repo.findByIdempotencyKey(db, userId, key);
        if (existing) return replayOrConflict(existing, requestHash);
      }

      // 2. Resolve target channels (must be the user's own, active channels).
      const channels = input.channelIds
        ? await findActiveChannelsByIds(db, userId, [...new Set(input.channelIds)])
        : await listActiveChannels(db, userId);
      if (input.channelIds) {
        const found = new Set(channels.map((c) => c.id));
        const missing = input.channelIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          const ids = missing.map((id) => encodeId(ID_PREFIX.channel, id)).join(', ');
          throw validationError(`channelIds: not found or disabled: ${ids}`);
        }
      }
      if (channels.length === 0) {
        throw validationError('No active channels to deliver to. Add a channel first.');
      }

      // 3. Daily quota (a soft limit: concurrent requests may overshoot by a few).
      if ((await notificationsToday(db, userId, now)) >= env.DAILY_NOTIFICATION_QUOTA) {
        const midnight = new Date(now);
        midnight.setUTCHours(24, 0, 0, 0);
        throw tooManyRequests(
          (midnight.getTime() - now.getTime()) / 1000,
          `Daily quota of ${env.DAILY_NOTIFICATION_QUOTA} notifications reached`,
        );
      }

      // 4. One transaction: notification + one delivery per channel + usage counters.
      try {
        const id = await withTransaction(db, async (conn) => {
          const notificationId = await repo.insertNotification(conn, {
            userId,
            idempotencyKey: key,
            requestHash: key ? requestHash : null,
            source: opts.source,
            title: input.title,
            body: input.body,
            data: input.data ?? null,
            priority: input.priority,
            createdAt: now,
          });
          await repo.insertDeliveries(
            conn,
            channels.map((c) => ({
              userId,
              notificationId,
              channelId: c.id,
              priority: input.priority === 'high' ? 1 : 0,
              dueAt: now, // due immediately; the worker picks it up within a second
            })),
          );
          await incrementUsage(conn, userId, 'notifications', now);
          await incrementUsage(conn, userId, 'deliveries', now, channels.length);
          return notificationId;
        });
        return {
          notification: toNotification((await repo.findNotification(db, userId, id))!),
          replayed: false,
        };
      } catch (err) {
        // Two requests with the same key raced past step 1. The UNIQUE index let exactly one
        // insert win; the loser lands here and replays the winner's notification.
        if (key && isDbError(err, 'ER_DUP_ENTRY')) {
          const existing = await repo.findByIdempotencyKey(db, userId, key);
          if (existing) return replayOrConflict(existing, requestHash);
        }
        throw err;
      }
    },

    async list(
      userId: number,
      filters: repo.NotificationFilters,
      limit: number,
      cursor?: string,
    ): Promise<Page<Notification>> {
      const rows = await repo.listNotifications(db, userId, filters, limit, cursor);
      return toPage(rows, limit, toNotification);
    },

    /** Notification + deliveries + attempts in 3 queries total, however many deliveries. */
    async getWithTimeline(userId: number, id: number): Promise<NotificationDetail> {
      const n = await repo.findNotification(db, userId, id);
      if (!n) throw notFound('Notification');
      const deliveries = await listDeliveriesForNotifications(db, [n.id]);
      const attempts = await listAttemptsForDeliveries(
        db,
        deliveries.map((d) => d.id),
      );
      return { ...toNotification(n), deliveries: withAttempts(deliveries, attempts) };
    },
  };
}
export type NotificationsService = ReturnType<typeof createNotificationsService>;
