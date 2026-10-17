import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, isRetryableStatus, nextDelayMs } from '../../src/lib/backoff';

describe('nextDelayMs', () => {
  const noJitter = () => 1; // random() = 1 gives the full delay (100%)

  it('grows exponentially: 30s, 2m, 8m, 32m', () => {
    expect(nextDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(30_000);
    expect(nextDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(120_000);
    expect(nextDelayMs(3, DEFAULT_BACKOFF, noJitter)).toBe(480_000);
    expect(nextDelayMs(4, DEFAULT_BACKOFF, noJitter)).toBe(1_920_000);
  });

  it('caps at maxMs', () => {
    expect(nextDelayMs(5, DEFAULT_BACKOFF, noJitter)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(nextDelayMs(50, DEFAULT_BACKOFF, noJitter)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('jitter keeps the delay between 50% and 100%', () => {
    expect(nextDelayMs(1, DEFAULT_BACKOFF, () => 0)).toBe(15_000);
    for (let i = 0; i < 200; i++) {
      const d = nextDelayMs(2, DEFAULT_BACKOFF);
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(120_000);
    }
  });
});

describe('isRetryableStatus', () => {
  it.each([408, 429, 500, 502, 503, 504])('%i is retryable', (s) => {
    expect(isRetryableStatus(s)).toBe(true);
  });
  it.each([400, 401, 403, 404, 410, 422])('%i is permanent', (s) => {
    expect(isRetryableStatus(s)).toBe(false);
  });
  it('a network error (no status) is retryable', () => {
    expect(isRetryableStatus(undefined)).toBe(true);
  });
});
