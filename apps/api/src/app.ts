import express, { Router, type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type { Deps } from './context';
import { requestId } from './middleware/request-id';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { healthRoutes } from './modules/health/routes';
import { createServices } from './services';
import { createAuthMiddleware } from './middleware/auth';
import { authRoutes } from './modules/auth/routes';
import { apiKeyRoutes } from './modules/api-keys/routes';
import { channelRoutes } from './modules/channels/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { deliveryRoutes } from './modules/deliveries/routes';

/**
 * Builds the Express app without starting it. server.ts calls listen(); tests pass the app
 * straight to Supertest, which needs no open port.
 *
 * Middleware order matters: request id first (so every later log line has it), body parsing
 * and security headers next, routes, then 404, then the error handler last.
 */
export function buildApp(deps: Deps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one proxy (Render/Railway/Vercel): real client IP for rate limits

  app.use(requestId(deps.log));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(cors({ origin: deps.env.WEB_ORIGIN, credentials: true }));
  app.use(helmet());

  const services = createServices(deps);
  const mw = createAuthMiddleware(deps, services);

  const v1 = Router();
  v1.use(healthRoutes(deps));
  v1.use(authRoutes(deps, services.auth, mw));
  v1.use(apiKeyRoutes(services.apiKeys, mw));
  v1.use(channelRoutes(services.channels, mw));
  v1.use(notificationRoutes(services.notifications, mw));
  v1.use(deliveryRoutes(services.deliveries, mw));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
