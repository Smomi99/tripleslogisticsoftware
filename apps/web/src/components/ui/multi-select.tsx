'use client';

import type { LookupOption } from '@ff/shared';
import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Searchable multi-select (CLAUDE.md §8).
 *
 * §8 is explicit that agent expert area, port coverage and network membership
 * "use a searchable multi-select writing to the join table — never a
 * comma-joined string column". This component owns the selection; the route
 * turns it into join rows.
 *
 * Port coverage can be a list of hundreds, hence the filter box rather than a
 * plain list of checkboxes.
 */
export function MultiSelect({
  id,
  options,
  value,
  onChange,
  placeholder = 'Choose…',
  searchPlaceholder = 'Type to filter',
  invalid = false,
}: {
  id: string;
  options: LookupOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  invalid?: boolean;
}) {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — the panel is inline, not a portal,
  // so it needs its own dismissal rather than Radix's.
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const selected = useMemo(
    () => options.filter((option) => value.includes(option.id)),
    [options, value],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter((option) => option.name.toLowerCase().includes(needle));
  }, [options, query]);

  function toggle(optionId: string): void {
    onChange(
      value.includes(optionId)
        ? value.filter((v) => v !== optionId)
        : [...value, optionId],
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-invalid={invalid}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex min-h-9 w-full items-center gap-1.5 rounded-manifest border bg-surface px-2.5 py-1 text-left',
          'transition-colors duration-[120ms] ease-manifest',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-harbour',
          invalid ? 'border-alert' : 'border-line',
        )}
      >
        <span className="flex flex-1 flex-wrap gap-1">
          {selected.length === 0 ? (
            <span className="text-body text-steel">{placeholder}</span>
          ) : (
            selected.map((option) => (
              <span
                key={option.id}
                className="inline-flex items-center gap-1 rounded-manifest bg-paper px-1.5 py-0.5 text-cell text-hull"
              >
                {option.name}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Remove ${option.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(option.id);
                  }}
                  className="text-steel hover:text-alert"
                >
                  <X className="size-3" />
                </span>
              </span>
            ))
          )}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-steel" aria-hidden="true" />
      </button>

      {isOpen && (
        <div className="absolute z-40 mt-1 w-full rounded-manifest border border-line bg-surface shadow-manifest">
          <div className="border-b border-line p-1.5">
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 w-full rounded-manifest border border-line px-2 text-body focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            />
          </div>
          <ul role="listbox" aria-multiselectable="true" className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-2.5 py-2 text-cell text-steel">Nothing matches “{query}”.</li>
            ) : (
              filtered.map((option) => {
                const isSelected = value.includes(option.id);
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => toggle(option.id)}
                      className={cn(
                        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body',
                        'transition-colors duration-[120ms] hover:bg-row-hover',
                        isSelected && 'text-hull',
                      )}
                    >
                      <Check
                        className={cn(
                          'size-3.5 shrink-0',
                          isSelected ? 'text-harbour' : 'text-transparent',
                        )}
                        aria-hidden="true"
                      />
                      {option.name}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
