import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { toBase62 } from './ids';

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

// ---------- API keys ----------

export const API_KEY_PREFIX = 'alr_';

/**
 * A key is `alr_` + 32 random bytes in base62 (~43 chars). We store only its SHA-256 hash.
 * A fast hash is fine here because the key has 256 bits of entropy: brute-forcing it is
 * impossible regardless of hash speed. Slow hashes (argon2) are for low-entropy passwords.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + toBase62(BigInt('0x' + randomBytes(32).toString('hex')));
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

export const hashApiKey = (key: string): string => sha256(key);

// ---------- Passwords ----------

/** argon2id (the library default): memory-hard, so GPU brute-forcing is expensive. */
export const hashPassword = (pw: string): Promise<string> => argonHash(pw);

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  try {
    return await argonVerify(hash, pw);
  } catch {
    return false;
  }
}

/**
 * A real argon2 hash of a random string. Used when a login email doesn't exist, so the
 * response takes as long as a wrong password would (no timing leak of which emails exist).
 */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = (): Promise<string> =>
  (dummyHash ??= argonHash(randomBytes(16).toString('hex')));

// ---------- Secrets at rest (AES-256-GCM) ----------

/** Output layout: iv (12 bytes) | auth tag (16 bytes) | ciphertext. */
export function encryptSecret(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the data was tampered with: GCM authenticates as well as encrypts. */
export function decryptSecret(buf: Buffer, key: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const generateWebhookSecret = (): string => 'whsec_' + randomBytes(32).toString('hex');

// ---------- Webhook signatures ----------

/** HMAC-SHA256 over "<timestamp>.<raw body>", hex. The timestamp is signed to prevent replays. */
export function signWebhook(secret: string, timestampSec: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
}

export function webhookSignatureHeader(secret: string, timestampSec: number, rawBody: string) {
  return `t=${timestampSec},v1=${signWebhook(secret, timestampSec, rawBody)}`;
}

/**
 * What a receiver does. Exported so tests (and the README snippet) use the same logic.
 * Uses a constant-time comparison so the check doesn't leak how many characters matched.
 */
export function verifyWebhook(
  secret: string,
  header: string,
  rawBody: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || typeof v1 !== 'string') return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  const expected = Buffer.from(signWebhook(secret, t, rawBody), 'hex');
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** JSON.stringify with sorted object keys, so {a,b} and {b,a} hash the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
