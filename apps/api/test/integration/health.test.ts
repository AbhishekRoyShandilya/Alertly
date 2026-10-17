import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('health and errors', () => {
  it('GET /health is ok', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready reports the applied migration', async () => {
    const res = await request(ctx.app).get('/api/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body.migration).toBe('001_init');
  });

  it('unknown routes return problem JSON with the request id', async () => {
    const res = await request(ctx.app).get('/api/v1/nope').set('X-Request-Id', 'abc-123');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.body).toMatchObject({ type: 'not_found', status: 404, requestId: 'abc-123' });
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('bad_request');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
