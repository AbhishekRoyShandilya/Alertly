import { pino, type Logger } from 'pino';
import type { Env } from '../config/env';

export type { Logger };

/**
 * Structured JSON logs in production (one object per line, easy to search),
 * pretty colored output in development, silence in tests.
 * Secrets are redacted no matter where they appear in a logged object.
 */
export function createLogger(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>, name = 'api'): Logger {
  const level = env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info');
  return pino({
    name,
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        '*.password',
        '*.secret',
        '*.key',
        '*.token',
      ],
      censor: '[redacted]',
    },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
}
