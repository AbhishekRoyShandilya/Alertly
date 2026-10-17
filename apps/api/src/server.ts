import { loadEnv } from './config/env';
import { createPool } from './db/pool';
import { createLogger } from './lib/logger';
import { systemClock } from './lib/time';
import { buildApp } from './app';

const env = loadEnv();
const log = createLogger(env, 'api');
const db = createPool(env.DATABASE_URL, env.DB_POOL_SIZE);
const app = buildApp({ env, db, clock: systemClock, log });

const server = app.listen(env.PORT, () => {
  log.info({ port: env.PORT }, 'API listening');
});

/**
 * Graceful shutdown. Platforms send SIGTERM before stopping a container (on every deploy).
 * Stop accepting new connections, let in-flight requests finish, close the DB pool, exit.
 * A timer forces exit if something hangs.
 */
function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await db.end().catch(() => undefined);
    log.info('bye');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
