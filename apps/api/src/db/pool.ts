import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type Db = Pool;
export type Conn = PoolConnection;
/** Anything that can run a query: the pool itself, or a connection inside a transaction. */
export type Queryable = Pool | PoolConnection;

/**
 * Turns DATABASE_URL (+ optional CA certificate) into mysql2 options.
 * Managed providers hand out URLs like `mysql://u:p@host:port/db?ssl-mode=REQUIRED`; mysql2
 * doesn't understand `ssl-mode`, so it's removed from the URL and mapped to TLS options.
 * With a CA certificate the server's identity is verified (no man-in-the-middle).
 */
export function connectionOptions(url: string, caCert?: string): mysql.ConnectionOptions {
  const u = new URL(url);
  const sslMode = (
    u.searchParams.get('ssl-mode') ??
    u.searchParams.get('sslmode') ??
    ''
  ).toUpperCase();
  u.searchParams.delete('ssl-mode');
  u.searchParams.delete('sslmode');
  const useTls = Boolean(caCert) || (sslMode !== '' && sslMode !== 'DISABLED');
  return {
    uri: u.toString(),
    ...(useTls
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(caCert ? { ca: caCert.replace(/\\n/g, '\n') } : {}),
          },
        }
      : {}),
  };
}

export function createPool(url: string, connectionLimit: number, caCert?: string): Db {
  const pool = mysql.createPool({
    ...connectionOptions(url, caCert),
    connectionLimit,
    waitForConnections: true,
    // Store and read DATETIME values as UTC. mysql2 converts them to/from JS Date objects.
    timezone: 'Z',
    dateStrings: false,
    // DECIMAL columns come back as JS numbers instead of strings. Prices are display values
    // here, so float precision is acceptable; money balances would keep strings or integers.
    decimalNumbers: true,
    supportBigNumbers: true,
    // Never allow several statements in one query string: a classic SQL injection amplifier.
    multipleStatements: false,
  });
  // Make NOW() and CURRENT_TIMESTAMP defaults produce UTC on every pooled connection.
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return pool;
}

/**
 * Typed helper for SELECTs. Always pass values as `params` (the `?` placeholders):
 * mysql2 escapes them, so user input can never change the SQL itself (no SQL injection).
 * We use `query` rather than `execute` (server-side prepared statements) because it expands
 * arrays for `IN (?)` and bulk `VALUES ?`, which prepared statements can't do.
 */
export async function query<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

export async function queryOne<T>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(db, sql, params);
  return rows[0];
}

/** For INSERT / UPDATE / DELETE: returns insertId and affectedRows. */
export async function exec(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<ResultSetHeader> {
  const [result] = await db.query<ResultSetHeader>(sql, params);
  return result;
}
