import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';

const valid = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/db',
  JWT_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.PRICE_PROVIDER_DEFAULT).toBe('simulated');
    expect(env.encryptionKey).toHaveLength(32);
    expect(env.WEBHOOK_ALLOW_PRIVATE).toBe(false);
  });

  it('fails fast with every problem listed', () => {
    expect(() => loadEnv({ JWT_SECRET: 'short' })).toThrow(
      /DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*ENCRYPTION_KEY/,
    );
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => loadEnv({ ...valid, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });

  it('refuses private webhooks in production', () => {
    expect(() =>
      loadEnv({ ...valid, NODE_ENV: 'production', WEBHOOK_ALLOW_PRIVATE: 'true' }),
    ).toThrow();
  });
});
