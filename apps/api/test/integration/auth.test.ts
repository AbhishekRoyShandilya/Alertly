import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';
import { PASSWORD, signUp } from '../helpers/users';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('auth', () => {
  it('register sets an httpOnly session cookie and /me works', async () => {
    const agent = request.agent(ctx.app);
    const res = await agent
      .post('/api/v1/auth/register')
      .send({ email: 'Alice@Example.com', password: PASSWORD, name: 'Alice' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', name: 'Alice' });
    expect(res.body.user.id).toMatch(/^usr_/);
    expect(res.body.user.password_hash).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/alertly_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@example.com');
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await signUp(ctx.app, 'dup@example.com');
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ email: 'DUP@example.com', password: PASSWORD });
    expect(res.status).toBe(409);
  });

  it('validates input with field messages (422)', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/email/);
    expect(res.body.detail).toMatch(/password/);
  });

  it('login works; wrong password and unknown email give the same 401', async () => {
    await signUp(ctx.app, 'bob@example.com');

    const ok = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'bob@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);

    const wrongPw = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'bob@example.com', password: 'nope-nope-nope' });
    const noUser = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'nope-nope-nope' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.detail).toBe(noUser.body.detail);
  });

  it('logout clears the cookie', async () => {
    const { agent } = await signUp(ctx.app);
    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a tampered or expired session token', async () => {
    const { agent } = await signUp(ctx.app);
    // Forged cookie
    const forged = await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'alertly_session=eyJhbGciOiJIUzI1NiJ9.e30.x');
    expect(forged.status).toBe(401);
    // Expired: move the clock 8 days forward (sessions last 7)
    ctx.clock.advance(8 * 24 * 3600 * 1000);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    ctx.clock.set(new Date());
  });

  it('rate limits login attempts per IP (5 per minute)', async () => {
    const fresh = await createTestContext();
    try {
      const attempt = () =>
        request(fresh.app)
          .post('/api/v1/auth/login')
          .send({ email: 'x@example.com', password: 'wrong-password' });
      for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await fresh.close();
    }
  });
});
