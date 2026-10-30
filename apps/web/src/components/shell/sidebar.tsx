'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, LayoutDashboard, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

import { MODULE_THEME } from './module-theme';
import { buildNav, isOnRoute } from './nav-config';

/*
 * The sidebar — the sea at dusk.
 *
 * A deep navy-to-indigo panel lit by a soft glow in the current module's
 * colour (violet in Purchase, pink in Sales …), with the corrugation of a
 * container wall fading in towards the foot and three faint swells along the
 * bottom edge. Every decorative layer sits behind the content, holds no text,
 * and is aria-hidden; the menu text stays white on navy.
 *
 * Each module's screens hang off a thin line like the stops on a route: the
 * screen you are on is the lit stop, in its module's colour. The module that
 * holds it has its icon tile filled.
 *
 *   lg and up   a 240px panel floating beside the page, collapsible to a 64px
 *               icon rail.
 *   below lg    hidden; the top bar's menu button opens the same panel as a
 *               slide-out drawer (MobileNav).
 *
 * §7 enforcement layer 3: only modules and features where the user holds .VIEW
 * are rendered, and a module with zero visible features is hidden entirely.
 * This is presentation, not security — the API guards every route regardless.
 */

const COLLAPSED_KEY = 'ff.sidebar.collapsed';

/** The desktop panel. Hidden below lg, where MobileNav takes over. */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true');
  }, []);

  function setAndStore(next: boolean): void {
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, String(next));
  }

  return (
    <div className="hidden shrink-0 py-3 pl-3 lg:flex">
      <nav
        aria-label="Main"
        className={cn(
          'relative isolate flex flex-col overflow-hidden rounded-[20px] text-white/85 shadow-raised',
          'bg-linear-to-b from-hull via-hull to-night',
          'transition-[width] duration-[160ms] ease-manifest',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <Backdrop />
        <div className={cn('flex h-16 shrink-0 items-center gap-2', collapsed ? 'justify-center px-2' : 'px-4')}>
          {!collapsed && <Brand />}
          <button
            type="button"
            onClick={() => setAndStore(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'rounded-manifest p-1.5 text-white/60 transition-colors duration-[120ms] hover:bg-white/10 hover:text-white',
              !collapsed && 'ml-auto',
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        <NavContent collapsed={collapsed} onExpand={() => setAndStore(false)} />
        <Footer collapsed={collapsed} />
      </nav>
    </div>
  );
}

/**
 * The phone and tablet menu: the same panel in a drawer from the left.
 * Radix traps focus, closes on Escape and on the overlay, and hands focus back
 * to the menu button.
 */
export function MobileNav({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-hull/50 animate-fade-in lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 left-0 z-50 isolate flex w-[min(18rem,85vw)] flex-col overflow-hidden rounded-r-[20px]',
            'bg-linear-to-b from-hull via-hull to-night text-white/85 shadow-raised animate-drawer-in lg:hidden',
          )}
        >
          <Backdrop />
          <div className="flex h-16 shrink-0 items-center gap-2 px-4">
            <Dialog.Title asChild>
              <span>
                <Brand />
              </span>
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close menu"
              className="ml-auto rounded-manifest p-2 text-white/70 transition-colors duration-[120ms] hover:bg-white/10 hover:text-white"
            >
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <NavContent collapsed={false} roomy />
          <Footer collapsed={false} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The panel's decoration, behind everything: two glows in the current
 * module's colours, the container-wall ridges, and the swells at the foot.
 */
function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-20 -top-24 size-60 rounded-full bg-module/30 blur-3xl" />
      <div className="absolute -bottom-28 -right-24 size-72 rounded-full bg-harbour/25 blur-3xl" />
      <div className="sidebar-ridges absolute inset-0" />
      <svg
        viewBox="0 0 240 90"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-24 w-full text-module"
      >
        <path d="M0 34 Q30 22 60 34 T120 34 T180 34 T240 34" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
        <path d="M0 54 Q30 42 60 54 T120 54 T180 54 T240 54" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
        <path d="M0 74 Q30 62 60 74 T120 74 T180 74 T240 74" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

/** Four stacked container blocks in module colours, beside the product name. */
function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid grid-cols-2 gap-[3px] rounded-manifest bg-white/[0.06] p-1.5 ring-1 ring-white/10"
      >
        <span data-module="purchase" className="size-2.5 rounded-[3px] bg-module" />
        <span data-module="customer-service" className="size-2.5 rounded-[3px] bg-module" />
        <span data-module="operation" className="size-2.5 rounded-[3px] bg-module" />
        <span data-module="accounts" className="size-2.5 rounded-[3px] bg-module" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-cell font-semibold tracking-wider text-white">FF·ERP</span>
        <span className="text-[11px] text-white/50">Freight forwarding</span>
      </span>
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Who is signed in, at the foot of the panel. The account menu itself is in the top bar. */
function Footer({ collapsed }: { collapsed: boolean }) {
  const { user } = useSession();
  const name = user?.name ?? user?.username ?? '—';
  const role = user?.isSuperadmin === true ? 'Superadmin' : (user?.roleName ?? 'No role');
  return (
    <div className={cn('shrink-0 p-3', collapsed && 'px-2')}>
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-card bg-white/[0.06] ring-1 ring-white/10',
          collapsed ? 'justify-center p-1.5' : 'p-2',
        )}
        title={collapsed ? `${name} · ${role}` : undefined}
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-linear-135 from-module to-harbour text-cell font-semibold text-white"
        >
          {initialsOf(name)}
        </span>
        {!collapsed && (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-cell font-medium text-white">{name}</span>
            <span className="truncate text-[11px] text-white/50">{role}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function NavContent({
  collapsed,
  onExpand,
  roomy = false,
}: {
  collapsed: boolean;
  /** Collapsed rail only: clicking a module icon opens the rail onto that module. */
  onExpand?: () => void;
  /** Taller rows in the drawer, where they are tapped rather than clicked. */
  roomy?: boolean;
}) {
  const pathname = usePathname();
  const { can } = useSession();
  const [openModules, setOpenModules] = useState<Set<string>>(new Set());

  const groups = useMemo(
    () =>
      buildNav()
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => item.viewPermissions.every((p) => can(p))),
        }))
        .filter((group) => group.items.length > 0),
    [can],
  );

  // Open the group containing the current route on first render.
  useEffect(() => {
    const active = groups.find((g) =>
      g.items.some((i) => i.href !== null && isOnRoute(pathname, i.href)),
    );
    if (active !== undefined) {
      setOpenModules((prev) => new Set(prev).add(active.module));
    }
  }, [groups, pathname]);

  function toggleModule(module: string): void {
    if (collapsed) {
      setOpenModules((prev) => new Set(prev).add(module));
      onExpand?.();
      return;
    }
    setOpenModules((prev) => {
      const next = new Set(prev);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });
  }

  const isOverview = pathname === '/';

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
      <Link
        href="/"
        aria-current={isOverview ? 'page' : undefined}
        title={collapsed ? 'Overview' : undefined}
        className={cn(
          'mb-3 flex items-center gap-3 rounded-card px-2 text-body transition-colors duration-[120ms]',
          roomy ? 'py-2.5' : 'py-2',
          collapsed && 'justify-center px-0',
          isOverview ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/5 hover:text-white',
        )}
      >
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-manifest',
            isOverview
              ? 'bg-linear-135 from-module to-harbour text-white shadow-lg shadow-module/30'
              : 'bg-white/10 text-white/80',
          )}
        >
          <LayoutDashboard className="size-4" aria-hidden="true" />
        </span>
        {!collapsed && <span className="font-medium">Overview</span>}
      </Link>

      {!collapsed && <p className="mb-1.5 px-2 text-label font-semibold uppercase tracking-[0.08em] text-white/40">Modules</p>}

      {groups.map((group) => {
        const isOpen = openModules.has(group.module) && !collapsed;
        const { slug, icon: Icon } = MODULE_THEME[group.module];
        const holdsActive = group.items.some(
          (i) => i.href !== null && isOnRoute(pathname, i.href),
        );
        return (
          <div key={group.module} data-module={slug} className="mb-0.5">
            <button
              type="button"
              onClick={() => toggleModule(group.module)}
              aria-expanded={collapsed ? undefined : isOpen}
              aria-label={collapsed ? group.label : undefined}
              title={collapsed ? group.label : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-card px-2 text-left transition-colors duration-[120ms] hover:bg-white/5',
                roomy ? 'py-2' : 'py-1.5',
                collapsed && 'justify-center px-0',
              )}
            >
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-manifest transition-colors duration-[120ms]',
                  holdsActive
                    ? 'bg-linear-135 from-module to-harbour text-white shadow-lg shadow-module/30'
                    : 'bg-module/15 text-module ring-1 ring-module/20',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              {!collapsed && (
                <>
                  <span
                    className={cn(
                      'flex-1 truncate text-body',
                      holdsActive ? 'font-semibold text-white' : 'font-medium text-white/80',
                    )}
                  >
                    {group.label}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-4 text-white/40 transition-transform duration-[120ms]',
                      isOpen && 'rotate-180',
                    )}
                    aria-hidden="true"
                  />
                </>
              )}
            </button>

            {isOpen && (
              // The route line runs down from under the module's icon; each
              // screen is a stop on it.
              <ul className="relative mb-2 ml-6 mt-0.5 border-l border-white/15 py-0.5">
                {group.items.map((item, index) => {
                  const isActive = item.href !== null && isOnRoute(pathname, item.href);
                  // The client's nested menu headings ("- Transaction"):
                  // drawn once, above the first visible item they cover.
                  const heading =
                    item.section !== undefined && item.section !== group.items[index - 1]?.section
                      ? item.section
                      : null;
                  const content = (
                    <span
                      className={cn(
                        'relative ml-3 flex items-center rounded-manifest pl-2.5 pr-2 text-body transition-colors duration-[120ms]',
                        roomy ? 'py-2' : 'py-1.5',
                        isActive
                          ? 'bg-linear-to-r from-module/25 to-white/[0.04] font-medium text-white'
                          : 'text-white/65 hover:bg-white/5 hover:text-white',
                        item.href === null && 'cursor-default text-white/30 hover:bg-transparent hover:text-white/30',
                      )}
                    >
                      {/* The stop: lit in the module's colour where you are. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute top-1/2 -translate-y-1/2 rounded-full',
                          isActive
                            ? '-left-[17px] size-2.5 bg-module ring-4 ring-module/25'
                            : '-left-[15px] size-1.5 bg-white/25',
                        )}
                      />
                      {item.label}
                    </span>
                  );
                  // Keyed on the path, not the feature: one feature can own
                  // two menu items (§3's Shipment Booking - Sea / - Air).
                  return (
                    <li key={item.href ?? item.label}>
                      {heading !== null && (
                        <span className="ml-3 block pb-0.5 pl-2.5 pt-2 text-label font-semibold uppercase tracking-[0.06em] text-white/40">
                          {heading}
                        </span>
                      )}
                      {item.href === null ? (
                        <span title="Not built yet">{content}</span>
                      ) : (
                        <Link href={item.href} aria-current={isActive ? 'page' : undefined}>
                          {content}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
