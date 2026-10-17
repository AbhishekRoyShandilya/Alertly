import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';
import { createKey, signUp } from '../helpers/users';
import { exec, queryOne } from '../../src/db/pool';
import { decryptSecret } from '../../src/lib/crypto';
import { decodeId } from '../../src/lib/ids';

let ctx: TestContext;
let strict: TestContext; // WEBHOOK_ALLOW_PRIVATE=false, like production
beforeAll(async () => {
  [ctx, strict] = await Promise.all([
    createTestContext(),
    createTestContext({ WEBHOOK_ALLOW_PRIVATE: 'false' }),
  ]);
});
afterAll(() => Promise.all([ctx.close(), strict.close()]));

describe('channels', () => {
  it('creates an email channel', async () => {
    const { agent } = await signUp(ctx.app);
    const res = await agent
      .post('/api/v1/channels')
      .send({ type: 'email', name: 'Me', config: { to: 'me@example.com' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'email', status: 'active', verifiedAt: null });
    expect(res.body.id).toMatch(/^ch_/);
    expect(res.body.secret).toBeUndefined();
  });

  it('validates config per type (discriminated union)', async () => {
    const { agent } = await signUp(ctx.app);
    const bad = await agent
      .post('/api/v1/channels')
      .send({ type: 'email', name: 'x', config: { url: 'https://example.com' } });
    expect(bad.status).toBe(422);
    expect(bad.body.detail).toMatch(/config\.to/);
  });

  it('webhook: returns the signing secret once and stores it encrypted', async () => {
    const { agent } = await signUp(ctx.app);
    const res = await agent
      .post('/api/v1/channels')
      .send({ type: 'webhook', name: 'Hook', config: { url: 'http://127.0.0.1:9/hook' } });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const row = await queryOne<{ secret_enc: Buffer }>(
      ctx.testDb.db,
      'SELECT secret_enc FROM channels WHERE type = "webhook" ORDER BY id DESC LIMIT 1',
    );
    expect(row!.secret_enc.toString('utf8')).not.toContain(res.body.secret);
    expect(decryptSecret(row!.secret_enc, ctx.deps.env.encryptionKey)).toBe(res.body.secret);

    // GET never shows it again
    const got = await agent.get(`/api/v1/channels/${res.body.id}`);
    expect(got.body.secret).toBeUndefined();

    // rotate returns a new one
    const rotated = await agent.post(`/api/v1/channels/${res.body.id}/rotate-secret`);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(res.body.secret);
  });

  it('SSRF: rejects webhooks to private addresses when not explicitly allowed', async () => {
    const { agent } = await signUp(strict.app);
    for (const url of ['http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://10.0.0.5/']) {
      const res = await agent
        .post('/api/v1/channels')
        .send({ type: 'webhook', name: 'h', config: { url } });
      expect(res.status, url).toBe(422);
      expect(res.body.detail).toMatch(/not allowed/);
    }
  });

  it('updates name/status; changing config clears verification', async () => {
    const { agent } = await signUp(ctx.app);
    const ch = (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'email', name: 'A', config: { to: 'a@example.com' } })
    ).body;
    await exec(ctx.testDb.db, 'UPDATE channels SET verified_at = NOW(3) WHERE id = ?', [
      decodeId('ch', ch.id),
    ]);
    const renamed = await agent
      .patch(`/api/v1/channels/${ch.id}`)
      .send({ name: 'B', status: 'disabled' });
    expect(renamed.body).toMatchObject({ name: 'B', status: 'disabled' });

    const badCfg = await agent.patch(`/api/v1/channels/${ch.id}`).send({ config: { to: 'nope' } });
    expect(badCfg.status).toBe(422);

    const newCfg = await agent
      .patch(`/api/v1/channels/${ch.id}`)
      .send({ config: { to: 'b@example.com' } });
    expect(newCfg.body.config).toEqual({ to: 'b@example.com' });
    expect(newCfg.body.verifiedAt).toBeNull();
  });

  it('soft-deletes: gone from the API, row kept', async () => {
    const { agent } = await signUp(ctx.app);
    const ch = (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'email', name: 'Del', config: { to: 'd@example.com' } })
    ).body;
    expect((await agent.delete(`/api/v1/channels/${ch.id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/channels/${ch.id}`)).status).toBe(404);
    const row = await queryOne<{ n: number }>(
      ctx.testDb.db,
      'SELECT COUNT(*) AS n FROM channels WHERE name = "Del" AND deleted_at IS NOT NULL',
    );
    expect(row!.n).toBe(1);
  });

  it('isolates users: 404 for someone else’s channel', async () => {
    const alice = await signUp(ctx.app);
    const bob = await signUp(ctx.app);
    const ch = (
      await alice.agent
        .post('/api/v1/channels')
        .send({ type: 'email', name: 'Alice', config: { to: 'alice@example.com' } })
    ).body;
    expect((await bob.agent.get(`/api/v1/channels/${ch.id}`)).status).toBe(404);
    expect(
      (await bob.agent.patch(`/api/v1/channels/${ch.id}`).send({ name: 'pwned' })).status,
    ).toBe(404);
    expect((await bob.agent.delete(`/api/v1/channels/${ch.id}`)).status).toBe(404);
  });

  it('API key can read channels but not create them', async () => {
    const { agent } = await signUp(ctx.app);
    const key = await createKey(agent);
    const list = await request(ctx.app)
      .get('/api/v1/channels')
      .set('Authorization', `Bearer ${key}`);
    expect(list.status).toBe(200);
    const create = await request(ctx.app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${key}`)
      .send({ type: 'email', name: 'x', config: { to: 'x@example.com' } });
    expect(create.status).toBe(401);
  });

  it('test send creates a source=test notification with one pending delivery', async () => {
    const { agent } = await signUp(ctx.app);
    const ch = (
      await agent
        .post('/api/v1/channels')
        .send({ type: 'email', name: 'T', config: { to: 't@example.com' } })
    ).body;
    const res = await agent.post(`/api/v1/channels/${ch.id}/test`);
    expect(res.status).toBe(202);
    const detail = await agent.get(`/api/v1/notifications/${res.body.notificationId}`);
    expect(detail.body.source).toBe('test');
    expect(detail.body.deliveries).toHaveLength(1);
    expect(detail.body.deliveries[0]).toMatchObject({ channelId: ch.id, status: 'pending' });
  });
});
