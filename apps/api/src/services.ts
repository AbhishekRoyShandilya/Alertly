import type { Deps } from './context';
import { createAuthService } from './modules/auth/service';
import { createApiKeysService } from './modules/api-keys/service';
import { createUsageService } from './modules/usage/service';
import { createNotificationsService } from './modules/notifications/service';
import { createChannelsService } from './modules/channels/service';
import { createDeliveriesService } from './modules/deliveries/service';
import { createPriceService } from './modules/prices/service';
import { createAlertsService } from './modules/alerts/service';
import type { ProviderRegistry } from './modules/prices/providers';

/**
 * Wires every service together once. The API, the worker and the scheduler all call this,
 * so they share exactly the same business logic. `providers` lets tests inject a
 * controllable simulated price feed.
 */
export function createServices(deps: Deps, opts: { providers?: ProviderRegistry } = {}) {
  const usage = createUsageService(deps);
  const auth = createAuthService(deps);
  const apiKeys = createApiKeysService(deps);
  const notifications = createNotificationsService(deps);
  const channels = createChannelsService(deps, { notifications });
  const deliveries = createDeliveriesService(deps);
  const prices = createPriceService(deps, opts.providers);
  const alerts = createAlertsService(deps, { notifications, prices });
  return { usage, auth, apiKeys, notifications, channels, deliveries, prices, alerts };
}
export type Services = ReturnType<typeof createServices>;
