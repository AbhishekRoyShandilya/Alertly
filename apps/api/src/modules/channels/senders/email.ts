import nodemailer from 'nodemailer';
import { isRetryableStatus } from '../../../lib/backoff';
import { renderText, type ChannelSender, type SendInput, type SendResult } from './types';

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What the sender needs from a mail provider. Real: SMTP or Resend. Tests: a fake. */
export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

/** Thrown by mailers so the sender can classify the failure. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

/**
 * SMTP via nodemailer (Mailpit locally). Watch out: SMTP reply codes have the OPPOSITE
 * meaning of HTTP's 4xx/5xx split. SMTP 4xx = temporary ("try again later"),
 * SMTP 5xx = permanent ("mailbox does not exist").
 */
export function smtpMailer(smtpUrl: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      try {
        await transport.sendMail(msg);
      } catch (err) {
        const e = err as { responseCode?: number; message: string };
        const code = e.responseCode;
        throw new MailError(e.message, code === undefined || (code >= 400 && code < 500));
      }
    },
  };
}

/** Resend's HTTP API (free tier works for demos). HTTP status rules apply here. */
export function resendMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(msg) {
      let res: Response;
      try {
        res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new MailError((err as Error).message, true);
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        throw new MailError(
          `Resend HTTP ${res.status}: ${text}`,
          isRetryableStatus(res.status),
          res.status,
        );
      }
    },
  };
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function createEmailSender(mailer: Mailer | null, from: string): ChannelSender {
  return {
    type: 'email',
    async send({ delivery: d }: SendInput): Promise<SendResult> {
      const started = Date.now();
      if (!mailer) {
        return {
          ok: false,
          retryable: false,
          error: 'Email is not configured on this server',
          durationMs: 0,
        };
      }
      const text = renderText(d);
      try {
        await mailer.send({
          from,
          to: String(d.c_config.to),
          subject: d.n_title,
          text,
          // User content is escaped: a notification title must not be able to inject HTML.
          html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        });
        return { ok: true, durationMs: Date.now() - started };
      } catch (err) {
        const e = err instanceof MailError ? err : new MailError((err as Error).message, true);
        return {
          ok: false,
          retryable: e.retryable,
          httpStatus: e.httpStatus,
          error: e.message,
          durationMs: Date.now() - started,
        };
      }
    },
  };
}
