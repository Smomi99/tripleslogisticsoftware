import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import {
  env,
  findRepoRoot,
  optional,
  REPO_ROOT,
  resolveMailConfig,
  STORAGE_ROOT,
} from './env';

/**
 * Where the API believes the repo root is.
 *
 * This looks like trivia until it decides where uploaded agreements land.
 * REPO_ROOT used to be `path.resolve(here, '../../../..')`, counted from
 * src/config/ — correct under tsx, and one level ABOVE the repo once tsup has
 * flattened the bundle into dist/. Nothing failed loudly: dotenv simply found
 * no .env (production supplies its own environment) and a relative
 * STORAGE_LOCAL_PATH resolved outside the repo, so uploads went to a directory
 * outside any mounted volume and vanished on the next container rebuild.
 *
 * The bug was invisible to every existing test because tests run the source.
 * These assertions run the resolver from the built path deliberately.
 */

const SOURCE_DIR = path.join('apps', 'api', 'src', 'config');
const BUNDLE_DIR = path.join('apps', 'api', 'dist');

describe('findRepoRoot', () => {
  it('finds the directory holding pnpm-workspace.yaml', () => {
    expect(REPO_ROOT).not.toBeNull();
    expect(existsSync(path.join(REPO_ROOT as string, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('resolves the same root from the bundled output as from the source', () => {
    const root = REPO_ROOT as string;

    // The bundle need not exist for this: the walk tests each ancestor, so a
    // start directory that is merely hypothetical still lands on the marker.
    expect(findRepoRoot(path.join(root, BUNDLE_DIR))).toBe(root);
    expect(findRepoRoot(path.join(root, SOURCE_DIR))).toBe(root);
  });

  it('is why a fixed `../../../..` cannot work', () => {
    const root = REPO_ROOT as string;
    const fixedDepthFromSource = path.resolve(path.join(root, SOURCE_DIR), '../../../..');
    const fixedDepthFromBundle = path.resolve(path.join(root, BUNDLE_DIR), '../../../..');

    // Same expression, two different answers — only one of them is the repo.
    expect(fixedDepthFromSource).toBe(root);
    expect(fixedDepthFromBundle).not.toBe(root);
  });

  it('returns null rather than guessing when there is no marker above', () => {
    expect(findRepoRoot(path.parse(process.cwd()).root)).toBeNull();
  });
});

describe('STORAGE_ROOT', () => {
  it('is absolute, so uploads never depend on the working directory', () => {
    if (env.STORAGE_DRIVER !== 'local') return;
    expect(STORAGE_ROOT).not.toBeNull();
    expect(path.isAbsolute(STORAGE_ROOT as string)).toBe(true);
  });

  it('resolves a relative STORAGE_LOCAL_PATH inside the repo', () => {
    if (env.STORAGE_DRIVER !== 'local') return;
    if (path.isAbsolute(env.STORAGE_LOCAL_PATH)) return;

    const root = REPO_ROOT as string;
    expect(STORAGE_ROOT).toBe(path.join(root, env.STORAGE_LOCAL_PATH));
    expect(path.relative(root, STORAGE_ROOT as string).startsWith('..')).toBe(false);
  });
});

describe('optional settings passed as an empty string', () => {
  /**
   * docker-compose writes `KEY: ${KEY:-}` for anything unset, so the variable
   * arrives as "" rather than absent. A bare `.optional()` accepts undefined
   * but not "", so the API refused to boot with "DEFAULT_TENANT_SLUG: Too
   * small" on exactly the configuration docs/DEPLOY_VPS.md prescribes for
   * subdomain routing. Empty must mean unset.
   */
  const slug = z.object({ DEFAULT_TENANT_SLUG: optional(z.string().min(1)) });
  const endpoint = z.object({ S3_ENDPOINT: optional(z.string().url()) });

  it('reads an empty value as unset, not as invalid', () => {
    expect(slug.parse({ DEFAULT_TENANT_SLUG: '' }).DEFAULT_TENANT_SLUG).toBeUndefined();
    expect(slug.parse({ DEFAULT_TENANT_SLUG: '   ' }).DEFAULT_TENANT_SLUG).toBeUndefined();
    expect(slug.parse({}).DEFAULT_TENANT_SLUG).toBeUndefined();
  });

  it('keeps a real value', () => {
    expect(slug.parse({ DEFAULT_TENANT_SLUG: 'acme' }).DEFAULT_TENANT_SLUG).toBe('acme');
  });

  it('still rejects a value that is present but wrong', () => {
    expect(endpoint.parse({ S3_ENDPOINT: '' }).S3_ENDPOINT).toBeUndefined();
    expect(() => endpoint.parse({ S3_ENDPOINT: 'not-a-url' })).toThrow();
  });
});

/**
 * Whether mail is configured at all.
 *
 * This rule used to demand a username and a password, which meant a local SMTP
 * catcher could not be pointed at — and so the only way to answer "do the
 * emails look right?" was to send real mail to a real agent.
 */
describe('resolveMailConfig', () => {
  const base = { SMTP_PORT: 587, SMTP_SECURE: false };

  it('is null with no host, so every send becomes a logged no-op', () => {
    expect(resolveMailConfig({ ...base, MAIL_FROM: 'a@b.test' })).toBeNull();
  });

  it('is null with no sender, because a message needs a From', () => {
    expect(resolveMailConfig({ ...base, SMTP_HOST: 'localhost' })).toBeNull();
  });

  it('configures an unauthenticated server, which is what a catcher is', () => {
    const config = resolveMailConfig({
      ...base,
      SMTP_HOST: 'localhost',
      SMTP_PORT: 1025,
      MAIL_FROM: 'pricing@localhost.test',
    });
    expect(config).not.toBeNull();
    // Null rather than an empty object: mailer.ts omits the auth key entirely,
    // because passing one makes nodemailer attempt AUTH and a catcher refuses.
    expect(config?.auth).toBeNull();
    expect(config?.from).toBe('pricing@localhost.test');
    expect(config?.secure).toBe(false);
  });

  it('carries credentials when both halves are present', () => {
    const config = resolveMailConfig({
      ...base,
      SMTP_HOST: 'smtppro.zoho.com',
      SMTP_PORT: 465,
      SMTP_USER: 'pricing@example.com',
      SMTP_PASS: 'app-specific',
    });
    expect(config?.auth).toEqual({ user: 'pricing@example.com', pass: 'app-specific' });
    // Port 465 is implicit TLS whether or not the flag was set.
    expect(config?.secure).toBe(true);
    // The sender falls back to the account when MAIL_FROM is not given.
    expect(config?.from).toBe('pricing@example.com');
  });

  it('ignores a username with no password rather than half-authenticating', () => {
    const config = resolveMailConfig({
      ...base,
      SMTP_HOST: 'localhost',
      SMTP_USER: 'someone@example.com',
    });
    expect(config?.auth).toBeNull();
  });
});
