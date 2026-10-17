/**
 * Performance benchmark. Needs the docker MySQL. Run: npm run bench -w @alertly/api
 *
 * 1. Worker throughput: deliveries/second for different batch sizes and concurrency, against
 *    a local receiver that adds 20 ms latency (a realistic fast webhook).
 * 2. API throughput: POST /notifications under load (autocannon), with an API key.
 *
 * Every run uses a fresh throwaway database, so results don't depend on leftover data.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import autocannon from 'autocannon';
import { createTestDb } from '../test/helpers/db';
import { testEnv } from '../test/helpers/env';
import { createLogger } from '../src/lib/logger';
import { systemClock } from '../src/lib/time';
import { createServices } from '../src/services';
import { createSenders } from '../src/modules/channels/senders';
import { DeliveryWorker } from '../src/worker/delivery-worker';
import { buildApp } from '../src/app';
import { decodeId } from '../src/lib/ids';

const RECEIVER_LATENCY_MS = 20;
const DELIVERIES = 600;

async function startReceiver() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => res.writeHead(200).end('ok'), RECEIVER_LATENCY_MS));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    close: () => server.close(),
  };
}

async function setup(overrides: Record<string, string> = {}) {
  const testDb = await createTestDb();
  const env = testEnv(testDb.url, {
    DAILY_NOTIFICATION_QUOTA: '10000000',
    API_RATE_LIMIT_PER_MIN: '10000000',
    DB_POOL_SIZE: '20',
    ...overrides,
  });
  const deps = { env, db: testDb.db, clock: systemClock, log: createLogger(env) };
  const services = createServices(deps);
  const { userId } = await services.auth.register({
    email: 'bench@example.com',
    password: 'bench-password-1',
  });
  return { testDb, env, deps, services, userId };
}

async function benchWorker(batchSize: number, concurrency: number) {
  const receiver = await startReceiver();
  const { testDb, env, deps, services, userId } = await setup();
  const ch = await services.channels.create(userId, {
    type: 'webhook',
    name: 'bench',
    config: { url: receiver.url },
  });
  const channelId = decodeId('ch', ch.id);
  for (let i = 0; i < DELIVERIES; i++) {
    await services.notifications.create(
      userId,
      { title: `n${i}`, body: '', channelIds: [channelId], priority: 'normal' },
      { source: 'api' },
    );
  }

  const worker = new DeliveryWorker(deps, createSenders(env, systemClock), {
    workerId: 'bench',
    batchSize,
    concurrency,
  });
  const t0 = performance.now();
  let delivered = 0;
  for (;;) {
    const s = await worker.runOnce();
    delivered += s.delivered;
    if (s.claimed === 0) break;
  }
  const sec = (performance.now() - t0) / 1000;
  receiver.close();
  await testDb.drop();
  return {
    batchSize,
    concurrency,
    delivered,
    seconds: +sec.toFixed(2),
    perSecond: Math.round(delivered / sec),
  };
}

async function benchApi() {
  const { testDb, deps, services, userId } = await setup();
  await services.channels.create(userId, {
    type: 'email',
    name: 'a',
    config: { to: 'a@example.com' },
  });
  await services.channels.create(userId, {
    type: 'email',
    name: 'b',
    config: { to: 'b@example.com' },
  });
  const { key } = await services.apiKeys.create(userId, 'bench');
  const server = buildApp(deps, services).listen(0);
  const port = (server.address() as AddressInfo).port;

  const result = await autocannon({
    url: `http://127.0.0.1:${port}/api/v1/notifications`,
    method: 'POST',
    connections: 20,
    duration: 10,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ title: 'load test', body: 'hello', data: { n: 1 } }),
  });
  server.close();
  await testDb.drop();
  return {
    requests: result.requests.total,
    perSecond: Math.round(result.requests.average),
    latencyP50ms: result.latency.p50,
    latencyP99ms: result.latency.p99,
    non2xx: result.non2xx,
  };
}

const worker = [];
for (const [b, c] of [
  [1, 1],
  [20, 1],
  [20, 5],
  [20, 10],
] as const) {
  worker.push(await benchWorker(b, c));
  console.log('worker', worker.at(-1));
}
const api = await benchApi();
console.log('api', api);

console.log(
  '\n| batch | concurrency | deliveries | seconds | deliveries/s |\n| --- | --- | --- | --- | --- |',
);
for (const w of worker)
  console.log(
    `| ${w.batchSize} | ${w.concurrency} | ${w.delivered} | ${w.seconds} | ${w.perSecond} |`,
  );
console.log(
  `\nPOST /notifications: ${api.perSecond} req/s, p50 ${api.latencyP50ms} ms, p99 ${api.latencyP99ms} ms, non-2xx ${api.non2xx}`,
);
process.exit(0);
