import { loadEnv } from './config/env';
import { createPool } from './db/pool';
import { createLogger } from './lib/logger';
import { systemClock } from './lib/time';
import { createServices } from './services';
import { AlertScheduler } from './scheduler/alert-scheduler';

// Entry point of the scheduler process: `npm run dev:scheduler` / `node dist/scheduler.js`.
const env = loadEnv();
const log = createLogger(env, 'scheduler');
const db = createPool(env.DATABASE_URL, 5);
const deps = { env, db, clock: systemClock, log };
const services = createServices(deps);

const scheduler = new AlertScheduler(deps, services.alerts, services.prices);
scheduler.start(env.SCHEDULER_INTERVAL_SEC);
log.info(
  { intervalSec: env.SCHEDULER_INTERVAL_SEC, provider: env.PRICE_PROVIDER_DEFAULT },
  'scheduler started',
);

async function shutdown(signal: string) {
  log.info({ signal }, 'scheduler stopping');
  setTimeout(() => process.exit(1), 10_000).unref();
  await scheduler.stop();
  await db.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
