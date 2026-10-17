import { notFound } from './errors';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function toBase62(n: bigint): string {
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

export function fromBase62(s: string): bigint | null {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 62n + BigInt(v);
  }
  return n;
}

/**
 * Public IDs carry a type prefix: `ntf_4c92`, `ch_1F`. The prefix makes IDs self-describing
 * in logs and support tickets, and passing a channel ID where a notification ID is expected
 * fails loudly instead of silently loading the wrong row.
 * Note: the number itself is not secret; ownership checks are what protect data.
 */
export function encodeId(prefix: string, id: number): string {
  return `${prefix}_${toBase62(BigInt(id))}`;
}

/** Returns the numeric id, or throws 404 (a malformed id names a resource that doesn't exist). */
export function decodeId(prefix: string, publicId: string, what = 'Resource'): number {
  const [p, body, extra] = publicId.split('_');
  if (p !== prefix || !body || extra !== undefined || body.length > 11) throw notFound(what);
  const n = fromBase62(body);
  if (n === null || n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw notFound(what);
  return Number(n);
}
