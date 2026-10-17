import { describe, expect, it } from 'vitest';
import { decide } from '../../src/modules/deliveries/decide';
import type { SendResult } from '../../src/modules/channels/senders/types';

const now = new Date('2026-10-16T09:00:00Z');
const noJitter = { random: () => 1 };
const ok: SendResult = { ok: true, durationMs: 5 };
const temp = (extra: Partial<SendResult> = {}): SendResult =>
  ({ ok: false, retryable: true, error: 'HTTP 503', durationMs: 5, ...extra }) as SendResult;
const perm: SendResult = { ok: false, retryable: false, error: 'HTTP 404', durationMs: 5 };

describe('decide', () => {
  it('success → delivered (even on the last attempt)', () => {
    expect(decide({ attempt_count: 6, max_attempts: 6 }, ok, now)).toEqual({ kind: 'delivered' });
  });

  it('permanent error → failed immediately, never retried', () => {
    expect(decide({ attempt_count: 1, max_attempts: 6 }, perm, now)).toEqual({
      kind: 'failed',
      error: 'HTTP 404',
    });
  });

  it('retryable error with attempts left → retry after backoff', () => {
    const d1 = decide({ attempt_count: 1, max_attempts: 6 }, temp(), now, noJitter);
    expect(d1).toMatchObject({ kind: 'retry', error: 'HTTP 503' });
    expect(d1.kind === 'retry' && d1.nextAt.getTime() - now.getTime()).toBe(30_000);

    const d3 = decide({ attempt_count: 3, max_attempts: 6 }, temp(), now, noJitter);
    expect(d3.kind === 'retry' && d3.nextAt.getTime() - now.getTime()).toBe(480_000);
  });

  it('retryable error on the last attempt → dead (dead letter)', () => {
    const d = decide({ attempt_count: 6, max_attempts: 6 }, temp(), now);
    expect(d.kind).toBe('dead');
    expect(d.kind === 'dead' && d.error).toMatch(/Gave up after 6 attempts/);
  });

  it('respects a longer Retry-After from the receiver', () => {
    const d = decide(
      { attempt_count: 1, max_attempts: 6 },
      temp({ retryAfterSec: 600 }),
      now,
      noJitter,
    );
    expect(d.kind === 'retry' && d.nextAt.getTime() - now.getTime()).toBe(600_000);
  });

  it('ignores a shorter Retry-After and caps an absurd one', () => {
    const short = decide(
      { attempt_count: 3, max_attempts: 6 },
      temp({ retryAfterSec: 1 }),
      now,
      noJitter,
    );
    expect(short.kind === 'retry' && short.nextAt.getTime() - now.getTime()).toBe(480_000);
    const huge = decide(
      { attempt_count: 1, max_attempts: 6 },
      temp({ retryAfterSec: 10 ** 9 }),
      now,
      noJitter,
    );
    expect(huge.kind === 'retry' && huge.nextAt.getTime() - now.getTime()).toBe(2 * 3600_000);
  });
});
