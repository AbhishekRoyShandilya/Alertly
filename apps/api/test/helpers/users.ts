import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';

export const PASSWORD = 'correct-horse-battery';

/** Registers a fresh user and returns a Supertest agent that carries the session cookie. */
export async function signUp(
  app: Express,
  email = `u_${randomBytes(4).toString('hex')}@example.com`,
) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, name: 'Test' });
  if (res.status !== 201)
    throw new Error(`signUp failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user as { id: string; email: string }, email };
}

/** Creates an API key for the signed-in agent and returns the full key. */
export async function createKey(agent: ReturnType<typeof request.agent>, name = 'test key') {
  const res = await agent.post('/api/v1/api-keys').send({ name });
  if (res.status !== 201) throw new Error(`createKey failed: ${res.status}`);
  return res.body.key as string;
}
