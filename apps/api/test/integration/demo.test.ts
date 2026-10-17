import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';
import { seedDemo } from '../../src/db/seed';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('demo account', () => {
  it('seeds once, and is read-only except for harmless actions', async () => {
    expect((await seedDemo(ctx.deps, ctx.services)).created).toBe(true);
    expect((await seedDemo(ctx.deps, ctx.services)).created).toBe(false); // idempotent

    const agent = request.agent(ctx.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: ctx.deps.env.DEMO_EMAIL, password: ctx.deps.env.DEMO_PASSWORD });
    expect(login.status).toBe(200);

    const channels = (await agent.get('/api/v1/channels')).body.data;
    expect(channels.length).toBeGreaterThanOrEqual(1);
    expect((await agent.get('/api/v1/alerts')).body.data).toHaveLength(2);

    // blocked
    const del = await agent.delete(`/api/v1/channels/${channels[0].id}`);
    expect(del.status).toBe(403);
    expect(del.body.detail).toMatch(/read-only/);
    expect((await agent.post('/api/v1/api-keys').send({ name: 'x' })).status).toBe(403);
    expect((await agent.post('/api/v1/notifications').send({ title: 'x' })).status).toBe(403);

    // allowed
    expect((await agent.post(`/api/v1/channels/${channels[0].id}/test`)).status).toBe(202);
    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
  });
});
