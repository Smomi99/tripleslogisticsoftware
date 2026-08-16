'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';

import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { buildNav, MODULE_LABEL } from './nav-config';

/*
 * §12 top bar: 56px, surface, 1px --line beneath.
 * Layout is breadcrumb · [search] · [tenant] · [user].
 */

function useBreadcrumb(): string[] {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return ['Home'];

  const match = buildNav()
    .flatMap((g) => g.items.map((i) => ({ ...i, module: g.module })))
    .find((i) => i.href !== null && pathname.startsWith(i.href));

  if (match !== undefined) return [MODULE_LABEL[match.module], match.label];
  return segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

export function TopBar() {
  const { user, tenantSlug, signOut } = useSession();
  const crumbs = useBreadcrumb();

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-5">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex items-center gap-1.5 text-cell text-steel">
          {crumbs.map((crumb, index) => (
            <li key={crumb} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden="true">/</span>}
              <span className={cn(index === crumbs.length - 1 && 'text-hull')}>
                {crumb}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <div className="relative hidden md:block">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-steel"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search"
            className="h-8 w-56 rounded-manifest border border-line bg-surface pl-8 pr-2.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
          />
        </div>

        <span className="hidden items-center gap-1.5 sm:flex">
          <span className="label-manifest">Workspace</span>
          <span className="font-mono text-cell text-hull" data-numeric="">
            {tenantSlug}
          </span>
        </span>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className={cn(
              'flex items-center gap-1.5 rounded-manifest px-2 py-1 text-body text-hull',
              'transition-colors duration-[120ms] hover:bg-paper',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-harbour',
            )}
          >
            <span className="max-w-40 truncate">{user?.name ?? user?.username ?? '—'}</span>
            <ChevronDown className="size-3.5 text-steel" aria-hidden="true" />
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="min-w-56 rounded-manifest border border-line bg-surface p-1 shadow-manifest"
            >
              <div className="border-b border-line px-2.5 py-2">
                <p className="text-body text-hull">{user?.name ?? user?.username}</p>
                <p className="text-cell text-steel">{user?.email}</p>
                <p className="mt-1 text-cell text-steel">
                  {user?.isSuperadmin === true ? 'Superadmin' : (user?.roleName ?? 'No role')}
                </p>
              </div>
              <DropdownMenu.Item
                onSelect={() => void signOut()}
                className={cn(
                  'cursor-pointer rounded-manifest px-2.5 py-1.5 text-body text-alert outline-none',
                  'data-[highlighted]:bg-paper',
                )}
              >
                Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
