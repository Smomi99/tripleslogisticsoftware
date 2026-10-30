'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';

import { MODULE_THEME } from '@/components/shell/module-theme';
import { moduleForPath, viewPermissionsForPath } from '@/components/shell/nav-config';
import { MobileNav, Sidebar } from '@/components/shell/sidebar';
import { TopBar } from '@/components/shell/top-bar';
import { useSession } from '@/lib/session';

/*
 * The application shell:
 *
 *   ┌────────────┬───────────────────────────────────────────────┐
 *   │            │ ▔▔▔▔▔▔▔▔▔▔▔ module-colour stripe ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │
 *   │  SIDEBAR   │ [≡] module · page     [search] [workspace] [●]│
 *   │  240px     ├───────────────────────────────────────────────┤
 *   │  --hull    │  [icon] Page title                [ + Add … ] │
 *   │            │  ┌─────────────────────────────────────────┐  │
 *   │  module    │  │ search · filters                        │  │
 *   │  icons     │  ├─────────────────────────────────────────┤  │
 *   │  collapse  │  │ TABLE (cards on a phone)                │  │
 *   │  to 64px   │  └─────────────────────────────────────────┘  │
 *   └────────────┴───────────────────────────────────────────────┘
 *
 * Below lg the sidebar leaves the page and opens as a drawer from [≡].
 * No page-level max-width — these tables need every pixel.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, can } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const module = moduleForPath(pathname);
  const moduleSlug = module === null ? undefined : MODULE_THEME[module].slug;

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  // A tap on a menu item navigates; the drawer should not still be open over
  // the page it opened.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  /*
   * The module colour goes on <html>, not just the shell, because dialogs,
   * dropdowns and toasts portal to <body> and must take the page's colour too.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (moduleSlug === undefined) delete root.dataset.module;
    else root.dataset.module = moduleSlug;
    return () => {
      delete root.dataset.module;
    };
  }, [moduleSlug]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
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
  const required = viewPermissionsForPath(pathname);
  const permitted = required.every((p) => can(p));

  return (
    <div className="flex h-dvh overflow-hidden" data-module={moduleSlug}>
      <Sidebar />
      <MobileNav open={menuOpen} onOpenChange={setMenuOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenMenu={() => setMenuOpen(true)} />
        <main className="flex-1 overflow-auto p-3 pb-6 sm:p-5">
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
      {/* Toasts take the same radius, border and shadow as every other surface. */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          className: 'rounded-card border border-line bg-surface text-hull shadow-raised text-body',
        }}
      />
    </div>
  );
}
