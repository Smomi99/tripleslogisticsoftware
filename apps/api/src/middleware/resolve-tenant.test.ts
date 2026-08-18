import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Which workspace a request is resolved to, on a host that carries no slug.
 *
 * §7A rule 5 addresses a tenant by subdomain, but no free host offers wildcard
 * DNS, so a deployment there names its workspace in configuration instead
 * (DEFAULT_TENANT_SLUG). That is a tenant-boundary decision, so it is asserted
 * rather than trusted: the pin must win over the Host header, and — the part
 * that matters — a client must not be able to talk its way past it.
 *
 * The database is mocked away deliberately. What is under test is which slug
 * the resolver *chooses*; whether that slug exists is tenant-client's job.
 */

interface Resolved {
  slug: string | undefined;
  status: number | undefined;
  called: boolean;
}

async function resolveWith(
  config: { isProduction: boolean; defaultTenantSlug?: string },
  request: { hostname: string; headers?: Record<string, string> },
): Promise<Resolved> {
  vi.resetModules();

  const seen: { slug?: string } = {};

  vi.doMock('../config/env', () => ({
    isProduction: config.isProduction,
    env: { DEFAULT_TENANT_SLUG: config.defaultTenantSlug },
  }));

  vi.doMock('../lib/tenant-client', () => ({
    resolveTenantBySlug: (slug: string) => {
      seen.slug = slug;
      return Promise.resolve({ id: 1n, slug, status: 'ACTIVE' });
    },
  }));

  const { resolveTenant } = await import('./resolve-tenant');

  const headers = request.headers ?? {};
  const req = {
    hostname: request.hostname,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;

  let called = false;
  const next: NextFunction = () => {
    called = true;
  };

  try {
    await resolveTenant(req, {} as Response, next);
    return { slug: seen.slug, status: undefined, called };
  } catch (error) {
    const status = (error as { status?: number }).status;
    return { slug: seen.slug, status, called };
  }
}

afterEach(() => {
  vi.doUnmock('../config/env');
  vi.doUnmock('../lib/tenant-client');
});

describe('resolveTenant', () => {
  it('reads the slug from the subdomain when there is one', async () => {
    const result = await resolveWith({ isProduction: true }, { hostname: 'acme.yourapp.com' });
    expect(result.slug).toBe('acme');
    expect(result.called).toBe(true);
  });

  it('refuses a host that carries no slug, rather than guessing', async () => {
    const result = await resolveWith({ isProduction: true }, { hostname: 'localhost' });
    expect(result.slug).toBeUndefined();
    expect(result.status).toBe(400);
  });

  it('uses the configured pin on a platform hostname', async () => {
    // Without the pin this host resolves to a workspace called "ff-erp-api",
    // which is the trap a single-host deployment walks into.
    const result = await resolveWith(
      { isProduction: true, defaultTenantSlug: 'demo' },
      { hostname: 'ff-erp-api.vercel.app' },
    );
    expect(result.slug).toBe('demo');
  });

  it('does not let a client override the pin (§7A rule 1)', async () => {
    const result = await resolveWith(
      { isProduction: true, defaultTenantSlug: 'demo' },
      { hostname: 'ff-erp-api.vercel.app', headers: { 'x-tenant-slug': 'someone-else' } },
    );
    expect(result.slug).toBe('demo');
  });

  it('still accepts the dev header outside production', async () => {
    const result = await resolveWith(
      { isProduction: false, defaultTenantSlug: 'demo' },
      { hostname: 'localhost', headers: { 'x-tenant-slug': 'demo' } },
    );
    expect(result.slug).toBe('demo');
  });
});
