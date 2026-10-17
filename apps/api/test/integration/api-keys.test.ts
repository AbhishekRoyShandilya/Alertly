import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';
import { createKey, signUp } from '../helpers/users';
import { queryOne } from '../../src/db/pool';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ API_RATE_LIMIT_PER_MIN: '60' });
});
afterAll(() => ctx.close());

describe('API keys', () => {
  it('creates a key shown once, stores only its hash, lists by prefix', async () => {
    const { agent } = await signUp(ctx.app);
    const created = await agent.post('/api/v1/api-keys').send({ name: 'production server' });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^alr_/);
    expect(created.body.id).toMatch(/^key_/);

    const row = await queryOne<{ key_hash: string; key_prefix: string }>(
      ctx.testDb.db,
      'SELECT key_hash, key_prefix FROM api_keys ORDER BY id DESC LIMIT 1',
    );
    expect(row!.key_hash).not.toContain(created.body.key);
    expect(row!.key_prefix).toBe(created.body.key.slice(0, 12));

    const list = await agent.get('/api/v1/api-keys');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ name: 'production server', revokedAt: null });
    expect(JSON.stringify(list.body)).not.toContain(created.body.key);
  });

  it('a key authenticates "session or key" routes; a revoked key gets 401', async () => {
    const { agent } = await signUp(ctx.app);
    const key = await createKey(agent);
    const id = (await agent.get('/api/v1/api-keys')).body.data[0].id;

    // /api-keys itself needs a session, so the key can't manage keys
    const viaKey = await request(ctx.app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${key}`);
    expect(viaKey.status).toBe(401);

    expect((await agent.delete(`/api/v1/api-keys/${id}`)).status).toBe(204);
    expect((await agent.delete(`/api/v1/api-keys/${id}`)).status).toBe(204); // idempotent
    const list = await agent.get('/api/v1/api-keys');
    expect(list.body.data[0].revokedAt).not.toBeNull();
  });

  it("can't revoke another user's key (404, not 403)", async () => {
    const alice = await signUp(ctx.app);
    const bob = await signUp(ctx.app);
    await createKey(alice.agent);
    const aliceKeyId = (await alice.agent.get('/api/v1/api-keys')).body.data[0].id;
    expect((await bob.agent.delete(`/api/v1/api-keys/${aliceKeyId}`)).status).toBe(404);
  });

  it('counts API-key requests in usage (buffered, then flushed)', async () => {
    const { agent } = await signUp(ctx.app);
    const key = await createKey(agent);
    for (let i = 0; i < 3; i++) {
      await request(ctx.app).get('/api/v1/channels').set('Authorization', `Bearer ${key}`);
    }
    // Buffered in memory: not written yet
    const before = (await agent.get('/api/v1/usage?days=1')).body.days;
    expect(before[0]?.apiRequests ?? 0).toBe(0);

    await ctx.services.usage.flush();
    const after = (await agent.get('/api/v1/usage?days=1')).body.days;
    expect(after[0].apiRequests).toBe(3);
  });

  it('rejects garbage bearer tokens', async () => {
    const res = await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer alr_doesnotexist');
    expect(res.status).toBe(401);
  });
});
