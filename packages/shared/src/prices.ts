import { z } from 'zod';
import { IsoDate } from './common';
import { PRICE_PROVIDERS } from './alerts';

export const PricePoint = z.object({ price: z.number(), observedAt: IsoDate });
export type PricePoint = z.infer<typeof PricePoint>;

export const PriceResponse = z
  .object({
    symbol: z.string(),
    provider: z.enum(PRICE_PROVIDERS),
    price: z.number(),
    observedAt: IsoDate,
    history: z.array(PricePoint),
  })
  .meta({ id: 'PriceResponse' });
export type PriceResponse = z.infer<typeof PriceResponse>;

export const UsageDay = z
  .object({
    day: z.string().meta({ example: '2026-10-16' }),
    apiRequests: z.number().int(),
    notifications: z.number().int(),
    deliveries: z.number().int(),
  })
  .meta({ id: 'UsageDay' });
export type UsageDay = z.infer<typeof UsageDay>;

export const UsageResponse = z
  .object({
    dailyNotificationQuota: z.number().int(),
    days: z.array(UsageDay),
  })
  .meta({ id: 'UsageResponse' });
export type UsageResponse = z.infer<typeof UsageResponse>;
