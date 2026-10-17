import { DEFAULT_BACKOFF, nextDelayMs, type BackoffOptions } from '../../lib/backoff';
import type { SendResult } from '../channels/senders/types';

export type Decision =
  | { kind: 'delivered' }
  | { kind: 'retry'; nextAt: Date; error: string }
  | { kind: 'failed'; error: string }
  | { kind: 'dead'; error: string };

/**
 * Pure function: given what happened and how many attempts were made, what next?
 * No I/O, so every branch is unit-testable in microseconds.
 *
 *   success                            → delivered
 *   permanent error (4xx, bad address) → failed (retrying won't help)
 *   retryable error, attempts left     → retry at now + backoff (or the server's Retry-After)
 *   retryable error, no attempts left  → dead (dead-letter: visible, retryable by hand)
 */
export function decide(
  d: { attempt_count: number; max_attempts: number },
  result: SendResult,
  now: Date,
  opts: { backoff?: BackoffOptions; random?: () => number } = {},
): Decision {
  if (result.ok) return { kind: 'delivered' };
  if (!result.retryable) return { kind: 'failed', error: result.error };
  if (d.attempt_count >= d.max_attempts) {
    return { kind: 'dead', error: `Gave up after ${d.attempt_count} attempts: ${result.error}` };
  }
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let delay = nextDelayMs(d.attempt_count, backoff, opts.random);
  // Respect the receiver's Retry-After if it asks for longer (capped, so a bad header can't park
  // a delivery for days).
  if (result.retryAfterSec !== undefined) {
    delay = Math.max(delay, Math.min(result.retryAfterSec * 1000, backoff.maxMs));
  }
  return { kind: 'retry', nextAt: new Date(now.getTime() + delay), error: result.error };
}
