import type { ChannelType } from '@alertly/shared';
import type { ClaimedDelivery } from '../../deliveries/queue';

export interface SendInput {
  delivery: ClaimedDelivery;
  /** 1-based attempt number across all rounds (sent to webhooks as X-Alertly-Delivery-Attempt). */
  attemptNo: number;
}

/**
 * Senders never throw: every outcome, including crashes, becomes a SendResult. That keeps the
 * worker loop simple, and lets `decide()` treat all channel types the same way.
 */
export type SendResult =
  | { ok: true; httpStatus?: number; durationMs: number }
  | {
      ok: false;
      retryable: boolean;
      httpStatus?: number;
      error: string;
      retryAfterSec?: number;
      durationMs: number;
    };

export interface ChannelSender {
  type: ChannelType;
  send(input: SendInput): Promise<SendResult>;
}

/** Parses Retry-After, which may be seconds ("120") or an HTTP date. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec >= 0) return sec;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Plain-text rendering shared by email and Telegram. */
export function renderText(d: ClaimedDelivery): string {
  const parts = [d.n_title];
  if (d.n_body) parts.push('', d.n_body);
  if (d.n_data && Object.keys(d.n_data).length > 0) {
    parts.push('', JSON.stringify(d.n_data, null, 2));
  }
  return parts.join('\n');
}
