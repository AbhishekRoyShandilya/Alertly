import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context';
import { signUp } from '../helpers/users';
import { query, queryOne } from '../../src/db/pool';
import { AlertScheduler } from '../../src/scheduler/alert-scheduler';

let ctx: TestContext;
let scheduler: AlertScheduler;

beforeAll(async () => {
  ctx = await createTestContext();
  scheduler = new AlertScheduler(ctx.deps, ctx.services.alerts, ctx.services.prices);
});
afterAll(async () => {
  await scheduler.stop();
  await ctx.close();
});

async function userWithChannel() {
  const { agent } = await signUp(ctx.app);
  const ch = (
    await agent
      .post('/api/v1/channels')
      .send({ type: 'email', name: 'ops', config: { to: 'ops@example.com' } })
  ).body;
  return { agent, channelId: ch.id as string };
}

const countAlertNotifications = async (title: string) =>
  (await queryOne<{ n: number }>(
    ctx.testDb.db,
    "SELECT COUNT(*) AS n FROM notifications WHERE source = 'alert' AND title = ?",
    [`Alert: ${title}`],
  ))!.n;

/** Advance past the 10 s price cache so the next tick reads the new simulated price. */
const nextTick = async () => {
  ctx.clock.advance(15_000);
  return scheduler.tick();
};

describe('alert rules API', () => {
  it('creates, lists, updates and deletes a rule', async () => {
    const { agent, channelId } = await userWithChannel();
    const created = await agent.post('/api/v1/alerts').send({
      name: 'BTC above 70k',
      symbol: 'BTCUSDT',
      conditionType: 'above',
      threshold: 70_000,
      cooldownMinutes: 30,
      channelIds: [channelId],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      state: 'armed',
      provider: 'simulated',
      isActive: true,
      channelIds: [channelId],
    });

    const list = await agent.get('/api/v1/alerts');
    expect(list.body.data).toHaveLength(1);

    const paused = await agent
      .patch(`/api/v1/alerts/${created.body.id}`)
      .send({ isActive: false, name: 'renamed' });
    expect(paused.body).toMatchObject({ isActive: false, name: 'renamed' });

    expect((await agent.delete(`/api/v1/alerts/${created.body.id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/alerts/${created.body.id}`)).status).toBe(404);
  });

  it('validates pct_move thresholds and windows, and channel ownership', async () => {
    const { agent, channelId } = await userWithChannel();
    const base = {
      name: 'x',
      symbol: 'ETHUSDT',
      conditionType: 'pct_move',
      channelIds: [channelId],
    };
    expect(
      (await agent.post('/api/v1/alerts').send({ ...base, threshold: 500, windowMinutes: 60 }))
        .status,
    ).toBe(422);
    expect((await agent.post('/api/v1/alerts').send({ ...base, threshold: 5 })).status).toBe(422);
    expect(
      (await agent.post('/api/v1/alerts').send({ ...base, threshold: 5, windowMinutes: 60 }))
        .status,
    ).toBe(201);

    const other = await userWithChannel();
    const res = await agent
      .post('/api/v1/alerts')
      .send({ ...base, threshold: 5, windowMinutes: 60, channelIds: [other.channelId] });
    expect(res.status).toBe(422);
  });

  it('refuses to delete a channel used by an active rule', async () => {
    const { agent, channelId } = await userWithChannel();
    await agent.post('/api/v1/alerts').send({
      name: 'guard',
      symbol: 'BTCUSDT',
      conditionType: 'above',
      threshold: 1,
      channelIds: [channelId],
    });
    expect((await agent.delete(`/api/v1/channels/${channelId}`)).status).toBe(409);
  });
});

describe('scheduler', () => {
  it('a forced cross fires exactly one notification; a second tick in the same minute fires none', async () => {
    const { agent, channelId } = await userWithChannel();
    ctx.sim.freeze('SOLUSDT', 149);
    const rule = (
      await agent.post('/api/v1/alerts').send({
        name: 'SOL crosses 150',
        symbol: 'SOLUSDT',
        conditionType: 'cross_above',
        threshold: 150,
        channelIds: [channelId],
      })
    ).body;

    await nextTick(); // records 149 as the previous price
    expect(await countAlertNotifications('SOL crosses 150')).toBe(0);

    ctx.sim.freeze('SOLUSDT', 151);
    const s = await nextTick();
    expect(s.fired).toBeGreaterThanOrEqual(1);
    expect(await countAlertNotifications('SOL crosses 150')).toBe(1);

    const detail = (await agent.get(`/api/v1/alerts/${rule.id}`)).body;
    expect(detail.state).toBe('triggered');
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ price: 151, conditionType: 'cross_above' });
    expect(detail.events[0].notificationId).toMatch(/^ntf_/);

    // The notification fans out to the rule's channel, with high priority
    const n = (await agent.get(`/api/v1/notifications/${detail.events[0].notificationId}`)).body;
    expect(n).toMatchObject({ source: 'alert', priority: 'high' });
    expect(n.body).toContain('crossed above 150');
    expect(n.deliveries).toHaveLength(1);

    // Price stays above: no second notification
    await nextTick();
    expect(await countAlertNotifications('SOL crosses 150')).toBe(1);
  });

  it('the per-minute idempotency key absorbs a re-fire after a crash', async () => {
    const { agent, channelId } = await userWithChannel();
    ctx.sim.freeze('ADAUSDT', 1);
    const rule = (
      await agent.post('/api/v1/alerts').send({
        name: 'ADA above 0.5',
        symbol: 'ADAUSDT',
        conditionType: 'above',
        threshold: 0.5,
        channelIds: [channelId],
      })
    ).body;
    // The key is per rule per MINUTE, so pin the clock 5 s into a fresh minute; otherwise the
    // two ticks below could straddle a minute boundary (this test was flaky before this line).
    const nextMinute = Math.ceil((ctx.clock.now().getTime() + 15_000) / 60_000) * 60_000;
    ctx.clock.set(new Date(nextMinute + 5_000));
    await scheduler.tick();
    expect(await countAlertNotifications('ADA above 0.5')).toBe(1);

    // Simulate "notification created, then the scheduler crashed before saving the state":
    // put the rule back to armed and tick again within the same minute.
    await query(
      ctx.testDb.db,
      "UPDATE alert_rules SET state = 'armed' WHERE name = 'ADA above 0.5'",
    );
    ctx.clock.advance(1_000);
    await scheduler.tick();
    expect(await countAlertNotifications('ADA above 0.5')).toBe(1);
    expect(rule.id).toMatch(/^alr_/);
  });

  it('pct_move uses the recorded price from windowMinutes ago', async () => {
    const { agent, channelId } = await userWithChannel();
    ctx.sim.freeze('XRPUSDT', 1.0);
    await agent.post('/api/v1/alerts').send({
      name: 'XRP 10% in 5m',
      symbol: 'XRPUSDT',
      conditionType: 'pct_move',
      threshold: 10,
      windowMinutes: 5,
      channelIds: [channelId],
    });
    await nextTick(); // no history 5 min back yet
    ctx.clock.advance(5 * 60_000);
    ctx.sim.freeze('XRPUSDT', 1.12);
    await nextTick();
    expect(await countAlertNotifications('XRP 10% in 5m')).toBe(1);
  });

  it('dry run evaluates without saving or notifying', async () => {
    const { agent, channelId } = await userWithChannel();
    ctx.sim.freeze('DOGEUSDT', 0.5);
    await nextTick();
    const rule = (
      await agent.post('/api/v1/alerts').send({
        name: 'DOGE above 0.2',
        symbol: 'DOGEUSDT',
        conditionType: 'above',
        threshold: 0.2,
        channelIds: [channelId],
      })
    ).body;
    const dry = await agent.post(`/api/v1/alerts/${rule.id}/evaluate`);
    expect(dry.body).toMatchObject({ price: 0.5, fire: true, nextState: 'triggered' });
    expect((await agent.get(`/api/v1/alerts/${rule.id}`)).body.state).toBe('armed');
    expect(await countAlertNotifications('DOGE above 0.2')).toBe(0);
  });

  it('only one scheduler is leader (MySQL advisory lock)', async () => {
    const standby = new AlertScheduler(ctx.deps, ctx.services.alerts, ctx.services.prices);
    try {
      await scheduler.tick(); // make sure the main one holds the lock
      expect((await standby.tick()).skipped).toBe('not_leader');
      await scheduler.stop(); // leader steps down → lock released
      expect((await standby.tick()).skipped).toBeUndefined();
    } finally {
      await standby.stop();
    }
  });

  it('prices endpoint returns the latest snapshot and a sparkline', async () => {
    const { agent } = await userWithChannel();
    await scheduler.tick();
    const res = await agent.get('/api/v1/prices/btcusdt');
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('BTCUSDT');
    expect(res.body.history.length).toBeGreaterThan(0);
    const rows = await query<{ n: number }>(
      ctx.testDb.db,
      'SELECT COUNT(*) AS n FROM price_snapshots',
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});
