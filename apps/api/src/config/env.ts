import { z } from 'zod';
import { PRICE_PROVIDERS } from '@alertly/shared';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

  DATABASE_URL: z.string().startsWith('mysql://'),
  DB_POOL_SIZE: z.coerce.number().int().min(2).max(100).default(10),

  JWT_SECRET: z.string().min(32, 'use at least 32 random characters'),
  /** 32 random bytes, base64. Generate with: node -e "console.log(crypto.randomBytes(32).toString('base64'))" */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  WEB_ORIGIN: z.url().default('http://localhost:3000'),

  // Email: Resend if a key is set, otherwise SMTP (Mailpit locally), otherwise disabled.
  EMAIL_FROM: z.string().default('Alertly <alerts@alertly.local>'),
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Overridable so tests can point the Telegram sender at a local mock server. */
  TELEGRAM_API_URL: z.url().default('https://api.telegram.org'),

  PRICE_PROVIDER_DEFAULT: z.enum(PRICE_PROVIDERS).default('simulated'),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  SCHEDULER_INTERVAL_SEC: z.coerce.number().int().min(1).max(3600).default(15),

  DAILY_NOTIFICATION_QUOTA: z.coerce.number().int().positive().default(1000),
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),
  REGISTER_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),

  /** The seeded demo account is read-only, so reviewers can look around without breaking it. */
  DEMO_EMAIL: z.string().default('demo@alertly.dev'),
  DEMO_PASSWORD: z.string().min(10).default('demo-password-123'),
  /** Optional: where the demo account's webhook channel posts (e.g. a request inspector URL). */
  DEMO_WEBHOOK_URL: z.url().optional(),

  /** Lets webhooks target localhost/private IPs. Only for local development and tests. */
  WEBHOOK_ALLOW_PRIVATE: bool.default(false),
});

export type Env = z.infer<typeof EnvSchema> & {
  encryptionKey: Buffer;
  isProd: boolean;
};

/**
 * Parses and validates configuration once, at startup. A missing or malformed variable stops
 * the process immediately with a clear message, instead of failing later at the first request.
 * Nothing else in the codebase reads process.env.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.WEBHOOK_ALLOW_PRIVATE) {
    throw new Error('WEBHOOK_ALLOW_PRIVATE must not be enabled in production');
  }
  return {
    ...env,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    isProd: env.NODE_ENV === 'production',
  };
}
