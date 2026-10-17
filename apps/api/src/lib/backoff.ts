export interface BackoffOptions {
  baseMs: number;
  factor: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 30_000, // 30 s
  factor: 4, //      30 s, 2 min, 8 min, 32 min, 2 h (capped)
  maxMs: 2 * 60 * 60_000,
};

/**
 * Exponential backoff with jitter. `attempt` is the attempt that just failed (1-based).
 * The random 50–100% scale ("jitter") spreads retries out, so a provider outage that fails
 * thousands of deliveries at once doesn't produce thousands of retries in the same second.
 */
export function nextDelayMs(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const raw = opts.baseMs * opts.factor ** Math.max(0, attempt - 1);
  const capped = Math.min(opts.maxMs, raw);
  return Math.round(capped * (0.5 + random() * 0.5));
}

/**
 * Should a failed HTTP call be tried again?
 * - no status (network error, timeout, DNS failure): yes, it may be temporary
 * - 408 timeout, 429 rate limited, 5xx server errors: yes
 * - other 4xx (bad request, unauthorized, not found, gone): no, retrying won't fix it
 */
export function isRetryableStatus(httpStatus?: number): boolean {
  if (httpStatus === undefined) return true;
  if (httpStatus === 408 || httpStatus === 429) return true;
  return httpStatus >= 500;
}
