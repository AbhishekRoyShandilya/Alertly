import { loadEnv } from '../config/env';
import { createPool } from '../db/pool';
import { createLogger } from '../lib/logger';
import { systemClock } from '../lib/time';
import { createServices } from '../services';
import { seedDemo } from '../db/seed';

// `npm run seed -w apps/api` — creates the read-only demo account if it doesn't exist.
const env = loadEnv();
const log = createLogger({ ...env, LOG_LEVEL: env.LOG_LEVEL ?? 'info' }, 'seed');
const db = createPool(env.DATABASE_URL, 2);
const deps = { env, db, clock: systemClock, log };

seedDemo(deps, createServices(deps))
  .then(async ({ created, email }) => {
    log.info({ email }, created ? 'demo account created' : 'demo account already exists');
    await db.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    log.error({ err }, 'seed failed');
    await db.end();
    process.exit(1);
  });
