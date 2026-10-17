import type { Deps } from './context';
import { createAuthService } from './modules/auth/service';
import { createApiKeysService } from './modules/api-keys/service';
import { createUsageService } from './modules/usage/service';

/**
 * Wires every service together once. The API, the worker and the scheduler all call this,
 * so they share exactly the same business logic.
 */
export function createServices(deps: Deps) {
  const usage = createUsageService(deps);
  const auth = createAuthService(deps);
  const apiKeys = createApiKeysService(deps);
  return { usage, auth, apiKeys };
}
export type Services = ReturnType<typeof createServices>;
