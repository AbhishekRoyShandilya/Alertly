import { z } from 'zod';
import { IsoDate, ID_PREFIX, publicId } from './common';
import { CHANNEL_TYPES } from './channels';

export const NOTIFICATION_SOURCES = ['api', 'alert', 'test'] as const;
export const PRIORITIES = ['normal', 'high'] as const;
export const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'retrying',
  'delivered',
  'failed',
  'dead',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const ATTEMPT_OUTCOMES = ['success', 'retryable_error', 'permanent_error'] as const;

export const CreateNotificationInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(4000).default(''),
    data: z.record(z.string(), z.unknown()).optional(),
    channelIds: z.array(publicId(ID_PREFIX.channel)).min(1).max(20).optional(),
    priority: z.enum(PRIORITIES).default('normal'),
  })
  .meta({ id: 'CreateNotificationInput' });
export type CreateNotificationInput = z.infer<typeof CreateNotificationInput>;

export const IDEMPOTENCY_KEY_MAX = 128;

export const Notification = z
  .object({
    id: publicId(ID_PREFIX.notification),
    source: z.enum(NOTIFICATION_SOURCES),
    title: z.string(),
    body: z.string(),
    data: z.record(z.string(), z.unknown()).nullable(),
    priority: z.enum(PRIORITIES),
    createdAt: IsoDate,
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof Notification>;

export const DeliveryAttempt = z
  .object({
    attemptNo: z.number().int(),
    startedAt: IsoDate,
    finishedAt: IsoDate,
    durationMs: z.number().int(),
    outcome: z.enum(ATTEMPT_OUTCOMES),
    httpStatus: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'DeliveryAttempt' });
export type DeliveryAttempt = z.infer<typeof DeliveryAttempt>;

export const Delivery = z
  .object({
    id: publicId(ID_PREFIX.delivery),
    notificationId: publicId(ID_PREFIX.notification),
    channelId: publicId(ID_PREFIX.channel),
    channelName: z.string(),
    channelType: z.enum(CHANNEL_TYPES),
    status: z.enum(DELIVERY_STATUSES),
    attemptCount: z.number().int(),
    maxAttempts: z.number().int(),
    nextAttemptAt: IsoDate.nullable(),
    lastError: z.string().nullable(),
    deliveredAt: IsoDate.nullable(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'Delivery' });
export type Delivery = z.infer<typeof Delivery>;

export const DeliveryWithAttempts = Delivery.extend({
  attempts: z.array(DeliveryAttempt),
}).meta({ id: 'DeliveryWithAttempts' });
export type DeliveryWithAttempts = z.infer<typeof DeliveryWithAttempts>;

export const NotificationDetail = Notification.extend({
  deliveries: z.array(DeliveryWithAttempts),
}).meta({ id: 'NotificationDetail' });
export type NotificationDetail = z.infer<typeof NotificationDetail>;

export const ListNotificationsQuery = z.object({
  source: z.enum(NOTIFICATION_SOURCES).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const DeliveryStats = z
  .object({
    since: IsoDate,
    counts: z.record(z.enum(DELIVERY_STATUSES), z.number().int()),
    /** delivered / (delivered + failed + dead), or null when nothing finished yet. */
    successRate: z.number().nullable(),
  })
  .meta({ id: 'DeliveryStats' });
export type DeliveryStats = z.infer<typeof DeliveryStats>;

export const ListDeliveriesQuery = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  channelId: publicId(ID_PREFIX.channel).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
