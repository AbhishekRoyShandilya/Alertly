import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound, toProblem } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`Route ${req.method} ${req.path}`));
};

/**
 * The last middleware. Express 5 forwards errors thrown in async handlers here automatically.
 * Known AppErrors become their status code; anything else is a bug: logged with the stack,
 * returned as a generic 500 so no internal detail (SQL, file paths) leaks to the client.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  // body-parser errors (malformed JSON, body too large) carry a status and a `type`.
  const e = err as { status?: number; type?: string };
  if (!(err instanceof AppError) && e.type === 'entity.parse.failed') {
    err = new AppError(400, 'bad_request', 'Bad request', 'Malformed JSON body');
  } else if (!(err instanceof AppError) && e.type === 'entity.too.large') {
    err = new AppError(413, 'payload_too_large', 'Payload too large', 'Request body exceeds 100kb');
  }

  const problem = toProblem(err, req.id);
  if (problem.status >= 500) req.log.error({ err }, 'unhandled error');
  else req.log.debug({ problem }, 'request failed');

  if (err instanceof AppError) {
    for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  }
  res.status(problem.status).type('application/problem+json').json(problem);
};
