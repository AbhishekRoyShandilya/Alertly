import { Router } from 'express';
import { z } from 'zod';
import { ID_PREFIX, ListDeliveriesQuery, PageQuery } from '@alertly/shared';
import { param, parse } from '../../middleware/validate';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import { decodeId } from '../../lib/ids';
import type { DeliveriesService } from './service';

export function deliveryRoutes(deliveries: DeliveriesService, mw: AuthMiddleware): Router {
  const r = Router();
  const deliveryId = (raw: string) => decodeId(ID_PREFIX.delivery, raw, 'Delivery');

  r.get('/deliveries', mw.requireSessionOrApiKey, async (req, res) => {
    const page = parse(PageQuery, req.query);
    const f = parse(ListDeliveriesQuery, req.query);
    res.json(
      await deliveries.list(
        userIdOf(req),
        {
          status: f.status,
          channelId: f.channelId ? decodeId(ID_PREFIX.channel, f.channelId, 'Channel') : undefined,
          from: f.from ? new Date(f.from) : undefined,
          to: f.to ? new Date(f.to) : undefined,
        },
        page.limit,
        page.cursor,
      ),
    );
  });

  // Registered before /deliveries/:id so "stats" isn't mistaken for an id.
  r.get('/deliveries/stats', mw.requireSessionOrApiKey, async (req, res) => {
    const { hours } = parse(
      z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) }),
      req.query,
    );
    res.json(await deliveries.stats(userIdOf(req), hours));
  });

  r.get('/deliveries/:id', mw.requireSessionOrApiKey, async (req, res) => {
    res.json(await deliveries.get(userIdOf(req), deliveryId(param(req, 'id'))));
  });

  r.post('/deliveries/:id/retry', mw.requireSession, async (req, res) => {
    res.json(await deliveries.retryManually(userIdOf(req), deliveryId(param(req, 'id'))));
  });

  return r;
}
