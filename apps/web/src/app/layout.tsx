import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { headers } from 'next/headers';

import { SessionProvider } from '@/lib/session';

import './globals.css';

/*
 * §12: IBM Plex Sans for UI and body — an industrial, engineered register that
 * also has a Bengali sibling, so the family survives the client localising
 * later. IBM Plex Mono for every identifier and number.
 *
 * next/font downloads these at build time and self-hosts them, so there is no
 * request to Google at runtime and no layout shift.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Freight Forwarding ERP',
  description: 'Freight forwarding and logistics operations platform',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // proxy.ts resolves the subdomain and sets this header; it never comes from
  // anything the caller sent (§7A rule 1). Locally there is no subdomain, so a
  // dev fallback names the workspace.
  //
  // NEXT_PUBLIC_TENANT_SLUG comes first and pins the whole deployment to one
  // workspace, for hosts without wildcard DNS. It mirrors the API's
  // DEFAULT_TENANT_SLUG, and the two must name the same workspace or the top
  // bar will label a workspace the API is not serving.
  const requestHeaders = await headers();
  const tenantSlug =
    process.env.NEXT_PUBLIC_TENANT_SLUG ??
    requestHeaders.get('x-tenant-slug') ??
    process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ??
    'demo';

  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <SessionProvider tenantSlug={tenantSlug}>{children}</SessionProvider>
      </body>
    </html>
  );
}
