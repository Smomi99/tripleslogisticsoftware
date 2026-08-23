'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Toaster } from 'sonner';

import { viewPermissionForPath } from '@/components/shell/nav-config';
import { Sidebar } from '@/components/shell/sidebar';
import { TopBar } from '@/components/shell/top-bar';
import { useSession } from '@/lib/session';

/*
 * The §12 application shell:
 *
 *   ┌────────────┬───────────────────────────────────────────────┐
 *   │            │ breadcrumb        [ search ]  [tenant] [user] │
 *   │  SIDEBAR   ├───────────────────────────────────────────────┤
 *   │  240px     │  Page title                    [ + Add … ]    │
 *   │  --hull    │  ┌─────────────────────────────────────────┐  │
 *   │            │  │ search · filters                        │  │
 *   │  9 modules │  ├─────────────────────────────────────────┤  │
 *   │  collapse  │  │ TABLE                                   │  │
 *   │  to 64px   │  └─────────────────────────────────────────┘  │
 *   └────────────┴───────────────────────────────────────────────┘
 *
 * No page-level max-width — §12 is explicit that these tables need every pixel.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, can } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-body text-steel">
          {status === 'loading' ? 'Loading your workspace…' : 'Redirecting to sign in…'}
        </p>
      </div>
    );
  }

  /*
   * §7 enforcement layer 4, for the case the sidebar cannot cover: a URL typed
   * or bookmarked for a screen this user may not open.
   *
   * Without it the page renders its title, filters and an empty table — the API
   * refuses the data, so nothing leaks, but it reads as a broken screen rather
   * than a closed one. That matters most for an agent, whose whole sidebar is
   * one item and who has no way to tell the two apart.
   */
  const required = viewPermissionForPath(pathname);
  const permitted = required === null || can(required);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-auto p-5">
          {permitted ? (
            children
          ) : (
            <div className="flex flex-col items-start gap-2">
              <h1 className="text-page-title text-hull">Not available</h1>
              <p className="max-w-md text-body text-steel">
                You do not have permission to open this screen. If you think you should, ask
                whoever manages your access.
              </p>
            </div>
          )}
        </main>
      </div>
      {/*
        §12 allows one shadow and a 4px radius; the toast follows the same rules
        as every other surface rather than bringing its own look.
      */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          className:
            'rounded-manifest border border-line bg-surface text-hull shadow-manifest text-body',
        }}
      />
    </div>
  );
}
