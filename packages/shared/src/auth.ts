import { z } from 'zod';
import { IsoDate, ID_PREFIX, publicId } from './common';

export const PASSWORD_MIN_LENGTH = 10;

export const RegisterInput = z
  .object({
    email: z.email().max(255),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
    name: z.string().trim().min(1).max(100).optional(),
  })
  .meta({ id: 'RegisterInput' });
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z
  .object({
    email: z.email().max(255),
    password: z.string().min(1).max(200),
  })
  .meta({ id: 'LoginInput' });
export type LoginInput = z.infer<typeof LoginInput>;

export const User = z
  .object({
    id: publicId(ID_PREFIX.user),
    email: z.string(),
    name: z.string().nullable(),
    createdAt: IsoDate,
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof User>;

export const UserResponse = z.object({ user: User });
