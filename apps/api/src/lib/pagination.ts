import { badRequest } from './errors';

export interface Cursor {
  createdAt: Date;
  id: number;
}

/** Cursors are opaque to clients: base64url of JSON. Clients just pass them back. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt.toISOString(), c.id])).toString('base64url');
}

export function decodeCursor(s: string): Cursor {
  try {
    const [iso, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as [
      unknown,
      unknown,
    ];
    const createdAt = new Date(String(iso));
    if (Number.isNaN(createdAt.getTime()) || !Number.isSafeInteger(id)) throw new Error();
    return { createdAt, id: id as number };
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/**
 * Keyset ("seek") pagination for lists sorted newest first by (created_at DESC, id DESC).
 * "Give me rows older than the last one I saw" stays correct while new rows are inserted,
 * whereas OFFSET would shift and show duplicates or skip rows. It also stays fast on deep
 * pages, because the index seeks straight to the cursor instead of counting past N rows.
 *
 * `alias` is the table alias, e.g. 'n' produces `n.created_at`.
 */
export function cursorWhere(cursor: string | undefined, alias: string) {
  if (!cursor) return { sql: '', params: [] as unknown[] };
  const c = decodeCursor(cursor);
  return {
    sql: ` AND (${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`,
    params: [c.createdAt, c.createdAt, c.id] as unknown[],
  };
}

/**
 * Fetch limit+1 rows: if the extra row exists, there is a next page. Then drop it.
 */
export function toPage<R extends { created_at: Date; id: number }, T>(
  rows: R[],
  limit: number,
  map: (r: R) => T,
) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(map),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
