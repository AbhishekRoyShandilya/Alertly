import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  hashPassword,
  signWebhook,
  stableStringify,
  verifyPassword,
  verifyWebhook,
  webhookSignatureHeader,
} from '../../src/lib/crypto';

describe('API keys', () => {
  it('generates prefixed, unique keys and stores only a hash', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^alr_[0-9A-Za-z]{30,}$/);
    expect(a.prefix).toBe(a.key.slice(0, 12));
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).toHaveLength(64);
    expect(a.key).not.toBe(b.key);
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password!!', hash)).toBe(false);
  });
});

describe('AES-256-GCM secrets', () => {
  const key = randomBytes(32);

  it('round-trips, with a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('whsec_abc', key);
    const b = encryptSecret('whsec_abc', key);
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a, key)).toBe('whsec_abc');
  });

  it('detects tampering', () => {
    const buf = encryptSecret('whsec_abc', key);
    buf[buf.length - 1]! ^= 0xff;
    expect(() => decryptSecret(buf, key)).toThrow();
  });

  it('fails with the wrong key', () => {
    expect(() => decryptSecret(encryptSecret('x', key), randomBytes(32))).toThrow();
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"ntf_1","title":"hi"}';
  const now = 1_760_612_345;

  it('accepts a valid signature', () => {
    const header = webhookSignatureHeader(secret, now, body);
    expect(header).toBe(`t=${now},v1=${signWebhook(secret, now, body)}`);
    expect(verifyWebhook(secret, header, body, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = webhookSignatureHeader(secret, now, body);
    expect(verifyWebhook(secret, header, body.replace('hi', 'yo'), now)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const header = webhookSignatureHeader('whsec_other', now, body);
    expect(verifyWebhook(secret, header, body, now)).toBe(false);
  });

  it('rejects an old timestamp (replay protection)', () => {
    const header = webhookSignatureHeader(secret, now, body);
    expect(verifyWebhook(secret, header, body, now + 301)).toBe(false);
    expect(verifyWebhook(secret, header, body, now + 299)).toBe(true);
  });

  it('rejects garbage headers', () => {
    expect(verifyWebhook(secret, 'nonsense', body, now)).toBe(false);
    expect(verifyWebhook(secret, `t=${now},v1=zz`, body, now)).toBe(false);
  });
});

describe('stableStringify', () => {
  it('ignores key order, including nested objects', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
  it('keeps array order', () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
  });
});
