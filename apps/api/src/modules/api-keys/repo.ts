import { exec, query, queryOne, type Queryable } from '../../db/pool';

export interface ApiKeyRow {
  id: number;
  user_id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export async function insertApiKey(
  db: Queryable,
  k: { userId: number; name: string; prefix: string; hash: string },
): Promise<number> {
  const r = await exec(
    db,
    'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)',
    [k.userId, k.name, k.prefix, k.hash],
  );
  return r.insertId;
}

export const listApiKeys = (db: Queryable, userId: number) =>
  query<ApiKeyRow>(
    db,
    'SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId],
  );

export const findApiKey = (db: Queryable, userId: number, id: number) =>
  queryOne<ApiKeyRow>(db, 'SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [id, userId]);

export const countActiveApiKeys = async (db: Queryable, userId: number) =>
  (
    await queryOne<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    )
  )?.n ?? 0;

export const revokeApiKey = (db: Queryable, userId: number, id: number, now: Date) =>
  exec(
    db,
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    [now, id, userId],
  );

/** The auth hot path: served by the UNIQUE index on key_hash (one index lookup). */
export const findActiveByHash = (db: Queryable, hash: string) =>
  queryOne<Pick<ApiKeyRow, 'id' | 'user_id'>>(
    db,
    'SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
    [hash],
  );

/** Conditional update: a no-op if last_used_at was already refreshed within the last minute. */
export const touchLastUsed = (db: Queryable, id: number, now: Date) =>
  exec(
    db,
    'UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
    [now, id, new Date(now.getTime() - 60_000)],
  );
