import { hostname } from 'node:os';
import { loadEnv } from './config/env';
import { createPool } from './db/pool';
import { createLogger } from './lib/logger';
import { systemClock } from './lib/time';
import { createSenders } from './modules/channels/senders';
import { DeliveryWorker } from './worker/delivery-worker';

// Entry point of the delivery worker process: `npm run dev:worker` / `node dist/worker.js`.
const env = loadEnv();
const log = createLogger(env, 'worker');
// Pool sized to the send concurrency plus headroom for claims and recovery.
const db = createPool(env.DATABASE_URL, env.WORKER_CONCURRENCY + 3, env.DATABASE_CA_CERT);
const deps = { env, db, clock: systemClock, log };

const workerId = `${hostname()}:${process.pid}`.slice(0, 64);
const worker = new DeliveryWorker(deps, createSenders(env, systemClock), {
  workerId,
  batchSize: env.WORKER_BATCH_SIZE,
  concurrency: env.WORKER_CONCURRENCY,
});

worker.start();
log.info(
  { workerId, concurrency: env.WORKER_CONCURRENCY, batchSize: env.WORKER_BATCH_SIZE },
  'worker started',
);

async function shutdown(signal: string) {
  log.info({ signal }, 'worker stopping; finishing in-flight sends');
  setTimeout(() => process.exit(1), 20_000).unref(); // design: wait at most 20 s
  await worker.stop();
  await db.end().catch(() => undefined);
  log.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
