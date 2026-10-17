import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import type { Logger } from '../lib/logger';
import { connectionOptions } from './pool';

// apps/api/migrations, found from src/db/ (dev, tests) or from dist/ (bundled build).
const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR =
  [join(here, '../../migrations'), join(here, '../migrations')].find((d) => existsSync(d)) ??
  join(here, '../../migrations');

/**
 * Applies migrations/NNN_name.sql files in name order, once each, and records them in
 * schema_migrations.
 *
 * Important MySQL detail: DDL statements (CREATE/ALTER TABLE) commit implicitly, so a
 * migration can NOT be rolled back by a transaction the way it could in PostgreSQL.
 * That's why each file is small and the version is recorded only after it fully succeeds;
 * a failed migration is fixed forward with a new file.
 *
 * Uses its own short-lived connection with multipleStatements enabled, because a migration
 * file holds several statements. The app pool keeps that option off.
 */
export async function runMigrations(
  databaseUrl: string,
  log?: Pick<Logger, 'info'>,
  dir = MIGRATIONS_DIR,
  caCert?: string,
): Promise<string[]> {
  const conn = await mysql.createConnection({
    ...connectionOptions(databaseUrl, caCert),
    multipleStatements: true,
    timezone: 'Z',
  });
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(50) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version as string));
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

    const newlyApplied: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      log?.info({ version }, 'migration applied');
      newlyApplied.push(version);
    }
    return newlyApplied;
  } finally {
    await conn.end();
  }
}

/** Latest migration file name, used by /ready to check the DB is up to date. */
export async function latestMigrationVersion(dir = MIGRATIONS_DIR): Promise<string | undefined> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  return files.at(-1)?.replace(/\.sql$/, '');
}
