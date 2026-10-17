import type { Express } from 'express';
import { buildApp } from '../../src/app';
import type { Deps } from '../../src/context';
import { createLogger } from '../../src/lib/logger';
import { FakeClock } from '../../src/lib/time';
import { createServices, type Services } from '../../src/services';
import {
  SimulatedProvider,
  coingeckoProvider,
  binanceProvider,
} from '../../src/modules/prices/providers';
import { createTestDb, type TestDb } from './db';
import { testEnv } from './env';

export interface TestContext {
  testDb: TestDb;
  deps: Deps;
  clock: FakeClock;
  services: Services;
  /** The price feed behind provider "simulated": tests set prices with sim.freeze(symbol, price). */
  sim: SimulatedProvider;
  app: Express;
  close(): Promise<void>;
}

/** A migrated test database + app wired with a fake clock. Call close() in afterAll. */
export async function createTestContext(
  envOverrides: Record<string, string> = {},
): Promise<TestContext> {
  const testDb = await createTestDb();
  const env = testEnv(testDb.url, envOverrides);
  const clock = new FakeClock(new Date());
  const deps: Deps = { env, db: testDb.db, clock, log: createLogger(env) };
  const sim = new SimulatedProvider(1);
  const services = createServices(deps, {
    providers: { simulated: sim, coingecko: coingeckoProvider(), binance: binanceProvider() },
  });
  return {
    testDb,
    deps,
    clock,
    services,
    sim,
    app: buildApp(deps, services),
    close: () => testDb.drop(),
  };
}
