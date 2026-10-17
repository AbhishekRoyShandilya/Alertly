import type { Deps } from '../context';
import type { Services } from '../services';
import { findUserByEmail } from '../modules/auth/repo';
import { decodeId } from '../lib/ids';

/**
 * Creates the demo account used by the live demo: an email channel, an optional webhook
 * channel (DEMO_WEBHOOK_URL, e.g. a request inspector), and two simulated-price alert rules
 * tuned to fire every few minutes. Safe to run repeatedly: does nothing if the user exists.
 * Goes through the normal services, so seeded data obeys the same rules as real data.
 */
export async function seedDemo(
  deps: Deps,
  services: Services,
): Promise<{ created: boolean; email: string }> {
  const { env, db } = deps;
  if (await findUserByEmail(db, env.DEMO_EMAIL)) return { created: false, email: env.DEMO_EMAIL };

  const { userId } = await services.auth.register({
    email: env.DEMO_EMAIL,
    password: env.DEMO_PASSWORD,
    name: 'Demo',
  });

  const email = await services.channels.create(userId, {
    type: 'email',
    name: 'Demo inbox',
    config: { to: 'demo-inbox@example.com' },
  });
  const channelIds = [decodeId('ch', email.id)];

  if (env.DEMO_WEBHOOK_URL) {
    const hook = await services.channels.create(userId, {
      type: 'webhook',
      name: 'Request inspector',
      config: { url: env.DEMO_WEBHOOK_URL },
    });
    channelIds.push(decodeId('ch', hook.id));
  }

  // The simulated BTC walk starts near 68,000 and moves ±0.3% per tick, so a cross of
  // 68,000 happens every few minutes; a 10-minute cooldown keeps it from spamming.
  await services.alerts.create(
    userId,
    {
      name: 'BTC crosses above 68,000',
      symbol: 'BTCUSDT',
      provider: 'simulated',
      conditionType: 'cross_above',
      threshold: 68_000,
      cooldownMinutes: 10,
      channelIds: [],
    },
    channelIds,
  );
  await services.alerts.create(
    userId,
    {
      name: 'ETH moves 1% in 15 minutes',
      symbol: 'ETHUSDT',
      provider: 'simulated',
      conditionType: 'pct_move',
      threshold: 1,
      windowMinutes: 15,
      cooldownMinutes: 30,
      channelIds: [],
    },
    channelIds,
  );

  return { created: true, email: env.DEMO_EMAIL };
}
