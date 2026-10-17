import type { Conn, Db } from './pool';

/**
 * Runs `fn` inside a transaction on one dedicated connection.
 * - every query inside `fn` must use the `conn` it receives (not the pool), or it would run
 *   on a different connection, outside the transaction
 * - success: COMMIT. Any thrown error: ROLLBACK, then rethrow
 * - the connection always goes back to the pool (finally)
 */
export async function withTransaction<T>(db: Db, fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
