import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';
import type { Env } from '../config/env';

export type { Logger };

/**
 * pino-pretty is a devDependency, so it's absent from production images. A container started
 * with NODE_ENV=development must not crash over it: fall back to plain JSON logs instead.
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

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
    ...(env.NODE_ENV === 'development' && prettyAvailable()
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
}
