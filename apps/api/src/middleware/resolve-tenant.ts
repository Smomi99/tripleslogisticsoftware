import type { NextFunction, Request, Response } from 'express';

import { isProduction } from '../config/env';
import { HttpError } from '../lib/http-error';
import { resolveTenantBySlug, type ResolvedTenant } from '../lib/tenant-client';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by resolveTenant. Never populated from client input (§7A rule 1). */
      tenant?: ResolvedTenant;
    }
  }
}

/**
 * Extracts the tenant slug from the Host header: acme.yourapp.com -> "acme"
 * (CLAUDE.md §7A rule 5). Returns undefined for a bare host or an apex domain.
 */
function slugFromHost(hostname: string): string | undefined {
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  const first = labels[0];
  if (first === undefined || first === 'www') return undefined;
  // localhost:3000 has one label; acme.localhost has two.
  return first;
}

/**
 * Resolves the tenant for this request, server-side only.
 *
 * CLAUDE.md §7A rule 1 forbids taking tenant_id from a request body or query
 * param, because a client that can send it can read another company's
 * shipments. The Host header is not a body or a param, but it is still client
 * -controllable — so from Phase 3 the authenticated session is authoritative
 * and a session whose tenant disagrees with the host must be rejected, not
 * reconciled. Until then this is the only source.
 *
 * The X-Tenant-Slug header is accepted in development only, so that
 * localhost and the test suite can address a tenant without wildcard DNS.
 */
export async function resolveTenant(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const headerSlug = isProduction ? undefined : req.get('x-tenant-slug');
  const slug = headerSlug ?? slugFromHost(req.hostname);

  if (slug === undefined || slug.length === 0) {
    throw new HttpError(400, 'TENANT_NOT_SPECIFIED', 'No tenant in this request.');
  }

  const tenant = await resolveTenantBySlug(slug);
  if (tenant === null) {
    throw HttpError.notFound('Unknown workspace.');
  }

  // §7B lifecycle: SUSPENDED is read-only + export, CANCELLED has no access.
  if (tenant.status === 'CANCELLED') {
    throw HttpError.forbidden('This workspace has been closed.');
  }

  req.tenant = tenant;
  next();
}
