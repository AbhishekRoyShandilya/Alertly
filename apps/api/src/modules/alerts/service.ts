import {
  ID_PREFIX,
  type AlertEvent,
  type AlertRule,
  type AlertRuleDetail,
  type CreateAlertInput,
  type Evaluation,
  type UpdateAlertInput,
} from '@alertly/shared';
import type { Deps } from '../../context';
import { withTransaction } from '../../db/tx';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import { decodeId, encodeId } from '../../lib/ids';
import { toIsoOrNull } from '../../lib/time';
import { findActiveChannelsByIds } from '../channels/repo';
import type { NotificationsService } from '../notifications/service';
import type { PriceService } from '../prices/service';
import { evaluate, type EvalResult, type RuleState } from './evaluator';
import * as repo from './repo';

const MAX_RULES = 50;

export const toAlertRule = (r: repo.AlertRuleRow): AlertRule => ({
  id: encodeId(ID_PREFIX.alert, r.id),
  name: r.name,
  symbol: r.symbol,
  provider: r.provider,
  conditionType: r.condition_type,
  threshold: r.threshold,
  windowMinutes: r.window_minutes,
  cooldownMinutes: r.cooldown_minutes,
  state: r.state,
  lastPrice: r.last_price,
  lastTriggeredAt: toIsoOrNull(r.last_triggered_at),
  isActive: Boolean(r.is_active),
  channelIds: repo.parseChannelIds(r.channel_ids).map((id) => encodeId(ID_PREFIX.channel, id)),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toAlertEvent = (e: repo.AlertEventRow): AlertEvent => ({
  id: encodeId(ID_PREFIX.alertEvent, e.id),
  price: e.price,
  conditionType: e.condition_type,
  threshold: e.threshold,
  triggeredAt: e.triggered_at.toISOString(),
  notificationId: e.notification_id ? encodeId(ID_PREFIX.notification, e.notification_id) : null,
});

export const toRuleState = (r: repo.AlertRuleRow): RuleState => ({
  symbol: r.symbol,
  conditionType: r.condition_type,
  threshold: r.threshold,
  windowMinutes: r.window_minutes,
  cooldownMinutes: r.cooldown_minutes,
  state: r.state,
  lastPrice: r.last_price,
  lastTriggeredAt: r.last_triggered_at,
});

/** One idempotency key per rule per minute: a restarted scheduler can't double-notify. */
export const alertIdempotencyKey = (ruleId: number, now: Date) =>
  `alert:${ruleId}:${Math.floor(now.getTime() / 60_000)}`;

export function createAlertsService(
  { db, clock, log }: Deps,
  { notifications, prices }: { notifications: NotificationsService; prices: PriceService },
) {
  async function getOwned(userId: number, id: number) {
    const row = await repo.findRule(db, userId, id);
    if (!row) throw notFound('Alert rule');
    return row;
  }

  async function assertChannels(userId: number, ids: number[]) {
    const unique = [...new Set(ids)];
    const found = await findActiveChannelsByIds(db, userId, unique);
    if (found.length !== unique.length) {
      throw validationError('channelIds: every channel must exist, be yours and be active');
    }
    return unique;
  }

  /** Reference price for pct_move: the recorded price `windowMinutes` ago. */
  async function refPriceFor(r: repo.AlertRuleRow, now: Date): Promise<number | null> {
    if (r.condition_type !== 'pct_move' || !r.window_minutes) return null;
    return prices.priceAt(
      r.provider,
      r.symbol,
      new Date(now.getTime() - r.window_minutes * 60_000),
    );
  }

  return {
    async create(
      userId: number,
      input: CreateAlertInput,
      channelIds: number[],
    ): Promise<AlertRule> {
      if ((await repo.countRules(db, userId)) >= MAX_RULES) {
        throw conflict(`At most ${MAX_RULES} alert rules per account`);
      }
      const ids = await assertChannels(userId, channelIds);
      const id = await withTransaction(db, async (conn) => {
        const ruleId = await repo.insertRule(conn, {
          userId,
          name: input.name,
          symbol: input.symbol,
          provider: input.provider,
          conditionType: input.conditionType,
          threshold: input.threshold,
          windowMinutes: input.conditionType === 'pct_move' ? (input.windowMinutes ?? null) : null,
          cooldownMinutes: input.cooldownMinutes,
        });
        await repo.setRuleChannels(conn, ruleId, ids);
        return ruleId;
      });
      return toAlertRule((await repo.findRule(db, userId, id))!);
    },

    list: async (userId: number) => (await repo.listRules(db, userId)).map(toAlertRule),

    async get(userId: number, id: number): Promise<AlertRuleDetail> {
      const row = await getOwned(userId, id);
      const events = await repo.listEvents(db, id);
      return { ...toAlertRule(row), events: events.map(toAlertEvent) };
    },

    async update(
      userId: number,
      id: number,
      input: UpdateAlertInput,
      channelIds?: number[],
    ): Promise<AlertRule> {
      const row = await getOwned(userId, id);
      if (row.condition_type === 'pct_move' && input.threshold !== undefined) {
        if (input.threshold < 0.1 || input.threshold > 100) {
          throw validationError(
            'threshold: pct_move threshold is a percentage between 0.1 and 100',
          );
        }
      }
      if (row.condition_type === 'pct_move' && input.windowMinutes === null) {
        throw validationError('windowMinutes: required for pct_move');
      }
      const ids = channelIds ? await assertChannels(userId, channelIds) : undefined;
      // Changing the condition, or resuming a paused rule, starts the state machine fresh.
      const resetState =
        input.threshold !== undefined ||
        input.windowMinutes !== undefined ||
        (input.isActive === true && !row.is_active);
      await withTransaction(db, async (conn) => {
        await repo.updateRule(conn, id, {
          name: input.name,
          threshold: input.threshold,
          windowMinutes: row.condition_type === 'pct_move' ? input.windowMinutes : undefined,
          cooldownMinutes: input.cooldownMinutes,
          isActive: input.isActive,
          resetState,
        });
        if (ids) await repo.setRuleChannels(conn, id, ids);
      });
      return toAlertRule((await repo.findRule(db, userId, id))!);
    },

    async remove(userId: number, id: number): Promise<void> {
      const r = await repo.deleteRule(db, userId, id);
      if (r.affectedRows === 0) throw notFound('Alert rule');
    },

    /** "Would this fire at the current price?" Evaluates without saving or notifying. */
    async dryRun(userId: number, id: number): Promise<Evaluation> {
      const row = await getOwned(userId, id);
      const now = clock.now();
      let price = (await prices.latestSnapshot(row.provider, row.symbol))?.price;
      if (price === undefined) {
        price = (await prices.getLatest(row.provider, [row.symbol]))[row.symbol];
      }
      if (price === undefined) throw notFound(`Price for ${row.symbol}`);
      const result = evaluate(toRuleState(row), price, now, await refPriceFor(row, now));
      return { price, ...result };
    },

    refPriceFor,

    /**
     * Called by the scheduler for every rule on every tick.
     * On fire: create the notification FIRST (idempotent per rule-minute), then save the new
     * state and the event. If we crash between the two, the next tick fires again, and within
     * the same minute the idempotency key turns that into a harmless replay.
     * If the notification can't be created (no active channels, quota reached), the trigger
     * is still recorded so the rule doesn't retry and spam the logs every 15 seconds.
     */
    async applyEvaluation(
      rule: repo.AlertRuleRow,
      result: EvalResult,
      price: number,
    ): Promise<void> {
      const now = clock.now();
      if (!result.fire) {
        await repo.saveEvaluation(db, rule.id, { state: result.nextState, lastPrice: price });
        return;
      }

      let notificationId: number | null = null;
      try {
        const { notification } = await notifications.create(
          rule.user_id,
          {
            title: `Alert: ${rule.name}`,
            body: result.reason,
            data: {
              ruleId: encodeId(ID_PREFIX.alert, rule.id),
              symbol: rule.symbol,
              provider: rule.provider,
              price,
              condition: rule.condition_type,
              threshold: rule.threshold,
            },
            channelIds: repo.parseChannelIds(rule.channel_ids),
            priority: 'high',
          },
          { source: 'alert', idempotencyKey: alertIdempotencyKey(rule.id, now) },
        );
        notificationId = decodeId(ID_PREFIX.notification, notification.id);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        log.warn(
          { ruleId: rule.id, err: err.detail },
          'alert fired but notification was not created',
        );
      }

      await withTransaction(db, async (conn) => {
        await repo.saveEvaluation(conn, rule.id, {
          state: result.nextState,
          lastPrice: price,
          lastTriggeredAt: now,
        });
        await repo.insertEvent(conn, {
          ruleId: rule.id,
          price,
          conditionType: rule.condition_type,
          threshold: rule.threshold,
          at: now,
          notificationId,
        });
      });
      log.info({ ruleId: rule.id, price, reason: result.reason }, 'alert fired');
    },
  };
}
export type AlertsService = ReturnType<typeof createAlertsService>;
