import { SignJWT, jwtVerify } from 'jose';
import { ID_PREFIX, type LoginInput, type RegisterInput, type User } from '@alertly/shared';
import type { Deps } from '../../context';
import { conflict, isDbError, unauthorized } from '../../lib/errors';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../../lib/crypto';
import { encodeId } from '../../lib/ids';
import { findUserByEmail, findUserById, insertUser, type UserRow } from './repo';

export const SESSION_COOKIE = 'alertly_session';
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

export const toUser = (r: UserRow): User => ({
  id: encodeId(ID_PREFIX.user, r.id),
  email: r.email,
  name: r.name,
  createdAt: r.created_at.toISOString(),
});

export function createAuthService({ db, env, clock }: Deps) {
  const jwtKey = new TextEncoder().encode(env.JWT_SECRET);

  return {
    async register(input: RegisterInput): Promise<{ user: User; userId: number }> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password);
      try {
        const id = await insertUser(db, { email, passwordHash, name: input.name ?? null });
        return { user: toUser((await findUserById(db, id))!), userId: id };
      } catch (err) {
        // The UNIQUE index on email decides, not a "SELECT first" check that could race.
        if (isDbError(err, 'ER_DUP_ENTRY'))
          throw conflict('An account with this email already exists');
        throw err;
      }
    },

    /**
     * Same error, and roughly the same time, for "no such email" and "wrong password".
     * Otherwise an attacker could probe which emails have accounts.
     */
    async login(input: LoginInput): Promise<{ user: User; userId: number }> {
      const user = await findUserByEmail(db, input.email.trim().toLowerCase());
      if (!user) {
        await verifyPassword(input.password, await dummyPasswordHash());
        throw unauthorized('Invalid email or password');
      }
      if (!(await verifyPassword(input.password, user.password_hash))) {
        throw unauthorized('Invalid email or password');
      }
      return { user: toUser(user), userId: user.id };
    },

    /** A signed JWT holding only the user id (`sub`) and expiry. Stored in an httpOnly cookie. */
    async issueSessionToken(userId: number): Promise<string> {
      const nowSec = Math.floor(clock.now().getTime() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + SESSION_TTL_SEC)
        .sign(jwtKey);
    },

    /** Returns the user id if the token is valid and not expired, else null. */
    async verifySessionToken(token: string): Promise<number | null> {
      try {
        const { payload } = await jwtVerify(token, jwtKey, {
          algorithms: ['HS256'],
          currentDate: clock.now(),
        });
        const id = Number(payload.sub);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
      } catch {
        return null;
      }
    },

    async getUser(userId: number): Promise<User | null> {
      const row = await findUserById(db, userId);
      return row ? toUser(row) : null;
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
