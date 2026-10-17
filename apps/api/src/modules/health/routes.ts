import { Router } from 'express';
import type { Deps } from '../../context';
import { queryOne } from '../../db/pool';
import { latestMigrationVersion } from '../../db/migrate';

/**
 * Two different questions for the hosting platform:
 * - /health (liveness): is the process alive? If not, restart it.
 * - /ready (readiness): can it serve traffic? DB reachable and schema up to date.
 *   If not, stop routing requests to it, but don't restart it.
 */
export function healthRoutes({ db }: Pick<Deps, 'db'>): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  r.get('/ready', async (_req, res) => {
    try {
      const expected = await latestMigrationVersion();
      const row = await queryOne<{ version: string }>(
        db,
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      if (expected && row?.version !== expected) {
        res.status(503).json({ status: 'not_ready', reason: 'migrations pending' });
        return;
      }
      res.json({ status: 'ready', migration: row?.version ?? null });
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'database unreachable' });
    }
  });

  return r;
}
