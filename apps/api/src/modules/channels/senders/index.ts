import type { ChannelType } from '@alertly/shared';
import type { Env } from '../../../config/env';
import type { Clock } from '../../../lib/time';
import { decryptSecret } from '../../../lib/crypto';
import { createEmailSender, resendMailer, smtpMailer, type Mailer } from './email';
import { createTelegramSender } from './telegram';
import { createWebhookSender } from './webhook';
import type { ChannelSender } from './types';

export type SenderRegistry = Record<ChannelType, ChannelSender>;

/**
 * A registry keyed by channel type: the worker calls `senders[channel.type].send(...)` and
 * never needs a switch statement. Adding SMS later = one new file + one line here.
 * `overrides` lets tests swap in fakes (e.g. a fake mailer).
 */
export function createSenders(
  env: Env,
  clock: Clock,
  overrides: { mailer?: Mailer | null; fetch?: typeof fetch; webhookTimeoutMs?: number } = {},
): SenderRegistry {
  const mailer =
    overrides.mailer !== undefined
      ? overrides.mailer
      : env.RESEND_API_KEY
        ? resendMailer(env.RESEND_API_KEY)
        : env.SMTP_URL
          ? smtpMailer(env.SMTP_URL)
          : null;

  return {
    email: createEmailSender(mailer, env.EMAIL_FROM),
    webhook: createWebhookSender({
      allowPrivate: env.WEBHOOK_ALLOW_PRIVATE,
      requireHttps: env.isProd,
      decryptSecret: (enc) => decryptSecret(enc, env.encryptionKey),
      now: () => clock.now(),
      timeoutMs: overrides.webhookTimeoutMs,
    }),
    telegram: createTelegramSender(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_URL, overrides.fetch),
  };
}
