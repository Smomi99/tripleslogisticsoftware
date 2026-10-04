'use client';

import type { KeyboardEvent, ReactNode } from 'react';

/**
 * A row of underlined section tabs — a worklist's views, the parts of
 * Settings → Notifications.
 *
 * Segmented is the other switch: a pill that flips one view between two
 * readings (Accrual | Cash). Tabs change what the page is about. One component
 * each, so every screen draws them the same way.
 */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Shown beside the label. Leave it out where nothing was counted: a 0 would be a claim. */
  count?: number | undefined;
}

export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
  idBase,
}: {
  /** Names the group for a screen reader. */
  label: string;
  value: T;
  tabs: readonly TabItem<T>[];
  onChange: (value: T) => void;
  /** Given, each tab names the TabPanel it shows (same idBase). */
  idBase?: string;
}) {
  // Arrow keys move between tabs and Tab leaves the row: the WAI-ARIA tabs
  // pattern, so a keyboard user is not walked through every tab to reach the form.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const at = tabs.findIndex((t) => t.id === value);
    const next =
      event.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) return;
    const tab = tabs[next];
    if (tab === undefined) return;
    event.preventDefault();
    onChange(tab.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className="flex border-b border-line" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            {...(idBase === undefined
              ? {}
              : { id: `${idBase}-${tab.id}-tab`, 'aria-controls': `${idBase}-${tab.id}-panel` })}
            onClick={() => onChange(tab.id)}
            className={`-mb-px whitespace-nowrap border-b-[3px] px-4 py-2 text-body transition-colors duration-120 ease-out ${
              selected ? 'border-harbour font-semibold text-hull' : 'border-transparent text-steel hover:text-hull'
            }`}
          >
            {/* A bold copy holds the width, so the row does not shift when a tab is chosen. */}
            <span className="inline-flex flex-col">
              <span>{tab.label}</span>
              <span aria-hidden="true" className="invisible h-0 overflow-hidden font-semibold">
                {tab.label}
              </span>
            </span>
            {tab.count !== undefined && <span className="ml-2 font-mono text-cell tabular-nums">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What one tab shows. Hidden rather than unmounted, so a half-filled form on
 * another tab is still there when you come back to it.
 */
export function TabPanel({
  idBase,
  id,
  selected,
  children,
}: {
  idBase: string;
  id: string;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={`${idBase}-${id}-panel`} aria-labelledby={`${idBase}-${id}-tab`} hidden={!selected}>
      {children}
    </div>
  );
}
