import type { Problem } from '@alertly/shared';

/**
 * An error that is safe to show to the client. Anything thrown that is NOT an AppError is
 * treated as a bug: logged in full, but returned as a generic 500 with no internal details.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
    this.name = 'AppError';
  }
}

export const badRequest = (detail?: string) =>
  new AppError(400, 'bad_request', 'Bad request', detail);
export const validationError = (detail: string) =>
  new AppError(422, 'validation_error', 'Invalid request', detail);
export const unauthorized = (detail = 'Authentication required') =>
  new AppError(401, 'unauthorized', 'Unauthorized', detail);
export const forbidden = (detail?: string) => new AppError(403, 'forbidden', 'Forbidden', detail);
export const notFound = (what = 'Resource') =>
  new AppError(404, 'not_found', 'Not found', `${what} not found`);
export const conflict = (detail: string) => new AppError(409, 'conflict', 'Conflict', detail);
export const tooManyRequests = (retryAfterSec: number, detail = 'Too many requests') =>
  new AppError(429, 'rate_limited', 'Too many requests', detail, {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))),
  });

export function toProblem(err: unknown, requestId?: string): Problem {
  if (err instanceof AppError) {
    return { type: err.type, title: err.title, status: err.status, detail: err.detail, requestId };
  }
  return {
    type: 'internal_error',
    title: 'Internal server error',
    status: 500,
    detail: 'Something went wrong. Quote the requestId if you contact support.',
    requestId,
  };
}

/** mysql2 sets `code` on driver errors; this checks for one without `any`. */
export function isDbError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
