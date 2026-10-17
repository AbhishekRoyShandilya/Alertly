import { z } from 'zod';
import { IsoDate, ID_PREFIX, publicId } from './common';

export const CHANNEL_TYPES = ['email', 'webhook', 'telegram'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EmailConfig = z.object({ to: z.email().max(255) });
export const WebhookConfig = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
export const TelegramConfig = z.object({
  chatId: z
    .string()
    .trim()
    .regex(/^-?\d{1,20}$|^@[A-Za-z0-9_]{5,32}$/, 'numeric chat id or @channelname'),
});

/**
 * A discriminated union: the `type` field decides which config shape is valid.
 * Zod picks the right branch and gives precise error messages.
 */
export const CreateChannelInput = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('email'),
      name: z.string().trim().min(1).max(100),
      config: EmailConfig,
    }),
    z.object({
      type: z.literal('webhook'),
      name: z.string().trim().min(1).max(100),
      config: WebhookConfig,
    }),
    z.object({
      type: z.literal('telegram'),
      name: z.string().trim().min(1).max(100),
      config: TelegramConfig,
    }),
  ])
  .meta({ id: 'CreateChannelInput' });
export type CreateChannelInput = z.infer<typeof CreateChannelInput>;

/** PATCH: every field optional. `config` is re-validated against the channel's type on the server. */
export const UpdateChannelInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .meta({ id: 'UpdateChannelInput' });
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>;

export const Channel = z
  .object({
    id: publicId(ID_PREFIX.channel),
    type: z.enum(CHANNEL_TYPES),
    name: z.string(),
    config: z.record(z.string(), z.unknown()),
    status: z.enum(['active', 'disabled']),
    verifiedAt: IsoDate.nullable(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'Channel' });
export type Channel = z.infer<typeof Channel>;

export const ChannelWithSecret = Channel.extend({
  secret: z
    .string()
    .optional()
    .meta({ description: 'Webhook signing secret. Returned only on create and rotate.' }),
}).meta({ id: 'ChannelWithSecret' });
export type ChannelWithSecret = z.infer<typeof ChannelWithSecret>;

export const ChannelTestResult = z
  .object({ notificationId: publicId(ID_PREFIX.notification) })
  .meta({ id: 'ChannelTestResult' });
