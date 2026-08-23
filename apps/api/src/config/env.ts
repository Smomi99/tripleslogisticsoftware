import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

// The monorepo keeps one .env at the repo root so Prisma and both apps agree
// on a single set of values. Resolve it relative to this file, not to cwd —
// the API is started from several different working directories.
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The monorepo root: the directory holding pnpm-workspace.yaml.
 *
 * Found by walking up rather than by counting `..` segments, because the depth
 * differs between the TypeScript source (apps/api/src/config/) and the bundled
 * output (apps/api/dist/). A fixed `../../../..` is right under tsx and lands
 * one level ABOVE the repo once tsup has bundled it — so in production .env
 * went unread and a relative STORAGE_LOCAL_PATH resolved outside the repo,
 * which in a container means outside the mounted volume. Uploads written there
 * survive exactly until the next rebuild.
 *
 * Null when the marker is absent — a deployment shipping only dist/ and
 * node_modules. Harmless for .env, since such a deployment takes its
 * environment from the platform; see resolveStorageRoot for the case where it
 * is not harmless.
 *
 * Exported only so the test can start the walk from the bundled path.
 */
export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root, marker never found
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(here);

if (REPO_ROOT !== null) {
  dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
}

/**
 * An optional setting that an orchestrator may pass as an EMPTY STRING.
 *
 * docker-compose writes `KEY: ${KEY:-}` for anything unset, so the variable
 * arrives as "" rather than absent, and a bare `.optional()` then fails its
 * inner check — the API refused to boot with "DEFAULT_TENANT_SLUG: Too small",
 * on precisely the configuration the VPS runbook prescribes. Empty means unset.
 *
 * Exported so the test exercises this function rather than a copy of it.
 */
export function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy .env.example to .env'),
  DATABASE_URL_APP: optional(z.string().min(1)),

  // Consumed in Phase 3 (CLAUDE.md §7). Declared now so a missing secret fails
  // at boot rather than at the first login attempt.
  JWT_ACCESS_SECRET: z.string().min(1).default('change-me-access'),
  JWT_REFRESH_SECRET: z.string().min(1).default('change-me-refresh'),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().min(1).default('./storage'),

  // S3-compatible storage (§2: local disk in dev, S3-compatible in prod).
  // Required only when STORAGE_DRIVER=s3; checked below rather than here, so
  // a local deployment is not asked for credentials it will never use.
  S3_BUCKET: optional(z.string().min(1)),
  S3_REGION: z.string().min(1).default('auto'),
  S3_ENDPOINT: optional(z.string().url()),
  // MinIO and some self-hosted gateways only understand path-style addressing.
  // R2 and AWS do not need it.
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_ACCESS_KEY_ID: optional(z.string().min(1)),
  S3_SECRET_ACCESS_KEY: optional(z.string().min(1)),

  /**
   * Pins this deployment to ONE workspace, by slug.
   *
   * §7A rule 5 addresses a tenant by subdomain, which needs wildcard DNS —
   * not available on a free host. Setting this names the workspace in
   * server-side configuration instead, and it takes precedence over the Host
   * header: a platform hostname like ff-api.vercel.app would otherwise be read
   * as a workspace called "ff-api".
   *
   * This does NOT weaken §7A rule 1. The value is operator configuration, not
   * client input — a caller still cannot name a tenant it does not belong to.
   * Leave it unset the moment wildcard DNS exists, or the deployment can only
   * ever serve one company.
   */
  DEFAULT_TENANT_SLUG: optional(z.string().min(1)),

  /**
   * Outgoing mail. Nothing is sent unless SMTP_HOST, SMTP_USER and SMTP_PASS
   * are all set — a developer machine has no mail server and must not fail to
   * boot over it, nor quietly try to reach one.
   *
   * SMTP_PASS never appears in a log line or an error message. It is read here
   * and handed straight to the transport.
   */
  SMTP_HOST: optional(z.string().min(1)),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** 465 is implicit TLS; 587 upgrades with STARTTLS. */
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  SMTP_USER: optional(z.string().min(1)),
  SMTP_PASS: optional(z.string().min(1)),
  /** The address recipients see. Defaults to SMTP_USER when unset. */
  MAIL_FROM: optional(z.string().min(1)),
  /** Shown in the email so the recipient can find the inquiry. */
  APP_URL: optional(z.string().url()),
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

/**
 * Absolute directory the local driver writes uploads to, resolved once here.
 *
 * A relative STORAGE_LOCAL_PATH is relative to the repo root — that is where
 * the committed ./storage sits. Resolving it lazily on each upload is what let
 * the wrong base go unnoticed for so long, so it is computed at boot and fails
 * loudly rather than silently writing somewhere nobody will look.
 */
function resolveStorageRoot(): string {
  const configured = env.STORAGE_LOCAL_PATH;
  if (path.isAbsolute(configured)) return configured;
  if (REPO_ROOT === null) {
    throw new Error(
      `STORAGE_LOCAL_PATH="${configured}" is relative, and the repo root could not be located ` +
        `above ${here} (no pnpm-workspace.yaml). Set STORAGE_LOCAL_PATH to an absolute path.`,
    );
  }
  return path.join(REPO_ROOT, configured);
}

/** Null when the driver is not `local`, where a filesystem root is meaningless. */
export const STORAGE_ROOT: string | null =
  env.STORAGE_DRIVER === 'local' ? resolveStorageRoot() : null;

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  /**
   * Null when the server takes mail without credentials. A local catcher
   * (Mailpit) and an internal relay both do; Zoho does not, and offering it no
   * credentials makes it refuse — which is a loud, correct failure rather than
   * a silent one.
   */
  auth: { user: string; pass: string } | null;
  from: string;
}

/**
 * Null when mail is not configured, which is the normal state on a developer
 * machine. Callers skip sending rather than throwing: an inquiry that saved
 * correctly must not report failure because a notification could not go out.
 */
export interface MailEnv {
  SMTP_HOST?: string | undefined;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER?: string | undefined;
  SMTP_PASS?: string | undefined;
  MAIL_FROM?: string | undefined;
}

/**
 * Decides whether mail is configured, and how.
 *
 * A pure function rather than an expression, so the rule can be tested without
 * reloading the module under six different environments — it is the rule that
 * decides whether anything is sent at all.
 *
 * A host and a sender are the minimum. Credentials are NOT: requiring them
 * meant a local SMTP catcher could not be pointed at, so "does mail work?"
 * could only be answered by sending real mail to a real person.
 */
export function resolveMailConfig(source: MailEnv): MailConfig | null {
  const from = source.MAIL_FROM ?? source.SMTP_USER;
  if (source.SMTP_HOST === undefined || from === undefined) return null;
  return {
    host: source.SMTP_HOST,
    port: source.SMTP_PORT,
    // Port 465 is implicit TLS whether or not the flag was set.
    secure: source.SMTP_SECURE || source.SMTP_PORT === 465,
    auth:
      source.SMTP_USER !== undefined && source.SMTP_PASS !== undefined
        ? { user: source.SMTP_USER, pass: source.SMTP_PASS }
        : null,
    from,
  };
}

export const MAIL_CONFIG: MailConfig | null = resolveMailConfig(env);

export interface S3Config {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3 settings, complete or not at all.
 *
 * Checked at boot for the same reason as the storage root: a half-configured
 * bucket must not survive until the first operator tries to attach an agency
 * agreement and gets a 500.
 */
export interface S3Env {
  S3_BUCKET?: string | undefined;
  S3_REGION: string;
  S3_ENDPOINT?: string | undefined;
  S3_FORCE_PATH_STYLE: boolean;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
}

/**
 * Exported for the same reason resolveMailConfig is: this decides whether the
 * bucket is usable, and the failure it prevents — a half-configured store that
 * boots happily and 500s on the first upload weeks later — is worth pinning.
 */
export function resolveS3Config(source: S3Env = env): S3Config {
  const missing = (
    [
      ['S3_BUCKET', source.S3_BUCKET],
      ['S3_ACCESS_KEY_ID', source.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', source.S3_SECRET_ACCESS_KEY],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=s3 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
    );
  }

  return {
    bucket: source.S3_BUCKET as string,
    region: source.S3_REGION,
    endpoint: source.S3_ENDPOINT,
    forcePathStyle: source.S3_FORCE_PATH_STYLE,
    accessKeyId: source.S3_ACCESS_KEY_ID as string,
    secretAccessKey: source.S3_SECRET_ACCESS_KEY as string,
  };
}

/** Null when the driver is not `s3`. */
export const S3_CONFIG: S3Config | null =
  env.STORAGE_DRIVER === 's3' ? resolveS3Config() : null;
