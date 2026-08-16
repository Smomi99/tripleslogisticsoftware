import { type NextRequest, NextResponse } from 'next/server';

/**
 * Resolves the tenant from the subdomain and passes it down the request
 * (CLAUDE.md §7A rule 5): acme.yourapp.com -> "acme".
 *
 * The slug travels as a request header the app itself sets, never as something
 * a page reads from the URL or a caller supplies. Server components read it
 * from headers(); the API resolves it against the database.
 *
 * From Phase 3 the authenticated session is authoritative: a session whose
 * tenant disagrees with the host must be rejected rather than reconciled,
 * because the Host header is client-controllable (§7A rule 1).
 */
export const TENANT_SLUG_HEADER = 'x-tenant-slug';

/** Hosts that carry no tenant: the marketing site and bare local dev. */
const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'admin']);

function slugFromHost(host: string): string | null {
  // Strip the port; IPv6 hosts are bracketed and never carry a subdomain.
  const hostname = host.split(':')[0] ?? '';
  if (hostname.length === 0 || hostname.startsWith('[')) return null;

  const labels = hostname.split('.');
  if (labels.length < 2) return null; // "localhost"

  const first = labels[0];
  if (first === undefined || first.length === 0) return null;
  if (RESERVED_SUBDOMAINS.has(first)) return null;

  return first;
}

export function middleware(request: NextRequest): NextResponse {
  const host = request.headers.get('host') ?? '';
  const slug = slugFromHost(host);

  const headers = new Headers(request.headers);
  // Drop anything a caller sent, so the value downstream is only ever ours.
  headers.delete(TENANT_SLUG_HEADER);
  if (slug !== null) {
    headers.set(TENANT_SLUG_HEADER, slug);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Skip static assets and image optimisation; they carry no tenant.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
