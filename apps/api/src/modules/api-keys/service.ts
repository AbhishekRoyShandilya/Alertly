import { ID_PREFIX, type ApiKey, type ApiKeyCreated } from '@alertly/shared';
import type { Deps } from '../../context';
import { conflict, notFound } from '../../lib/errors';
import { generateApiKey, hashApiKey } from '../../lib/crypto';
import { encodeId } from '../../lib/ids';
import { toIsoOrNull } from '../../lib/time';
import * as repo from './repo';

const MAX_ACTIVE_KEYS = 20;
const TOUCH_INTERVAL_MS = 60_000;

const toApiKey = (r: repo.ApiKeyRow): ApiKey => ({
  id: encodeId(ID_PREFIX.apiKey, r.id),
  name: r.name,
  prefix: r.key_prefix,
  lastUsedAt: toIsoOrNull(r.last_used_at),
  revokedAt: toIsoOrNull(r.revoked_at),
  createdAt: r.created_at.toISOString(),
});

export function createApiKeysService({ db, clock, log }: Deps) {
  // In-memory "when did we last write last_used_at for this key?" so a busy key costs
  // one UPDATE per minute instead of one per request.
  const lastTouched = new Map<number, number>();

  return {
    /** The full key exists only in this response. We keep just its hash. */
    async create(userId: number, name: string): Promise<ApiKeyCreated> {
      if ((await repo.countActiveApiKeys(db, userId)) >= MAX_ACTIVE_KEYS) {
        throw conflict(`At most ${MAX_ACTIVE_KEYS} active API keys; revoke one first`);
      }
      const { key, prefix, hash } = generateApiKey();
      const id = await repo.insertApiKey(db, { userId, name, prefix, hash });
      return { id: encodeId(ID_PREFIX.apiKey, id), name, prefix, key };
    },

    list: async (userId: number) => (await repo.listApiKeys(db, userId)).map(toApiKey),

    /**
     * 404 (not 403) when the key belongs to someone else: we don't even confirm it exists.
     * Revoking an already-revoked key is a no-op success (idempotent DELETE).
     */
    async revoke(userId: number, id: number): Promise<void> {
      const key = await repo.findApiKey(db, userId, id);
      if (!key) throw notFound('API key');
      await repo.revokeApiKey(db, userId, id, clock.now());
    },

    /** Used by the auth middleware for `Authorization: Bearer alr_…`. */
    async authenticate(key: string): Promise<{ apiKeyId: number; userId: number } | null> {
      const row = await repo.findActiveByHash(db, hashApiKey(key));
      if (!row) return null;

      const now = clock.now();
      const last = lastTouched.get(row.id) ?? 0;
      if (now.getTime() - last >= TOUCH_INTERVAL_MS) {
        lastTouched.set(row.id, now.getTime());
        // Fire and forget: a failed bookkeeping write must not fail the caller's request.
        repo
          .touchLastUsed(db, row.id, now)
          .catch((err: unknown) => log.warn({ err }, 'touchLastUsed failed'));
      }
      return { apiKeyId: row.id, userId: row.user_id };
    },
  };
}
export type ApiKeysService = ReturnType<typeof createApiKeysService>;
