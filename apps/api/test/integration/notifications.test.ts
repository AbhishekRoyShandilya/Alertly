import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';
import { createKey, signUp } from '../helpers/users';
import { exec, queryOne } from '../../src/db/pool';
import { decodeId } from '../../src/lib/ids';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ DAILY_NOTIFICATION_QUOTA: '1000' });
});
afterAll(() => ctx.close());

/** A user with two email channels and an API key. */
async function setup() {
  const { agent } = await signUp(ctx.app);
  const mk = async (name: string) =>
    (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'email', name, config: { to: `${name}@example.com` } })
    ).body.id as string;
  const ch1 = await mk('one');
  const ch2 = await mk('two');
  const key = await createKey(agent);
  const api = () =>
    request(ctx.app).post('/api/v1/notifications').set('Authorization', `Bearer ${key}`);
  return { agent, ch1, ch2, key, api };
}

describe('POST /notifications', () => {
  it('fans out to every active channel by default, in one transaction', async () => {
    const { agent, api } = await setup();
    const res = await api().send({
      title: 'Disk almost full',
      body: 'server-3 at 92%',
      data: { pct: 92 },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      source: 'api',
      title: 'Disk almost full',
      priority: 'normal',
      data: { pct: 92 },
    });

    const detail = await agent.get(`/api/v1/notifications/${res.body.id}`);
    expect(detail.body.deliveries).toHaveLength(2);
    expect(detail.body.deliveries.every((d: { status: string }) => d.status === 'pending')).toBe(
      true,
    );
  });

  it('targets only the given channelIds', async () => {
    const { agent, ch2, api } = await setup();
    const res = await api().send({ title: 'only two', channelIds: [ch2], priority: 'high' });
    const detail = await agent.get(`/api/v1/notifications/${res.body.id}`);
    expect(detail.body.deliveries.map((d: { channelId: string }) => d.channelId)).toEqual([ch2]);
  });

  it("rejects channels that aren't yours or are disabled", async () => {
    const { agent, ch1, api } = await setup();
    const other = await setup();
    expect((await api().send({ title: 'x', channelIds: [other.ch1] })).status).toBe(422);
    await agent.patch(`/api/v1/channels/${ch1}`).send({ status: 'disabled' });
    const res = await api().send({ title: 'x', channelIds: [ch1] });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain(ch1);
  });

  it('422 when the user has no active channels', async () => {
    const { agent } = await signUp(ctx.app);
    const res = await agent.post('/api/v1/notifications').send({ title: 'nowhere' });
    expect(res.status).toBe(422);
  });

  describe('idempotency', () => {
    it('same key + same body: one row; second response is 200 + Idempotent-Replayed', async () => {
      const { api } = await setup();
      const body = { title: 'Deploy finished', body: 'v1.2.3' };
      const first = await api().set('Idempotency-Key', 'deploy-123').send(body);
      const second = await api().set('Idempotency-Key', 'deploy-123').send(body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.id).toBe(first.body.id);

      const n = await queryOne<{ n: number }>(
        ctx.testDb.db,
        "SELECT COUNT(*) AS n FROM notifications WHERE idempotency_key = 'deploy-123'",
      );
      expect(n!.n).toBe(1);
    });

    it('same key + different body: 409', async () => {
      const { api } = await setup();
      await api().set('Idempotency-Key', 'k-409').send({ title: 'A' });
      const res = await api().set('Idempotency-Key', 'k-409').send({ title: 'B' });
      expect(res.status).toBe(409);
    });

    it('key order in the body does not matter (stable hash)', async () => {
      const { api } = await setup();
      await api()
        .set('Idempotency-Key', 'k-order')
        .send({ title: 'A', data: { x: 1, y: 2 } });
      const res = await api()
        .set('Idempotency-Key', 'k-order')
        .send({ data: { y: 2, x: 1 }, title: 'A' });
      expect(res.status).toBe(200);
    });

    it('concurrent requests with one key create exactly one notification', async () => {
      const { api } = await setup();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          api().set('Idempotency-Key', 'race-1').send({ title: 'race' }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(7);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    });

    it('keys are scoped per user', async () => {
      const a = await setup();
      const b = await setup();
      const ra = await a.api().set('Idempotency-Key', 'shared').send({ title: 'x' });
      const rb = await b.api().set('Idempotency-Key', 'shared').send({ title: 'x' });
      expect(ra.status).toBe(201);
      expect(rb.status).toBe(201);
      expect(ra.body.id).not.toBe(rb.body.id);
    });

    it('rejects oversized or non-printable keys', async () => {
      const { api } = await setup();
      expect(
        (await api().set('Idempotency-Key', 'x'.repeat(129)).send({ title: 'x' })).status,
      ).toBe(422);
    });
  });

  it('enforces the daily quota with 429', async () => {
    const small = await createTestContext({ DAILY_NOTIFICATION_QUOTA: '2' });
    try {
      const { agent } = await signUp(small.app);
      await agent
        .post('/api/v1/channels')
        .send({ type: 'email', name: 'q', config: { to: 'q@example.com' } });
      expect((await agent.post('/api/v1/notifications').send({ title: '1' })).status).toBe(201);
      expect((await agent.post('/api/v1/notifications').send({ title: '2' })).status).toBe(201);
      const third = await agent.post('/api/v1/notifications').send({ title: '3' });
      expect(third.status).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await small.close();
    }
  });

  it('API-key requests are rate limited with RateLimit headers', async () => {
    const limited = await createTestContext({ API_RATE_LIMIT_PER_MIN: '3' });
    try {
      const { agent } = await signUp(limited.app);
      const key = await createKey(agent);
      const call = () =>
        request(limited.app).get('/api/v1/notifications').set('Authorization', `Bearer ${key}`);
      const first = await call();
      expect(first.headers['ratelimit-limit']).toBe('3');
      expect(first.headers['ratelimit-remaining']).toBe('2');
      await call();
      await call();
      const fourth = await call();
      expect(fourth.status).toBe(429);
      expect(fourth.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});

describe('GET /notifications', () => {
  it('paginates newest first with a stable cursor', async () => {
    const { agent, api } = await setup();
    for (let i = 1; i <= 5; i++) {
      await api().send({ title: `n${i}` });
      ctx.clock.advance(1000);
    }
    const p1 = await agent.get('/api/v1/notifications?limit=2');
    expect(p1.body.data.map((n: { title: string }) => n.title)).toEqual(['n5', 'n4']);

    // A new notification arriving between pages must not shift page 2.
    await api().send({ title: 'n6' });
    const p2 = await agent.get(`/api/v1/notifications?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.data.map((n: { title: string }) => n.title)).toEqual(['n3', 'n2']);
    const p3 = await agent.get(`/api/v1/notifications?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p3.body.data.map((n: { title: string }) => n.title)).toEqual(['n1']);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('filters by source', async () => {
    const { agent, ch1, api } = await setup();
    await api().send({ title: 'from api' });
    await agent.post(`/api/v1/channels/${ch1}/test`);
    const res = await agent.get('/api/v1/notifications?source=test');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].source).toBe('test');
  });
});

describe('deliveries', () => {
  it('lists deliveries with filters and refuses to retry a pending one', async () => {
    const { agent, ch1, api } = await setup();
    await api().send({ title: 'x' });
    const list = await agent.get(`/api/v1/deliveries?channelId=${ch1}`);
    expect(list.body.data).toHaveLength(1);
    const d = list.body.data[0];
    expect(d.channelName).toBe('one');
    expect((await agent.post(`/api/v1/deliveries/${d.id}/retry`)).status).toBe(409);
  });

  it('manual retry of a dead delivery starts a new round, due now', async () => {
    const { agent, api } = await setup();
    const n = await api().send({ title: 'x' });
    const d = (await agent.get(`/api/v1/notifications/${n.body.id}`)).body.deliveries[0];
    await exec(
      ctx.testDb.db,
      "UPDATE deliveries SET status='dead', attempt_count=6, total_attempts=6, last_error='boom' WHERE id = ?",
      [decodeId('dlv', d.id)],
    );
    const res = await agent.post(`/api/v1/deliveries/${d.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'retrying', attemptCount: 0, lastError: null });
    expect(new Date(res.body.nextAttemptAt).getTime()).toBeLessThanOrEqual(
      ctx.clock.now().getTime(),
    );
  });
});
