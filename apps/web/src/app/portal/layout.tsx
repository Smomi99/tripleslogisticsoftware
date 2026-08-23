import { headers } from 'next/headers';

import { PortalSessionProvider } from '@/lib/portal-session';

/**
 * The agent portal (docs/AGENT_PORTAL_DESIGN.md §5).
 *
 * Same product, seen from outside: §12's tokens, type and spacing throughout,
 * but none of the staff shell. No sidebar, no module navigation, no workspace
 * switcher — an agent has exactly one thing to do here, and a chrome that
 * implies otherwise is a chrome that leaks the shape of the system.
 *
 * Served same-origin with the API on purpose (§2.5): the portal refresh cookie
 * is SameSite=Lax and scoped to /api/portal/auth, so a portal on its own host
 * would sign agents in and then quietly stop refreshing an hour later.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // Resolved by proxy.ts from the subdomain, never from anything the caller
  // sent (§7A rule 1) — the same path the staff app uses.
  const requestHeaders = await headers();
  const tenantSlug =
    process.env.NEXT_PUBLIC_TENANT_SLUG ??
    requestHeaders.get('x-tenant-slug') ??
    process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ??
    'demo';

  return <PortalSessionProvider tenantSlug={tenantSlug}>{children}</PortalSessionProvider>;
}
