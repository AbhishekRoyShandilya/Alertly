import {
  EmailConfig,
  ID_PREFIX,
  TelegramConfig,
  WebhookConfig,
  type Channel,
  type ChannelType,
  type ChannelWithSecret,
  type CreateChannelInput,
  type UpdateChannelInput,
} from '@alertly/shared';
import type { z } from 'zod';
import type { Deps } from '../../context';
import { withTransaction } from '../../db/tx';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { decryptSecret, encryptSecret, generateWebhookSecret } from '../../lib/crypto';
import { encodeId } from '../../lib/ids';
import { assertPublicHttpUrl } from '../../lib/net-guard';
import { toIsoOrNull } from '../../lib/time';
import { parse } from '../../middleware/validate';
import type { NotificationsService } from '../notifications/service';
import * as repo from './repo';

const MAX_CHANNELS = 50;

const CONFIG_SCHEMA: Record<ChannelType, z.ZodType<Record<string, unknown>>> = {
  email: EmailConfig,
  webhook: WebhookConfig,
  telegram: TelegramConfig,
};

export const toChannel = (r: repo.ChannelRow): Channel => ({
  id: encodeId(ID_PREFIX.channel, r.id),
  type: r.type,
  name: r.name,
  config: r.config,
  status: r.status,
  verifiedAt: toIsoOrNull(r.verified_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export function createChannelsService(
  { db, env, clock }: Deps,
  { notifications }: { notifications: NotificationsService },
) {
  const guardOpts = { allowPrivate: env.WEBHOOK_ALLOW_PRIVATE, requireHttps: env.isProd };

  async function getOwned(userId: number, id: number): Promise<repo.ChannelRow> {
    const row = await repo.findChannel(db, userId, id);
    if (!row) throw notFound('Channel');
    return row;
  }

  function newSecret(): { plain: string; enc: Buffer } {
    const plain = generateWebhookSecret();
    return { plain, enc: encryptSecret(plain, env.encryptionKey) };
  }

  return {
    async create(userId: number, input: CreateChannelInput): Promise<ChannelWithSecret> {
      if ((await repo.countChannels(db, userId)) >= MAX_CHANNELS) {
        throw conflict(`At most ${MAX_CHANNELS} channels per account`);
      }
      let secret: { plain: string; enc: Buffer } | null = null;
      if (input.type === 'webhook') {
        await assertPublicHttpUrl(input.config.url, guardOpts);
        secret = newSecret();
      }
      const id = await repo.insertChannel(db, {
        userId,
        type: input.type,
        name: input.name,
        config: input.config,
        secretEnc: secret?.enc ?? null,
      });
      const row = await getOwned(userId, id);
      // The signing secret is shown exactly once, here.
      return { ...toChannel(row), ...(secret ? { secret: secret.plain } : {}) };
    },

    list: async (userId: number) => (await repo.listChannels(db, userId)).map(toChannel),

    get: async (userId: number, id: number) => toChannel(await getOwned(userId, id)),

    async update(userId: number, id: number, input: UpdateChannelInput): Promise<Channel> {
      const row = await getOwned(userId, id);
      let config: Record<string, unknown> | undefined;
      if (input.config !== undefined) {
        // The config shape depends on the channel's type, which can't change.
        config = parse(CONFIG_SCHEMA[row.type], input.config);
        if (row.type === 'webhook') await assertPublicHttpUrl(String(config.url), guardOpts);
      }
      await repo.updateChannel(db, id, {
        name: input.name,
        config,
        status: input.status,
        clearVerified: config !== undefined, // a new address must be verified again
      });
      return toChannel(await getOwned(userId, id));
    },

    /**
     * Soft delete: the row stays so past deliveries keep pointing at a real channel.
     * Refused while an active alert rule still sends to it (it would silently lose a target).
     */
    async remove(userId: number, id: number): Promise<void> {
      await getOwned(userId, id);
      const inUse = await repo.countActiveRulesUsing(db, id);
      if (inUse > 0) {
        throw conflict(
          `Channel is used by ${inUse} active alert rule(s); pause or edit them first`,
        );
      }
      await withTransaction(db, async (conn) => {
        await repo.unlinkFromRules(conn, id);
        await repo.softDeleteChannel(conn, id, clock.now());
      });
    },

    async rotateSecret(userId: number, id: number): Promise<ChannelWithSecret> {
      const row = await getOwned(userId, id);
      if (row.type !== 'webhook') throw badRequest('Only webhook channels have a signing secret');
      const secret = newSecret();
      await repo.setSecret(db, id, secret.enc);
      return { ...toChannel(row), secret: secret.plain };
    },

    /** Used by the webhook sender. Decrypts on demand; the plain secret is never stored. */
    decryptSecret(row: Pick<repo.ChannelRow, 'secret_enc'>): string | null {
      return row.secret_enc ? decryptSecret(row.secret_enc, env.encryptionKey) : null;
    },

    /**
     * Sends a test notification to this one channel. Returns its id so the UI can poll
     * GET /notifications/:id until the delivery reaches a final state.
     */
    async sendTest(userId: number, id: number): Promise<{ notificationId: string }> {
      const row = await getOwned(userId, id);
      if (row.status !== 'active') throw conflict('Channel is disabled; enable it first');
      const { notification } = await notifications.create(
        userId,
        {
          title: 'Test notification from Alertly',
          body: `If you can read this, your ${row.type} channel "${row.name}" works.`,
          channelIds: [id],
          priority: 'high',
        },
        { source: 'test' },
      );
      return { notificationId: notification.id };
    },
  };
}
export type ChannelsService = ReturnType<typeof createChannelsService>;
