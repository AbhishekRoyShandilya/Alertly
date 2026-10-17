import { hostname } from 'node:os';
import { loadEnv } from './config/env';
import { createPool } from './db/pool';
import { MIGRATIONS_DIR, runMigrations } from './db/migrate';
import { seedDemo } from './db/seed';
import { createLogger } from './lib/logger';
import { systemClock } from './lib/time';
import { createServices } from './services';
import { buildApp } from './app';
import { createSenders } from './modules/channels/senders';
import { DeliveryWorker } from './worker/delivery-worker';
import { AlertScheduler } from './scheduler/alert-scheduler';

const env = loadEnv();
const log = createLogger(env, 'api');
const db = createPool(env.DATABASE_URL, env.DB_POOL_SIZE, env.DATABASE_CA_CERT);
const deps = { env, db, clock: systemClock, log };
const services = createServices(deps);

// Free hosting has no release step, so migrations and the demo seed can run at startup.
// (Safe with one instance; with several, use a release step instead so they don't race.)
if (env.MIGRATE_ON_START) {
  await runMigrations(env.DATABASE_URL, log, MIGRATIONS_DIR, env.DATABASE_CA_CERT);
  const seeded = await seedDemo(deps, services);
  log.info({ created: seeded.created }, 'demo account checked');
}

const app = buildApp(deps, services);
const server = app.listen(env.PORT, () => {
  log.info({ port: env.PORT, embeddedWorkers: env.EMBED_WORKERS }, 'API listening');
});

// Single-service mode (EMBED_WORKERS=true): worker and scheduler share this process and its
// pool. Same classes as the standalone processes; only where they run changes.
let worker: DeliveryWorker | undefined;
let scheduler: AlertScheduler | undefined;
if (env.EMBED_WORKERS) {
  worker = new DeliveryWorker(deps, createSenders(env, systemClock), {
    workerId: `${hostname()}:${process.pid}:embedded`.slice(0, 64),
    batchSize: env.WORKER_BATCH_SIZE,
    concurrency: env.WORKER_CONCURRENCY,
  });
  worker.start();
  scheduler = new AlertScheduler(deps, services.alerts, services.prices);
  scheduler.start(env.SCHEDULER_INTERVAL_SEC);
}

/**
 * Graceful shutdown. Platforms send SIGTERM before stopping a container (on every deploy).
 * Stop accepting new connections, let in-flight requests and sends finish, write buffered
 * usage counts, close the DB pool, exit. A timer forces exit if something hangs.
 */
function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 20_000).unref();
  server.close(async () => {
    await Promise.all([worker?.stop(), scheduler?.stop()]).catch(() => undefined);
    await services.usage.flush().catch(() => undefined);
    await db.end().catch(() => undefined);
    log.info('bye');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
