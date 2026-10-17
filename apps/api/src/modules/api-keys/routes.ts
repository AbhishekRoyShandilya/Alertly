import { Router } from 'express';
import { CreateApiKeyInput, ID_PREFIX } from '@alertly/shared';
import { parse } from '../../middleware/validate';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import { decodeId } from '../../lib/ids';
import type { ApiKeysService } from './service';

// Managing keys requires a dashboard session: an API key can't mint more API keys.
export function apiKeyRoutes(apiKeys: ApiKeysService, mw: AuthMiddleware): Router {
  const r = Router();
  r.use('/api-keys', mw.requireSession);

  r.get('/api-keys', async (req, res) => {
    res.json({ data: await apiKeys.list(userIdOf(req)) });
  });

  r.post('/api-keys', async (req, res) => {
    const { name } = parse(CreateApiKeyInput, req.body);
    res.status(201).json(await apiKeys.create(userIdOf(req), name));
  });

  r.delete('/api-keys/:id', async (req, res) => {
    await apiKeys.revoke(userIdOf(req), decodeId(ID_PREFIX.apiKey, req.params.id, 'API key'));
    res.status(204).end();
  });

  return r;
}
