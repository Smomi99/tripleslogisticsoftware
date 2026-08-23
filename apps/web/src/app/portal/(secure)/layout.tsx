'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Toaster } from 'sonner';

import { Button } from '@/components/ui/button';
import { usePortalSession } from '@/lib/portal-session';
import { cn } from '@/lib/utils';

/**
 * The signed-in portal shell.
 *
 * Deliberately not the staff shell. No sidebar, no module list, no workspace
 * switcher: an agent has one job here, and chrome that implies otherwise both
 * confuses them and advertises the shape of a system they cannot reach.
 *
 * A single bar carries the agent's own company name — which is the thing they
 * will check first, because a forwarder's portal looks much like every other
 * forwarder's portal.
 */
export default function PortalSecureLayout({ children }: { children: React.ReactNode }) {
  const { status, user, signOut } = usePortalSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/portal/login');
  }, [status, router]);

  if (status !== 'authenticated' || user === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="text-body text-steel">
          {status === 'loading' ? 'Loading…' : 'Redirecting to sign in…'}
        </p>
      </div>
    );
  }

  const tabs = [
    { href: '/portal', label: 'Inquiries' },
    { href: '/portal/account', label: 'Account' },
  ] as const;

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-5">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-cell tracking-wider text-steel">RATE PORTAL</span>
            <span className="text-section text-hull">{user.agentName}</span>
          </div>
          <Button variant="text" size="inline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 px-5" aria-label="Portal">
          {tabs.map((tab) => {
            const active = tab.href === '/portal' ? pathname === '/portal' : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  'border-b-2 px-2 py-2 text-body transition-colors duration-[120ms] ease-manifest',
                  active
                    ? 'border-harbour text-hull'
                    : 'border-transparent text-steel hover:text-hull',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-6">{children}</main>
      <Toaster position="top-right" richColors />
    </div>
  );
}
