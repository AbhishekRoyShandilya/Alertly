import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger';

const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Gives every request an id (reusing a caller's X-Request-Id if it looks sane), returns it
 * in the response header and in error bodies, and attaches a child logger so every log
 * line for this request carries the same requestId. That is how you trace one failing
 * request through the logs.
 */
export function requestId(baseLog: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id =
      incoming && VALID_ID.test(incoming) ? incoming : `req_${randomBytes(8).toString('hex')}`;
    res.setHeader('X-Request-Id', req.id);
    req.log = baseLog.child({ requestId: req.id });

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      req.log.info(
        {
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          ms: Math.round(ms),
        },
        'request',
      );
    });
    next();
  };
}
