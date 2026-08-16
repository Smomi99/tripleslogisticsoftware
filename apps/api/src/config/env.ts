import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

// The monorepo keeps one .env at the repo root so Prisma and both apps agree
// on a single set of values. Resolve it relative to this file, not to cwd —
// the API is started from several different working directories.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy .env.example to .env'),
  DATABASE_URL_APP: z.string().min(1).optional(),

  // Consumed in Phase 3 (CLAUDE.md §7). Declared now so a missing secret fails
  // at boot rather than at the first login attempt.
  JWT_ACCESS_SECRET: z.string().min(1).default('change-me-access'),
  JWT_REFRESH_SECRET: z.string().min(1).default('change-me-refresh'),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().min(1).default('./storage'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * The connection the API runs queries through. Falls back to the owner URL
 * until the non-owner RLS role exists (CLAUDE.md §7A rule 2, Phase 2).
 */
export const runtimeDatabaseUrl = env.DATABASE_URL_APP ?? env.DATABASE_URL;
