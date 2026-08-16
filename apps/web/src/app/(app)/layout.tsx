'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Toaster } from 'sonner';

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
  const { status } = useSession();
  const router = useRouter();

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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-auto p-5">{children}</main>
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
