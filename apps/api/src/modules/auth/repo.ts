import { exec, queryOne, type Queryable } from '../../db/pool';

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: Date;
}

export const findUserByEmail = (db: Queryable, email: string) =>
  queryOne<UserRow>(db, 'SELECT * FROM users WHERE email = ?', [email]);

export const findUserById = (db: Queryable, id: number) =>
  queryOne<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [id]);

export async function insertUser(
  db: Queryable,
  u: { email: string; passwordHash: string; name: string | null },
): Promise<number> {
  const r = await exec(db, 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [
    u.email,
    u.passwordHash,
    u.name,
  ]);
  return r.insertId;
}
