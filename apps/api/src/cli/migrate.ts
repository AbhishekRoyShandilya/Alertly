import { loadEnv } from '../config/env';
import { createLogger } from '../lib/logger';
import { runMigrations } from '../db/migrate';

// `npm run migrate -w apps/api` — also used as the release step on deploy.
const env = loadEnv();
const log = createLogger({ ...env, LOG_LEVEL: env.LOG_LEVEL ?? 'info' }, 'migrate');

runMigrations(env.DATABASE_URL, log)
  .then((applied) => {
    log.info(
      { count: applied.length },
      applied.length ? 'migrations done' : 'database already up to date',
    );
    process.exit(0);
  })
  .catch((err: unknown) => {
    log.error({ err }, 'migration failed');
    process.exit(1);
  });
