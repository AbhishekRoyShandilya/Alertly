import { Router } from 'express';
import { z } from 'zod';
import { PRICE_PROVIDERS, SUPPORTED_SYMBOLS } from '@alertly/shared';
import { param, parse } from '../../middleware/validate';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import type { PriceService } from './service';
import type { UsageService } from '../usage/service';

const PriceQuery = z.object({ provider: z.enum(PRICE_PROVIDERS).optional() });
const UsageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

export function priceAndUsageRoutes(
  prices: PriceService,
  usage: UsageService,
  defaultProvider: (typeof PRICE_PROVIDERS)[number],
  mw: AuthMiddleware,
): Router {
  const r = Router();

  r.get('/prices/:symbol', mw.requireSession, async (req, res) => {
    const symbol = parse(z.enum(SUPPORTED_SYMBOLS), param(req, 'symbol').toUpperCase());
    const { provider } = parse(PriceQuery, req.query);
    res.json(await prices.getWithHistory(provider ?? defaultProvider, symbol));
  });

  r.get('/usage', mw.requireSession, async (req, res) => {
    const { days } = parse(UsageQuery, req.query);
    res.json(await usage.get(userIdOf(req), days));
  });

  return r;
}
