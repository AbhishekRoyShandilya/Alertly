import http from 'node:http';
import https from 'node:https';
import { ID_PREFIX } from '@alertly/shared';
import { webhookSignatureHeader } from '../../../lib/crypto';
import { encodeId } from '../../../lib/ids';
import { isRetryableStatus } from '../../../lib/backoff';
import { assertPublicHttpUrl, guardedLookup } from '../../../lib/net-guard';
import { parseRetryAfter, type ChannelSender, type SendInput, type SendResult } from './types';

export const WEBHOOK_TIMEOUT_MS = 10_000;

interface WebhookOptions {
  allowPrivate: boolean;
  requireHttps: boolean;
  decryptSecret: (enc: Buffer) => string;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * POSTs the notification as JSON to the user's URL.
 * - the body is serialised ONCE; those exact bytes are signed and sent (re-serialising could
 *   change key order or whitespace and break the signature)
 * - SSRF is checked again here, and at connect time via `lookup: guardedLookup` (DNS rebinding)
 * - redirects are NOT followed: a 3xx to http://169.254.169.254 would bypass the SSRF check
 * - 2xx within 10 s = delivered
 */
export function createWebhookSender(opts: WebhookOptions): ChannelSender {
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());

  return {
    type: 'webhook',
    async send({ delivery: d, attemptNo }: SendInput): Promise<SendResult> {
      const started = Date.now();
      const fail = (
        retryable: boolean,
        error: string,
        extra: Partial<SendResult> = {},
      ): SendResult => ({
        ok: false,
        retryable,
        error,
        durationMs: Date.now() - started,
        ...extra,
      });

      let url: URL;
      try {
        url = await assertPublicHttpUrl(String(d.c_config.url), opts);
      } catch (err) {
        return fail(false, `URL rejected: ${(err as Error).message}`);
      }
      if (!d.c_secret_enc) return fail(false, 'Webhook channel has no signing secret');

      const notificationId = encodeId(ID_PREFIX.notification, d.notification_id);
      const body = JSON.stringify({
        id: notificationId,
        title: d.n_title,
        body: d.n_body,
        data: d.n_data ?? {},
        source: d.n_source,
        createdAt: d.n_created_at.toISOString(),
      });
      const ts = Math.floor(now().getTime() / 1000);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'Alertly-Webhooks/1.0',
        'X-Alertly-Notification-Id': notificationId,
        'X-Alertly-Delivery-Id': encodeId(ID_PREFIX.delivery, d.id),
        'X-Alertly-Delivery-Attempt': String(attemptNo),
        'X-Alertly-Signature': webhookSignatureHeader(opts.decryptSecret(d.c_secret_enc), ts, body),
      };

      return new Promise<SendResult>((resolve) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
          url,
          { method: 'POST', headers, lookup: guardedLookup(opts.allowPrivate) as never },
          (res) => {
            res.resume(); // drain and discard the body: we only need the status
            res.on('end', () => {
              const status = res.statusCode ?? 0;
              const durationMs = Date.now() - started;
              if (status >= 200 && status < 300) {
                resolve({ ok: true, httpStatus: status, durationMs });
              } else {
                resolve({
                  ok: false,
                  retryable: isRetryableStatus(status),
                  httpStatus: status,
                  error: `HTTP ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}`,
                  retryAfterSec: parseRetryAfter(res.headers['retry-after'] as string | undefined),
                  durationMs,
                });
              }
            });
          },
        );
        // One deadline for the whole exchange (connect + response), not per socket event.
        const timer = setTimeout(
          () => req.destroy(new Error(`Timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
        req.on('close', () => clearTimeout(timer));
        req.on('error', (err: NodeJS.ErrnoException) => {
          // Blocked by the SSRF guard: permanent. Everything else (timeout, refused, DNS): retry.
          resolve(fail(err.code !== 'EBLOCKED', err.message));
        });
        req.end(body);
      });
    },
  };
}
