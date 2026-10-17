import type { Request, RequestHandler } from 'express';
import type { Deps } from '../context';
import type { AuthContext } from '../types/express';
import { forbidden, unauthorized } from '../lib/errors';
import { API_KEY_PREFIX } from '../lib/crypto';
import { incrementUsage } from '../modules/usage/service';
import { SESSION_COOKIE, type AuthService } from '../modules/auth/service';
import type { ApiKeysService } from '../modules/api-keys/service';
import { RateLimiter } from './rate-limit';

/**
 * Two ways in:
 * - session: httpOnly cookie with a signed JWT (the dashboard)
 * - API key: `Authorization: Bearer alr_…` (other programs), rate limited per key
 *
 * Routes choose: `requireSession` for account management (creating keys, channels, alerts),
 * `requireSessionOrApiKey` for sending notifications and reading data.
 */
export function createAuthMiddleware(
  deps: Deps,
  services: { auth: AuthService; apiKeys: ApiKeysService },
) {
  const { db, clock, env, log } = deps;
  const apiLimiter = new RateLimiter(env.API_RATE_LIMIT_PER_MIN, 60_000, clock);

  async function fromSession(req: Request): Promise<AuthContext | null> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) return null;
    const userId = await services.auth.verifySessionToken(token);
    if (!userId) return null;
    // The user may have been deleted since the token was issued.
    const user = await services.auth.getUser(userId);
    if (!user) return null;
    return { userId, via: 'session', isDemo: user.email === env.DEMO_EMAIL };
  }

  /**
   * The public demo account can look at everything but change nothing, so one reviewer can't
   * break the demo for the next. A few harmless actions stay allowed.
   */
  const DEMO_ALLOWED = [
    /^\/auth\/logout$/,
    /^\/channels\/[^/]+\/test$/,
    /^\/alerts\/[^/]+\/evaluate$/,
  ];
  function assertDemoAllowed(req: Request, auth: AuthContext) {
    if (!auth.isDemo || req.method === 'GET') return;
    const path = req.originalUrl.split('?')[0]!.replace(/^\/api\/v1/, '');
    if (!DEMO_ALLOWED.some((re) => re.test(path))) {
      throw forbidden('The demo account is read-only. Register your own account to try this.');
    }
  }

  async function fromApiKey(req: Request): Promise<AuthContext | null> {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    const key = header.slice(7).trim();
    if (!key.startsWith(API_KEY_PREFIX)) throw unauthorized('Invalid API key');
    const found = await services.apiKeys.authenticate(key);
    if (!found) throw unauthorized('Invalid or revoked API key');
    return { userId: found.userId, via: 'api_key', apiKeyId: found.apiKeyId };
  }

  const requireSession: RequestHandler = async (req, _res, next) => {
    const auth = await fromSession(req);
    if (!auth) throw unauthorized();
    assertDemoAllowed(req, auth);
    req.auth = auth;
    req.log = req.log.child({ userId: auth.userId });
    next();
  };

  const requireSessionOrApiKey: RequestHandler = async (req, res, next) => {
    const auth = (await fromSession(req)) ?? (await fromApiKey(req));
    if (!auth) throw unauthorized('Log in, or send an API key as "Authorization: Bearer alr_…"');
    assertDemoAllowed(req, auth);
    if (auth.via === 'api_key') {
      apiLimiter.check(`key:${auth.apiKeyId}`, res);
      incrementUsage(db, auth.userId, 'api_requests', clock.now()).catch((err: unknown) =>
        log.warn({ err }, 'usage increment failed'),
      );
    }
    req.auth = auth;
    req.log = req.log.child({ userId: auth.userId });
    next();
  };

  return { requireSession, requireSessionOrApiKey };
}
export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

/** For handlers behind an auth middleware: the user id, guaranteed present. */
export function userIdOf(req: Request): number {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
}
