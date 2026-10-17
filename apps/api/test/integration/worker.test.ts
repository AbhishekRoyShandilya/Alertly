import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context';
import { startMockServer, type MockServer } from '../helpers/mock-server';
import { signUp } from '../helpers/users';
import { exec, query, queryOne } from '../../src/db/pool';
import { decodeId } from '../../src/lib/ids';
import { verifyWebhook } from '../../src/lib/crypto';
import { createSenders } from '../../src/modules/channels/senders';
import type { EmailMessage } from '../../src/modules/channels/senders/email';
import { DeliveryWorker } from '../../src/worker/delivery-worker';

let ctx: TestContext;
let mock: MockServer;
const emails: EmailMessage[] = [];

beforeAll(async () => {
  mock = await startMockServer();
  ctx = await createTestContext({ TELEGRAM_BOT_TOKEN: 'TEST', TELEGRAM_API_URL: mock.url });
});
afterAll(async () => {
  await mock.close();
  await ctx.close();
});
beforeEach(() => mock.reset());

function makeWorker(id = 'w1', batchSize = 20) {
  const senders = createSenders(ctx.deps.env, ctx.clock, {
    mailer: { send: async (m) => void emails.push(m) },
    webhookTimeoutMs: 300,
  });
  return new DeliveryWorker(ctx.deps, senders, { workerId: id, batchSize, concurrency: 5 });
}

/** A user with one webhook channel pointing at the mock server. */
async function webhookUser() {
  const { agent } = await signUp(ctx.app);
  const ch = await agent
    .post('/api/v1/channels')
    .send({ type: 'webhook', name: 'mock', config: { url: `${mock.url}/hook` } });
  const notify = async (title = 'hello') => {
    const n = await agent.post('/api/v1/notifications').send({ title, channelIds: [ch.body.id] });
    const detail = await agent.get(`/api/v1/notifications/${n.body.id}`);
    return {
      notificationId: n.body.id as string,
      deliveryId: detail.body.deliveries[0].id as string,
    };
  };
  const delivery = async (id: string) => (await agent.get(`/api/v1/deliveries/${id}`)).body;
  return { agent, channel: ch.body, secret: ch.body.secret as string, notify, delivery };
}

describe('delivery worker', () => {
  it('200 → delivered with one attempt, signed headers, channel verified', async () => {
    const u = await webhookUser();
    const { notificationId, deliveryId } = await u.notify('Disk almost full');

    const s = await makeWorker().runOnce();
    expect(s).toMatchObject({ claimed: 1, delivered: 1 });

    const d = await u.delivery(deliveryId);
    expect(d.status).toBe('delivered');
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0]).toMatchObject({ attemptNo: 1, outcome: 'success', httpStatus: 200 });

    const req = mock.requests[0]!;
    expect(req.headers['x-alertly-notification-id']).toBe(notificationId);
    expect(req.headers['x-alertly-delivery-attempt']).toBe('1');
    expect(JSON.parse(req.body)).toMatchObject({ id: notificationId, title: 'Disk almost full' });
    const nowSec = Math.floor(ctx.clock.now().getTime() / 1000);
    expect(
      verifyWebhook(u.secret, String(req.headers['x-alertly-signature']), req.body, nowSec),
    ).toBe(true);

    const ch = await u.agent.get(`/api/v1/channels/${u.channel.id}`);
    expect(ch.body.verifiedAt).not.toBeNull();
  });

  it('500 then 200 → one retry, and not before next_attempt_at', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    mock.respond(500, 200);
    const worker = makeWorker();

    expect(await worker.runOnce()).toMatchObject({ retried: 1 });
    const afterFirst = await u.delivery(deliveryId);
    expect(afterFirst.status).toBe('retrying');
    expect(afterFirst.lastError).toBe('HTTP 500');

    // Not due yet: nothing is claimed.
    expect((await worker.runOnce()).claimed).toBe(0);

    // Move past the backoff (max 30 s for the first retry).
    ctx.clock.advance(31_000);
    expect(await worker.runOnce()).toMatchObject({ delivered: 1 });
    const d = await u.delivery(deliveryId);
    expect(d.status).toBe('delivered');
    expect(d.attempts.map((a: { httpStatus: number }) => a.httpStatus)).toEqual([500, 200]);
    expect(mock.requests[1]!.headers['x-alertly-delivery-attempt']).toBe('2');
  });

  it('always 500 → dead after max attempts; manual retry starts a new round', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    mock.setDefault(500);
    const worker = makeWorker();

    for (let i = 0; i < 6; i++) {
      await worker.runOnce();
      ctx.clock.advance(3 * 3600_000); // longer than the biggest backoff
    }
    const dead = await u.delivery(deliveryId);
    expect(dead.status).toBe('dead');
    expect(dead.attempts).toHaveLength(6);
    expect(dead.lastError).toMatch(/Gave up after 6 attempts/);
    expect((await worker.runOnce()).claimed).toBe(0); // dead rows are never picked up

    mock.setDefault(200);
    expect((await u.agent.post(`/api/v1/deliveries/${deliveryId}/retry`)).status).toBe(200);
    expect(await worker.runOnce()).toMatchObject({ delivered: 1 });
    const d = await u.delivery(deliveryId);
    expect(d.status).toBe('delivered');
    // Attempt numbers keep counting across rounds: 1..6, then 7
    expect(d.attempts.map((a: { attemptNo: number }) => a.attemptNo)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('404 → failed immediately, never retried', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    mock.respond(404);
    expect(await makeWorker().runOnce()).toMatchObject({ failed: 1 });
    const d = await u.delivery(deliveryId);
    expect(d.status).toBe('failed');
    expect(d.attempts[0].outcome).toBe('permanent_error');
  });

  it('429 with Retry-After waits at least that long', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    mock.respond({ status: 429, headers: { 'Retry-After': '600' } });
    await makeWorker().runOnce();
    const d = await u.delivery(deliveryId);
    expect(d.status).toBe('retrying');
    expect(new Date(d.nextAttemptAt).getTime() - ctx.clock.now().getTime()).toBeGreaterThanOrEqual(
      600_000,
    );
  });

  it('a receiver that hangs times out and is retried', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    mock.respond('hang');
    await makeWorker().runOnce();
    const d = await u.delivery(deliveryId);
    expect(d.status).toBe('retrying');
    expect(d.lastError).toMatch(/Timed out/);
  });

  it('two workers in parallel claim disjoint rows: every delivery sent exactly once', async () => {
    const u = await webhookUser();
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add((await u.notify(`n${i}`)).notificationId);

    const w1 = makeWorker('w1', 7);
    const w2 = makeWorker('w2', 7);
    for (;;) {
      const [a, b] = await Promise.all([w1.runOnce(), w2.runOnce()]);
      if (a.claimed + b.claimed === 0) break;
    }
    const sent = mock.requests.map((r) => String(r.headers['x-alertly-notification-id']));
    expect(sent).toHaveLength(30);
    expect(new Set(sent)).toEqual(ids); // no duplicates, none missing

    const owners = await query<{ locked_by: string | null; status: string }>(
      ctx.testDb.db,
      'SELECT DISTINCT status FROM deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.title LIKE "n%"',
    );
    expect(owners.map((o) => o.status)).toEqual(['delivered']);
  });

  it('recovers a delivery stuck in "sending" after a worker crash', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    const id = decodeId('dlv', deliveryId);
    // Simulate a worker that claimed the row 10 minutes ago and died.
    await exec(
      ctx.testDb.db,
      "UPDATE deliveries SET status='sending', next_attempt_at=NULL, locked_by='dead-worker', locked_at=?, attempt_count=1, total_attempts=1 WHERE id = ?",
      [new Date(ctx.clock.now().getTime() - 600_000), id],
    );
    const s = await makeWorker('rescuer').runOnce();
    expect(s.delivered).toBe(1);
    const row = await queryOne<{ status: string; total_attempts: number }>(
      ctx.testDb.db,
      'SELECT status, total_attempts FROM deliveries WHERE id = ?',
      [id],
    );
    expect(row).toEqual({ status: 'delivered', total_attempts: 2 });
  });

  it('a late result from a worker that lost its lock does not overwrite state', async () => {
    const u = await webhookUser();
    const { deliveryId } = await u.notify();
    const id = decodeId('dlv', deliveryId);
    mock.respond('hang');
    const slow = makeWorker('slow');
    const running = slow.runOnce();
    // While "slow" is waiting on the hanging receiver, recovery hands the row to someone else.
    await new Promise((r) => setTimeout(r, 50));
    await exec(ctx.testDb.db, "UPDATE deliveries SET locked_by = 'other' WHERE id = ?", [id]);
    const s = await running;
    expect(s.lost).toBe(1);
    const row = await queryOne<{ status: string }>(
      ctx.testDb.db,
      'SELECT status FROM deliveries WHERE id = ?',
      [id],
    );
    expect(row!.status).toBe('sending'); // untouched: it belongs to "other" now
  });

  it('high priority is claimed before normal', async () => {
    const { agent } = await signUp(ctx.app);
    const ch = (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'webhook', name: 'p', config: { url: `${mock.url}/p` } })
    ).body;
    await agent.post('/api/v1/notifications').send({ title: 'normal-1', channelIds: [ch.id] });
    await agent.post('/api/v1/notifications').send({ title: 'normal-2', channelIds: [ch.id] });
    await agent
      .post('/api/v1/notifications')
      .send({ title: 'urgent', channelIds: [ch.id], priority: 'high' });
    await makeWorker('prio', 1).runOnce();
    expect(JSON.parse(mock.requests[0]!.body).title).toBe('urgent');
    while ((await makeWorker('drain', 20).runOnce()).claimed > 0);
  });

  it('delivers email and telegram through their senders', async () => {
    const { agent } = await signUp(ctx.app);
    const email = (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'email', name: 'e', config: { to: 'ops@example.com' } })
    ).body;
    const tg = (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'telegram', name: 't', config: { chatId: '12345' } })
    ).body;
    mock.respond({ status: 200, body: '{"ok":true,"result":{}}' });
    const n = await agent
      .post('/api/v1/notifications')
      .send({ title: 'BTC above 70k', body: 'now 70,123', channelIds: [email.id, tg.id] });

    while ((await makeWorker('multi').runOnce()).claimed > 0);

    const detail = (await agent.get(`/api/v1/notifications/${n.body.id}`)).body;
    expect(detail.deliveries.map((d: { status: string }) => d.status)).toEqual([
      'delivered',
      'delivered',
    ]);
    expect(emails.at(-1)).toMatchObject({ to: 'ops@example.com', subject: 'BTC above 70k' });
    const tgReq = mock.requests.find((r) => r.path === '/botTEST/sendMessage')!;
    expect(JSON.parse(tgReq.body)).toMatchObject({ chat_id: '12345' });
    expect(JSON.parse(tgReq.body).text).toContain('now 70,123');
  });
});
