import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createPool, type Db } from '../../src/db/pool';
import { runMigrations } from '../../src/db/migrate';
import { TEST_ROOT_URL } from './env';

export interface TestDb {
  url: string;
  db: Db;
  drop(): Promise<void>;
}

/**
 * Each integration test file gets its own fresh database (alertly_test_<random>), fully
 * migrated. Files can run in parallel without seeing each other's rows, and a failing test
 * never leaves dirty state for the next run.
 */
export async function createTestDb(): Promise<TestDb> {
  const name = `alertly_test_${randomBytes(4).toString('hex')}`;
  const root = await mysql.createConnection({ uri: TEST_ROOT_URL });
  await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  await root.end();

  const url = `${TEST_ROOT_URL.replace(/\/$/, '')}/${name}`;
  await runMigrations(url);
  const db = createPool(url, 10);

  return {
    url,
    db,
    async drop() {
      await db.end();
      const conn = await mysql.createConnection({ uri: TEST_ROOT_URL });
      await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await conn.end();
    },
  };
}
