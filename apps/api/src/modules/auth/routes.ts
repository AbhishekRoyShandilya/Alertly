import { Router, type CookieOptions, type Response } from 'express';
import { LoginInput, RegisterInput } from '@alertly/shared';
import type { Deps } from '../../context';
import { parse } from '../../middleware/validate';
import { RateLimiter } from '../../middleware/rate-limit';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import { unauthorized } from '../../lib/errors';
import { SESSION_COOKIE, SESSION_TTL_SEC, type AuthService } from './service';

export function authRoutes(deps: Deps, auth: AuthService, mw: AuthMiddleware): Router {
  const r = Router();
  // Brute-force protection: 5 login attempts per minute per IP (design section 10).
  const loginLimiter = new RateLimiter(5, 60_000, deps.clock);
  const registerLimiter = new RateLimiter(10, 60_000, deps.clock);

  /**
   * httpOnly: JavaScript can't read the cookie, so an XSS bug can't steal the session.
   * secure: HTTPS only (in production). sameSite=lax: not sent on cross-site POSTs (CSRF defence).
   */
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: deps.env.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC * 1000,
  };

  async function startSession(res: Response, userId: number) {
    const token = await auth.issueSessionToken(userId);
    res.cookie(SESSION_COOKIE, token, cookieOptions);
  }

  r.post('/auth/register', async (req, res) => {
    registerLimiter.check(`ip:${req.ip}`, res);
    const { user, userId } = await auth.register(parse(RegisterInput, req.body));
    await startSession(res, userId);
    res.status(201).json({ user });
  });

  r.post('/auth/login', async (req, res) => {
    loginLimiter.check(`ip:${req.ip}`, res);
    const { user, userId } = await auth.login(parse(LoginInput, req.body));
    await startSession(res, userId);
    res.json({ user });
  });

  r.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined });
    res.status(204).end();
  });

  r.get('/auth/me', mw.requireSession, async (req, res) => {
    const user = await auth.getUser(userIdOf(req));
    if (!user) throw unauthorized();
    res.json({ user });
  });

  return r;
}
