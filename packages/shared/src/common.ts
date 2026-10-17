import { z } from 'zod';

/** Every list endpoint returns this shape (cursor pagination, see docs section 6). */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });

export type Page<T> = { data: T[]; nextCursor: string | null };

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

/** Error body for every non-2xx response (inspired by RFC 7807 "problem details"). */
export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
  })
  .meta({ id: 'Problem' });
export type Problem = z.infer<typeof Problem>;

/** Timestamps travel as ISO-8601 strings in JSON. */
export const IsoDate = z.string().meta({ example: '2026-10-16T09:31:02.114Z' });

/** Public IDs look like `ntf_8Gk2`: a type prefix plus a base62 number. */
export const publicId = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-Za-z]+$`), `must be a ${prefix}_… id`)
    .max(40);

export const ID_PREFIX = {
  user: 'usr',
  apiKey: 'key',
  channel: 'ch',
  notification: 'ntf',
  delivery: 'dlv',
  alert: 'alr',
  alertEvent: 'evt',
} as const;
