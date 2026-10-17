import type { Problem } from '@alertly/shared';

/** A non-2xx response, carrying the API's problem+json fields. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly detail: string,
    readonly requestId?: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

/**
 * The single place the dashboard talks to the API.
 * - relative URL `/api/...`: same origin, forwarded by the Next.js rewrite
 * - credentials: 'include' sends the httpOnly session cookie
 * - error bodies become a typed ApiError, so UI code can show `err.detail`
 */
export async function apiFetch<T>(
  path: string,
  opts: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: {
      ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  if (res.status === 204) return undefined as T;

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const p = (body ?? {}) as Partial<Problem>;
    throw new ApiError(
      res.status,
      p.type ?? 'error',
      p.detail ?? p.title ?? res.statusText,
      p.requestId,
    );
  }
  return body as T;
}

export const errorMessage = (err: unknown): string =>
  err instanceof ApiError
    ? err.detail
    : err instanceof Error
      ? err.message
      : 'Something went wrong';
