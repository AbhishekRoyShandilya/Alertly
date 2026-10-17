import type { Deps } from './context';
import { createAuthService } from './modules/auth/service';
import { createApiKeysService } from './modules/api-keys/service';
import { createUsageService } from './modules/usage/service';
import { createNotificationsService } from './modules/notifications/service';
import { createChannelsService } from './modules/channels/service';
import { createDeliveriesService } from './modules/deliveries/service';

/**
 * Wires every service together once. The API, the worker and the scheduler all call this,
 * so they share exactly the same business logic.
 */
export function createServices(deps: Deps) {
  const usage = createUsageService(deps);
  const auth = createAuthService(deps);
  const apiKeys = createApiKeysService(deps);
  const notifications = createNotificationsService(deps);
  const channels = createChannelsService(deps, { notifications });
  const deliveries = createDeliveriesService(deps);
  return { usage, auth, apiKeys, notifications, channels, deliveries };
}
export type Services = ReturnType<typeof createServices>;
