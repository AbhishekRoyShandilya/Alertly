import type { ChannelType } from '@alertly/shared';
import { exec, query, queryOne, type Queryable } from '../../db/pool';

export interface ChannelRow {
  id: number;
  user_id: number;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>; // mysql2 parses JSON columns into objects
  secret_enc: Buffer | null;
  status: 'active' | 'disabled';
  verified_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Every read filters out soft-deleted channels.
const LIVE = 'deleted_at IS NULL';

export async function insertChannel(
  db: Queryable,
  c: { userId: number; type: ChannelType; name: string; config: object; secretEnc: Buffer | null },
): Promise<number> {
  const r = await exec(
    db,
    'INSERT INTO channels (user_id, type, name, config, secret_enc) VALUES (?, ?, ?, ?, ?)',
    [c.userId, c.type, c.name, JSON.stringify(c.config), c.secretEnc],
  );
  return r.insertId;
}

export const listChannels = (db: Queryable, userId: number) =>
  query<ChannelRow>(
    db,
    `SELECT * FROM channels WHERE user_id = ? AND ${LIVE} ORDER BY created_at DESC, id DESC LIMIT 200`,
    [userId],
  );

export const countChannels = async (db: Queryable, userId: number) =>
  (
    await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM channels WHERE user_id = ? AND ${LIVE}`,
      [userId],
    )
  )?.n ?? 0;

export const findChannel = (db: Queryable, userId: number, id: number) =>
  queryOne<ChannelRow>(db, `SELECT * FROM channels WHERE id = ? AND user_id = ? AND ${LIVE}`, [
    id,
    userId,
  ]);

/** Active channels among `ids` that belong to the user. Used to resolve notification targets. */
export const findActiveChannelsByIds = (db: Queryable, userId: number, ids: number[]) =>
  ids.length === 0
    ? Promise.resolve([] as ChannelRow[])
    : query<ChannelRow>(
        db,
        `SELECT * FROM channels WHERE user_id = ? AND id IN (?) AND status = 'active' AND ${LIVE}`,
        [userId, ids],
      );

export const listActiveChannels = (db: Queryable, userId: number) =>
  query<ChannelRow>(
    db,
    `SELECT * FROM channels WHERE user_id = ? AND status = 'active' AND ${LIVE} ORDER BY id`,
    [userId],
  );

export async function updateChannel(
  db: Queryable,
  id: number,
  fields: { name?: string; config?: object; status?: string; clearVerified?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (sql: string, value: unknown) => {
    sets.push(sql);
    params.push(value);
  };
  if (fields.name !== undefined) set('name = ?', fields.name);
  if (fields.config !== undefined) set('config = ?', JSON.stringify(fields.config));
  if (fields.status !== undefined) set('status = ?', fields.status);
  if (fields.clearVerified) sets.push('verified_at = NULL');
  if (sets.length === 0) return;
  await exec(db, `UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export const setSecret = (db: Queryable, id: number, secretEnc: Buffer) =>
  exec(db, 'UPDATE channels SET secret_enc = ? WHERE id = ?', [secretEnc, id]);

export const softDeleteChannel = (db: Queryable, id: number, now: Date) =>
  exec(db, "UPDATE channels SET deleted_at = ?, status = 'disabled' WHERE id = ?", [now, id]);

/** First successful delivery proves the channel works. */
export const markVerified = (db: Queryable, id: number, now: Date) =>
  exec(db, 'UPDATE channels SET verified_at = ? WHERE id = ? AND verified_at IS NULL', [now, id]);

export const countActiveRulesUsing = async (db: Queryable, channelId: number) =>
  (
    await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM alert_rule_channels arc
         JOIN alert_rules r ON r.id = arc.rule_id
        WHERE arc.channel_id = ? AND r.is_active = TRUE`,
      [channelId],
    )
  )?.n ?? 0;

export const unlinkFromRules = (db: Queryable, channelId: number) =>
  exec(db, 'DELETE FROM alert_rule_channels WHERE channel_id = ?', [channelId]);
