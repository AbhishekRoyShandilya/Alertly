import { describe, expect, it } from 'vitest';
import { connectionOptions } from '../../src/db/pool';
import { loadEnv } from '../../src/config/env';

describe('connectionOptions (managed MySQL URLs)', () => {
  it('plain local URL: no TLS', () => {
    const o = connectionOptions('mysql://u:p@127.0.0.1:3306/alertly');
    expect(o.ssl).toBeUndefined();
    expect(o.uri).toBe('mysql://u:p@127.0.0.1:3306/alertly');
  });

  it('strips ssl-mode=REQUIRED (unknown to mysql2) and turns TLS on', () => {
    const o = connectionOptions(
      'mysql://avnadmin:pw@db.aivencloud.com:12345/defaultdb?ssl-mode=REQUIRED',
    );
    expect(o.uri).toBe('mysql://avnadmin:pw@db.aivencloud.com:12345/defaultdb');
    expect(o.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('uses the CA certificate, accepting one-line "\\n" encoded PEM', () => {
    const o = connectionOptions(
      'mysql://u:p@h:1/db',
      '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----',
    );
    expect(o.ssl).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    });
  });
});

describe('loadEnv with hosting-dashboard quirks', () => {
  it('treats blank optional values as unset', () => {
    const env = loadEnv({
      DATABASE_URL: 'mysql://u:p@h:1/db',
      JWT_SECRET: 'x'.repeat(32),
      ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      DEMO_WEBHOOK_URL: '',
      RESEND_API_KEY: '',
      EMBED_WORKERS: 'true',
    });
    expect(env.DEMO_WEBHOOK_URL).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.EMBED_WORKERS).toBe(true);
  });
});
