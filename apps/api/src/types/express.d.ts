import type { Logger } from 'pino';

export interface AuthContext {
  userId: number;
  via: 'session' | 'api_key';
  apiKeyId?: number;
  /** The shared demo account (read-only). */
  isDemo?: boolean;
}

// Adds our own fields to Express's Request type, so `req.auth` is typed everywhere.
declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      auth?: AuthContext;
    }
  }
}
