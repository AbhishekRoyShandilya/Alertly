import type { Env } from './config/env';
import type { Db } from './db/pool';
import type { Logger } from './lib/logger';
import type { Clock } from './lib/time';

/**
 * Everything a service needs from the outside world, passed in explicitly
 * ("dependency injection" without a framework). Tests build Deps with a test database,
 * a fake clock and a silent logger; production builds it from real config.
 */
export interface Deps {
  env: Env;
  db: Db;
  clock: Clock;
  log: Logger;
}
