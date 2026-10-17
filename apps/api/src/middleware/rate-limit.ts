import type { Response } from 'express';
import type { Clock } from '../lib/time';
import { tooManyRequests } from '../lib/errors';

/**
 * Sliding-window rate limiter kept in memory: for each key (an API key id, or an IP for
 * login), remember the timestamps of recent requests and refuse once `max` happened within
 * the last `windowMs`.
 *
 * Limitation (say it in the interview): memory is per process. With several API instances,
 * each would allow `max`, so the real limit would be max × instances. The fix is a shared
 * store (Redis INCR with expiry, or a sorted set for a true sliding window).
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private clock: Clock,
  ) {
    // Forget idle keys every minute so the map can't grow forever.
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Records a hit, sets RateLimit-* headers, throws 429 when over the limit. */
  check(key: string, res?: Response): void {
    const now = this.clock.now().getTime();
    const windowStart = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    const allowed = list.length < this.max;
    if (allowed) list.push(now);
    this.hits.set(key, list);

    const oldest = list[0] ?? now;
    const resetSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    res?.setHeader('RateLimit-Limit', String(this.max));
    res?.setHeader('RateLimit-Remaining', String(Math.max(0, this.max - list.length)));
    res?.setHeader('RateLimit-Reset', String(resetSec));

    if (!allowed)
      throw tooManyRequests(
        resetSec,
        `Rate limit of ${this.max} requests per ${this.windowMs / 1000}s exceeded`,
      );
  }

  private sweep(): void {
    const windowStart = this.clock.now().getTime() - this.windowMs;
    for (const [key, list] of this.hits) {
      if ((list.at(-1) ?? 0) <= windowStart) this.hits.delete(key);
    }
  }
}
