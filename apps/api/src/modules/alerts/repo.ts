import type { AlertState, ConditionType, PriceProviderName } from '@alertly/shared';
import { exec, query, queryOne, type Queryable } from '../../db/pool';

export interface AlertRuleRow {
  id: number;
  user_id: number;
  name: string;
  symbol: string;
  provider: PriceProviderName;
  condition_type: ConditionType;
  threshold: number;
  window_minutes: number | null;
  cooldown_minutes: number;
  state: AlertState;
  last_price: number | null;
  last_triggered_at: Date | null;
  is_active: number; // MySQL BOOLEAN is TINYINT(1)
  created_at: Date;
  updated_at: Date;
  channel_ids: string | null; // GROUP_CONCAT of channel ids
}

export interface AlertEventRow {
  id: number;
  rule_id: number;
  price: number;
  condition_type: ConditionType;
  threshold: number;
  triggered_at: Date;
  notification_id: number | null;
}

// Rules with their channel ids aggregated in the same query (no N+1).
const SELECT_RULE = `
  SELECT r.*, GROUP_CONCAT(arc.channel_id ORDER BY arc.channel_id) AS channel_ids
    FROM alert_rules r
    LEFT JOIN alert_rule_channels arc ON arc.rule_id = r.id`;

export const parseChannelIds = (s: string | null): number[] => (s ? s.split(',').map(Number) : []);

export async function insertRule(
  db: Queryable,
  r: {
    userId: number;
    name: string;
    symbol: string;
    provider: PriceProviderName;
    conditionType: ConditionType;
    threshold: number;
    windowMinutes: number | null;
    cooldownMinutes: number;
  },
): Promise<number> {
  const res = await exec(
    db,
    `INSERT INTO alert_rules
       (user_id, name, symbol, provider, condition_type, threshold, window_minutes, cooldown_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.userId,
      r.name,
      r.symbol,
      r.provider,
      r.conditionType,
      r.threshold,
      r.windowMinutes,
      r.cooldownMinutes,
    ],
  );
  return res.insertId;
}

export async function setRuleChannels(db: Queryable, ruleId: number, channelIds: number[]) {
  await exec(db, 'DELETE FROM alert_rule_channels WHERE rule_id = ?', [ruleId]);
  if (channelIds.length > 0) {
    await exec(db, 'INSERT INTO alert_rule_channels (rule_id, channel_id) VALUES ?', [
      channelIds.map((c) => [ruleId, c]),
    ]);
  }
}

export const listRules = (db: Queryable, userId: number) =>
  query<AlertRuleRow>(
    db,
    `${SELECT_RULE} WHERE r.user_id = ? GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC LIMIT 200`,
    [userId],
  );

export const findRule = (db: Queryable, userId: number, id: number) =>
  queryOne<AlertRuleRow>(db, `${SELECT_RULE} WHERE r.id = ? AND r.user_id = ? GROUP BY r.id`, [
    id,
    userId,
  ]);

export const countRules = async (db: Queryable, userId: number) =>
  (
    await queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM alert_rules WHERE user_id = ?', [
      userId,
    ])
  )?.n ?? 0;

/** Every active rule, for the scheduler. Served by INDEX (is_active, provider, symbol). */
export const listActiveRules = (db: Queryable) =>
  query<AlertRuleRow>(db, `${SELECT_RULE} WHERE r.is_active = TRUE GROUP BY r.id ORDER BY r.id`);

export async function updateRule(
  db: Queryable,
  id: number,
  f: {
    name?: string;
    threshold?: number;
    windowMinutes?: number | null;
    cooldownMinutes?: number;
    isActive?: boolean;
    resetState?: boolean;
  },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (sql: string, v: unknown) => {
    sets.push(sql);
    params.push(v);
  };
  if (f.name !== undefined) set('name = ?', f.name);
  if (f.threshold !== undefined) set('threshold = ?', f.threshold);
  if (f.windowMinutes !== undefined) set('window_minutes = ?', f.windowMinutes);
  if (f.cooldownMinutes !== undefined) set('cooldown_minutes = ?', f.cooldownMinutes);
  if (f.isActive !== undefined) set('is_active = ?', f.isActive);
  if (f.resetState) sets.push("state = 'armed'", 'last_price = NULL');
  if (sets.length === 0) return;
  await exec(db, `UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export const deleteRule = (db: Queryable, userId: number, id: number) =>
  exec(db, 'DELETE FROM alert_rules WHERE id = ? AND user_id = ?', [id, userId]);

/** The scheduler's write after each evaluation. */
export const saveEvaluation = (
  db: Queryable,
  id: number,
  s: { state: AlertState; lastPrice: number; lastTriggeredAt?: Date },
) =>
  s.lastTriggeredAt
    ? exec(
        db,
        'UPDATE alert_rules SET state = ?, last_price = ?, last_triggered_at = ? WHERE id = ?',
        [s.state, s.lastPrice, s.lastTriggeredAt, id],
      )
    : exec(db, 'UPDATE alert_rules SET state = ?, last_price = ? WHERE id = ?', [
        s.state,
        s.lastPrice,
        id,
      ]);

export async function insertEvent(
  db: Queryable,
  e: {
    ruleId: number;
    price: number;
    conditionType: ConditionType;
    threshold: number;
    at: Date;
    notificationId: number | null;
  },
): Promise<number> {
  const r = await exec(
    db,
    `INSERT INTO alert_events (rule_id, price, condition_type, threshold, triggered_at, notification_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [e.ruleId, e.price, e.conditionType, e.threshold, e.at, e.notificationId],
  );
  return r.insertId;
}

export const listEvents = (db: Queryable, ruleId: number, limit = 50) =>
  query<AlertEventRow>(
    db,
    'SELECT * FROM alert_events WHERE rule_id = ? ORDER BY triggered_at DESC, id DESC LIMIT ?',
    [ruleId, limit],
  );
