'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Menu, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';

import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { MODULE_THEME } from './module-theme';
import {
  buildNav,
  featureLabelForPath,
  isOnRoute,
  MODULE_LABEL,
  moduleForPath,
} from './nav-config';

/*
 * The top bar: 56px, surface, 1px --line beneath, and a 3px stripe in the
 * current module's colour along its top edge.
 * Layout is [menu] · breadcrumb · [search] · [workspace] · [user].
 * The menu button shows below lg, where the sidebar becomes a drawer.
 */

function usePageLabel(): string {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return 'Overview';

  const match = buildNav()
    .flatMap((g) => g.items)
    .find((i) => i.href !== null && isOnRoute(pathname, i.href));

  if (match !== undefined) return match.label;
  const featureLabel = featureLabelForPath(pathname);
  if (featureLabel !== null) return featureLabel;
  const last = (segments[segments.length - 1] ?? '').replaceAll('-', ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user, tenantSlug, signOut } = useSession();
  const pathname = usePathname();
  const module = moduleForPath(pathname);
  const pageLabel = usePageLabel();
  const displayName = user?.name ?? user?.username ?? '—';
  const ModuleIcon = module === null ? null : MODULE_THEME[module].icon;

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-4 sm:px-5">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-linear-to-r from-module to-harbour" />

      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="-ml-1 rounded-manifest p-2 text-hull transition-colors duration-[120ms] hover:bg-paper lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-2 text-cell">
          {module !== null && ModuleIcon !== null && (
            <li className="flex shrink-0 items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-module-soft px-2.5 py-1 font-medium text-harbour">
                <ModuleIcon className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{MODULE_LABEL[module]}</span>
              </span>
              <span aria-hidden="true" className="hidden text-steel sm:inline">
                /
              </span>
            </li>
          )}
          <li className="min-w-0 truncate text-body font-medium text-hull" aria-current="page">
            {pageLabel}
          </li>
        </ol>
      </nav>

      <div className="flex shrink-0 items-center gap-3">
        <div className="relative hidden xl:block">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-steel"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search"
            className="h-9 w-56 rounded-full border border-line bg-paper pl-8 pr-3 text-body text-hull transition-colors duration-[120ms] focus:bg-surface focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
          />
        </div>

        <span className="hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 md:flex">
          <span className="text-cell text-steel">Workspace</span>
          <span className="font-mono text-cell font-medium text-hull" data-numeric="">
            {tenantSlug}
          </span>
        </span>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label={`Account: ${displayName}`}
            className={cn(
              'flex items-center gap-2 rounded-full py-1 pl-1 pr-1 text-body text-hull sm:pr-2',
              'transition-colors duration-[120ms] hover:bg-paper',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-harbour',
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-linear-135 from-module to-harbour text-cell font-semibold text-white"
            >
              {initialsOf(displayName)}
            </span>
            <span className="hidden max-w-40 truncate sm:inline">{displayName}</span>
            <ChevronDown className="hidden size-3.5 text-steel sm:block" aria-hidden="true" />
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-60 rounded-card border border-line bg-surface p-1.5 shadow-raised animate-fade-in"
            >
              <div className="mb-1 rounded-manifest bg-module-soft px-3 py-2.5">
                <p className="text-body font-medium text-hull">{user?.name ?? user?.username}</p>
                <p className="text-cell text-steel">{user?.email}</p>
                <p className="mt-1.5 inline-block rounded-full bg-surface px-2 py-0.5 text-cell font-medium text-harbour">
                  {user?.isSuperadmin === true ? 'Superadmin' : (user?.roleName ?? 'No role')}
                </p>
              </div>
              <p className="px-3 py-1.5 text-cell text-steel md:hidden">
                Workspace{' '}
                <span className="font-mono text-hull" data-numeric="">
                  {tenantSlug}
                </span>
              </p>
              <DropdownMenu.Item
                onSelect={() => void signOut()}
                className={cn(
                  'cursor-pointer rounded-manifest px-3 py-2 text-body text-alert outline-none',
                  'data-[highlighted]:bg-alert/5',
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
