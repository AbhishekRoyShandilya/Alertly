import { loadEnv, type Env } from '../../src/config/env';

/** Root connection used to create and drop throwaway test databases. */
export const TEST_ROOT_URL = process.env.TEST_DATABASE_URL ?? 'mysql://root:root@127.0.0.1:3306';

export function testEnv(databaseUrl: string, overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DB_POOL_SIZE: '5',
    JWT_SECRET: 'test-jwt-secret-that-is-long-enough-0123456789',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    WEB_ORIGIN: 'http://localhost:3000',
    WEBHOOK_ALLOW_PRIVATE: 'true', // the mock webhook server listens on 127.0.0.1
    REGISTER_RATE_LIMIT_PER_MIN: '1000', // tests sign up many users from one IP
    ...overrides,
  });
}
