import { Router } from 'express';
import { CreateChannelInput, ID_PREFIX, UpdateChannelInput } from '@alertly/shared';
import { param, parse } from '../../middleware/validate';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import { decodeId } from '../../lib/ids';
import type { ChannelsService } from './service';

export function channelRoutes(channels: ChannelsService, mw: AuthMiddleware): Router {
  const r = Router();
  const channelId = (raw: string) => decodeId(ID_PREFIX.channel, raw, 'Channel');

  // Reading channels works with an API key; changing them needs the dashboard.
  r.get('/channels', mw.requireSessionOrApiKey, async (req, res) => {
    res.json({ data: await channels.list(userIdOf(req)) });
  });

  r.get('/channels/:id', mw.requireSessionOrApiKey, async (req, res) => {
    res.json(await channels.get(userIdOf(req), channelId(param(req, 'id'))));
  });

  r.post('/channels', mw.requireSession, async (req, res) => {
    const input = parse(CreateChannelInput, req.body);
    res.status(201).json(await channels.create(userIdOf(req), input));
  });

  r.patch('/channels/:id', mw.requireSession, async (req, res) => {
    const input = parse(UpdateChannelInput, req.body);
    res.json(await channels.update(userIdOf(req), channelId(param(req, 'id')), input));
  });

  r.delete('/channels/:id', mw.requireSession, async (req, res) => {
    await channels.remove(userIdOf(req), channelId(param(req, 'id')));
    res.status(204).end();
  });

  r.post('/channels/:id/test', mw.requireSession, async (req, res) => {
    res.status(202).json(await channels.sendTest(userIdOf(req), channelId(param(req, 'id'))));
  });

  r.post('/channels/:id/rotate-secret', mw.requireSession, async (req, res) => {
    res.json(await channels.rotateSecret(userIdOf(req), channelId(param(req, 'id'))));
  });

  return r;
}
