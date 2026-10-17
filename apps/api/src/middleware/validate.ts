import type { z } from 'zod';
import { validationError } from '../lib/errors';

/**
 * Validates untrusted input against a Zod schema and returns the parsed, typed value.
 * Failures become 422 with field-level messages, e.g. "title: Too small: expected ...".
 *
 * Called at the top of each route handler: `const input = parse(CreateChannelInput, req.body)`.
 * (A function rather than middleware, because Express 5 makes req.query read-only and
 * because the return value is typed from the schema.)
 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw validationError(detail);
  }
  return result.data;
}

/** A route parameter as a string (Express 5 types widen params when middleware precedes the handler). */
export function param(req: { params: Record<string, unknown> }, name: string): string {
  const v = req.params[name];
  return typeof v === 'string' ? v : '';
}
