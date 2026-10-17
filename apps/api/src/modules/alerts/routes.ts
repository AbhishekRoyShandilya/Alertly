import { Router } from 'express';
import { CreateAlertInput, ID_PREFIX, UpdateAlertInput } from '@alertly/shared';
import { param, parse } from '../../middleware/validate';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import { decodeId } from '../../lib/ids';
import type { AlertsService } from './service';

export function alertRoutes(alerts: AlertsService, mw: AuthMiddleware): Router {
  const r = Router();
  r.use('/alerts', mw.requireSession);
  const ruleId = (raw: string) => decodeId(ID_PREFIX.alert, raw, 'Alert rule');
  const channelIds = (ids: string[]) => ids.map((id) => decodeId(ID_PREFIX.channel, id, 'Channel'));

  r.get('/alerts', async (req, res) => {
    res.json({ data: await alerts.list(userIdOf(req)) });
  });

  r.post('/alerts', async (req, res) => {
    const input = parse(CreateAlertInput, req.body);
    res.status(201).json(await alerts.create(userIdOf(req), input, channelIds(input.channelIds)));
  });

  r.get('/alerts/:id', async (req, res) => {
    res.json(await alerts.get(userIdOf(req), ruleId(param(req, 'id'))));
  });

  r.patch('/alerts/:id', async (req, res) => {
    const input = parse(UpdateAlertInput, req.body);
    const ids = input.channelIds ? channelIds(input.channelIds) : undefined;
    res.json(await alerts.update(userIdOf(req), ruleId(param(req, 'id')), input, ids));
  });

  r.delete('/alerts/:id', async (req, res) => {
    await alerts.remove(userIdOf(req), ruleId(param(req, 'id')));
    res.status(204).end();
  });

  r.post('/alerts/:id/evaluate', async (req, res) => {
    res.json(await alerts.dryRun(userIdOf(req), ruleId(param(req, 'id'))));
  });

  return r;
}
