import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/context';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('OpenAPI docs', () => {
  it('serves a document generated from the shared schemas', async () => {
    const res = await request(ctx.app).get('/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toContain('/api/v1/notifications');
    expect(res.body.paths['/api/v1/notifications'].post.parameters[0].name).toBe('Idempotency-Key');
    // Named components come from .meta({ id }) in packages/shared
    expect(res.body.components.schemas).toHaveProperty('CreateNotificationInput');
    expect(res.body.components.schemas).toHaveProperty('Problem');
  });

  it('serves Swagger UI', async () => {
    const res = await request(ctx.app).get('/docs/').redirects(1);
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
