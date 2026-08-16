'use client';

import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

import { buildNav } from './nav-config';

/*
 * §12 sidebar: 240px, --hull, collapsible to 64px, module groups collapsible,
 * active item marked by a 3px --harbour left bar plus a lighter fill.
 *
 * §7 enforcement layer 3: only modules and features where the user holds .VIEW
 * are rendered, and a module with zero visible features is hidden entirely.
 * This is presentation, not security — the API guards every route regardless.
 */

const COLLAPSED_KEY = 'ff.sidebar.collapsed';

export function Sidebar() {
  const pathname = usePathname();
  const { can } = useSession();
  const [collapsed, setCollapsed] = useState(false);
  const [openModules, setOpenModules] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true');
  }, []);

  const groups = useMemo(
    () =>
      buildNav()
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => can(item.viewPermission)),
        }))
        .filter((group) => group.items.length > 0),
    [can],
  );

  // Open the group containing the current route on first render.
  useEffect(() => {
    const active = groups.find((g) =>
      g.items.some((i) => i.href !== null && pathname.startsWith(i.href)),
    );
    if (active !== undefined) {
      setOpenModules((prev) => new Set(prev).add(active.module));
    }
  }, [groups, pathname]);

  function toggleModule(module: string): void {
    setOpenModules((prev) => {
      const next = new Set(prev);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });
  }

  function toggleCollapsed(): void {
    setCollapsed((prev) => {
      window.localStorage.setItem(COLLAPSED_KEY, String(!prev));
      return !prev;
    });
  }

  return (
    <nav
      aria-label="Main"
      className={cn(
        'flex shrink-0 flex-col bg-hull text-white/85 transition-[width] duration-[160ms] ease-manifest',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-white/10 px-4">
        {!collapsed && (
          <span className="font-mono text-cell tracking-wider text-white">FF·ERP</span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto rounded-manifest p-1 text-white/70 transition-colors duration-[120ms] hover:bg-white/10 hover:text-white"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {groups.map((group) => {
          const isOpen = openModules.has(group.module);
          return (
            <div key={group.module} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggleModule(group.module)}
                aria-expanded={isOpen}
                className={cn(
                  'flex w-full items-center gap-2 px-4 py-2 text-left transition-colors duration-[120ms] hover:bg-white/5',
                  collapsed && 'justify-center px-0',
                )}
              >
                {collapsed ? (
                  <span className="font-mono text-cell text-white/70">
                    {group.label.slice(0, 2).toUpperCase()}
                  </span>
                ) : (
                  <>
                    <span className="label-manifest flex-1 text-white/50">
                      {group.label}
                    </span>
                    <ChevronDown
                      className={cn(
                        'size-3.5 text-white/40 transition-transform duration-[120ms]',
                        isOpen && 'rotate-180',
                      )}
                    />
                  </>
                )}
              </button>

              {isOpen && !collapsed && (
                <ul>
                  {group.items.map((item) => {
                    const isActive =
                      item.href !== null && pathname.startsWith(item.href);
                    const content = (
                      <span
                        className={cn(
                          'flex items-center border-l-[3px] py-1.5 pl-[13px] pr-4 text-body transition-colors duration-[120ms]',
                          isActive
                            ? 'border-harbour bg-white/10 text-white'
                            : 'border-transparent text-white/75 hover:bg-white/5 hover:text-white',
                          item.href === null && 'cursor-default text-white/35',
                        )}
                      >
                        {item.label}
                      </span>
                    );
                    return (
                      <li key={item.feature}>
                        {item.href === null ? (
                          <span title="Not built yet">{content}</span>
                        ) : (
                          <Link
                            href={item.href}
                            aria-current={isActive ? 'page' : undefined}
                          >
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
    </nav>
  );
}
