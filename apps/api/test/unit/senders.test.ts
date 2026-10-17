import { describe, expect, it } from 'vitest';
import {
  createEmailSender,
  MailError,
  type Mailer,
} from '../../src/modules/channels/senders/email';
import { createTelegramSender } from '../../src/modules/channels/senders/telegram';
import { parseRetryAfter } from '../../src/modules/channels/senders/types';
import type { ClaimedDelivery } from '../../src/modules/deliveries/queue';

const delivery = (config: Record<string, unknown>): ClaimedDelivery => ({
  id: 1,
  user_id: 1,
  notification_id: 7,
  channel_id: 3,
  attempt_count: 1,
  total_attempts: 1,
  max_attempts: 6,
  n_title: 'Disk <b>almost</b> full',
  n_body: 'server-3 at 92%',
  n_data: { pct: 92 },
  n_source: 'api',
  n_created_at: new Date(),
  c_type: 'email',
  c_name: 'x',
  c_config: config,
  c_secret_enc: null,
});

describe('email sender', () => {
  it('sends subject, text and escaped HTML', async () => {
    const sent: Parameters<Mailer['send']>[0][] = [];
    const sender = createEmailSender({ send: async (m) => void sent.push(m) }, 'Alertly <a@b.c>');
    const r = await sender.send({ delivery: delivery({ to: 'me@example.com' }), attemptNo: 1 });
    expect(r.ok).toBe(true);
    expect(sent[0]).toMatchObject({ to: 'me@example.com', subject: 'Disk <b>almost</b> full' });
    expect(sent[0]!.text).toContain('"pct": 92');
    expect(sent[0]!.html).toContain('&lt;b&gt;almost&lt;/b&gt;');
    expect(sent[0]!.html).not.toContain('<b>');
  });

  it('classifies provider errors', async () => {
    const failing = (e: Error) => createEmailSender({ send: async () => Promise.reject(e) }, 'x');
    const permanent = await failing(new MailError('550 mailbox unavailable', false)).send({
      delivery: delivery({ to: 'a@b.c' }),
      attemptNo: 1,
    });
    expect(permanent).toMatchObject({ ok: false, retryable: false });
    const temporary = await failing(new MailError('421 try later', true)).send({
      delivery: delivery({ to: 'a@b.c' }),
      attemptNo: 1,
    });
    expect(temporary).toMatchObject({ ok: false, retryable: true });
    const unknown = await failing(new Error('ECONNRESET')).send({
      delivery: delivery({ to: 'a@b.c' }),
      attemptNo: 1,
    });
    expect(unknown).toMatchObject({ ok: false, retryable: true });
  });

  it('fails permanently when email is not configured', async () => {
    const r = await createEmailSender(null, 'x').send({
      delivery: delivery({ to: 'a@b.c' }),
      attemptNo: 1,
    });
    expect(r).toMatchObject({ ok: false, retryable: false });
  });
});

describe('telegram sender', () => {
  const reply = (status: number, body: object) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  // Note: no default value for token, because passing undefined would silently use the default.
  const send = (f: typeof fetch, token: string | undefined) =>
    createTelegramSender(token, 'https://tg.test', f).send({
      delivery: delivery({ chatId: '42' }),
      attemptNo: 1,
    });

  it('ok', async () => {
    expect(await send(reply(200, { ok: true }), 'TOKEN')).toMatchObject({ ok: true });
  });
  it('429 uses retry_after', async () => {
    const r = await send(
      reply(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 33 } }),
      'TOKEN',
    );
    expect(r).toMatchObject({ ok: false, retryable: true, retryAfterSec: 33 });
  });
  it('403 bot blocked is permanent', async () => {
    const r = await send(
      reply(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }),
      'TOKEN',
    );
    expect(r).toMatchObject({ ok: false, retryable: false });
  });
  it('network failure is retryable and never leaks the token', async () => {
    const boom = (async () =>
      Promise.reject(
        new TypeError('fetch failed https://tg.test/botTOKEN'),
      )) as unknown as typeof fetch;
    const r = await send(boom, 'TOKEN');
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(JSON.stringify(r)).not.toContain('TOKEN');
  });
  it('not configured â†’ permanent', async () => {
    expect(await send(reply(200, { ok: true }), undefined)).toMatchObject({
      ok: false,
      retryable: false,
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('120')).toBe(120);
    const now = Date.parse('2026-10-16T09:00:00Z');
    expect(parseRetryAfter('Fri, 16 Oct 2026 09:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
