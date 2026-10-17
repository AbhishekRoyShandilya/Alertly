import { z } from 'zod';
import { IsoDate, ID_PREFIX, publicId } from './common';

export const PRICE_PROVIDERS = ['simulated', 'coingecko', 'binance'] as const;
export type PriceProviderName = (typeof PRICE_PROVIDERS)[number];

/** Symbols the price providers know how to map. Kept small on purpose. */
export const SUPPORTED_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
] as const;
export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

export const CONDITION_TYPES = [
  'above',
  'below',
  'cross_above',
  'cross_below',
  'pct_move',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const ALERT_STATES = ['armed', 'triggered', 'cooldown'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

const alertFields = {
  name: z.string().trim().min(1).max(100),
  symbol: z.enum(SUPPORTED_SYMBOLS),
  provider: z.enum(PRICE_PROVIDERS).default('simulated'),
  conditionType: z.enum(CONDITION_TYPES),
  threshold: z.number().positive().max(1e12),
  windowMinutes: z.number().int().min(1).max(1440).nullish(),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(60),
  channelIds: z.array(publicId(ID_PREFIX.channel)).min(1).max(20),
};

/** Cross-field rules that a single field schema can't express. */
function checkThreshold(
  v: { conditionType?: ConditionType; threshold?: number; windowMinutes?: number | null },
  ctx: z.RefinementCtx,
) {
  if (v.conditionType !== 'pct_move') return;
  if (v.threshold !== undefined && (v.threshold < 0.1 || v.threshold > 100)) {
    ctx.addIssue({
      code: 'custom',
      path: ['threshold'],
      message: 'pct_move threshold is a percentage between 0.1 and 100',
    });
  }
  if (!v.windowMinutes) {
    ctx.addIssue({ code: 'custom', path: ['windowMinutes'], message: 'required for pct_move' });
  }
}

export const CreateAlertInput = z
  .object(alertFields)
  .superRefine(checkThreshold)
  .meta({ id: 'CreateAlertInput' });
export type CreateAlertInput = z.infer<typeof CreateAlertInput>;

export const UpdateAlertInput = z
  .object({
    name: alertFields.name.optional(),
    threshold: alertFields.threshold.optional(),
    windowMinutes: alertFields.windowMinutes,
    cooldownMinutes: z.number().int().min(0).max(10_080).optional(),
    channelIds: alertFields.channelIds.optional(),
    isActive: z.boolean().optional(),
  })
  .meta({ id: 'UpdateAlertInput' });
export type UpdateAlertInput = z.infer<typeof UpdateAlertInput>;

export const AlertRule = z
  .object({
    id: publicId(ID_PREFIX.alert),
    name: z.string(),
    symbol: z.string(),
    provider: z.enum(PRICE_PROVIDERS),
    conditionType: z.enum(CONDITION_TYPES),
    threshold: z.number(),
    windowMinutes: z.number().int().nullable(),
    cooldownMinutes: z.number().int(),
    state: z.enum(ALERT_STATES),
    lastPrice: z.number().nullable(),
    lastTriggeredAt: IsoDate.nullable(),
    isActive: z.boolean(),
    channelIds: z.array(publicId(ID_PREFIX.channel)),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'AlertRule' });
export type AlertRule = z.infer<typeof AlertRule>;

export const AlertEvent = z
  .object({
    id: publicId(ID_PREFIX.alertEvent),
    price: z.number(),
    conditionType: z.enum(CONDITION_TYPES),
    threshold: z.number(),
    triggeredAt: IsoDate,
    notificationId: publicId(ID_PREFIX.notification).nullable(),
  })
  .meta({ id: 'AlertEvent' });
export type AlertEvent = z.infer<typeof AlertEvent>;

export const AlertRuleDetail = AlertRule.extend({ events: z.array(AlertEvent) }).meta({
  id: 'AlertRuleDetail',
});
export type AlertRuleDetail = z.infer<typeof AlertRuleDetail>;

export const Evaluation = z
  .object({
    price: z.number(),
    fire: z.boolean(),
    nextState: z.enum(ALERT_STATES),
    reason: z.string(),
  })
  .meta({ id: 'Evaluation' });
export type Evaluation = z.infer<typeof Evaluation>;
