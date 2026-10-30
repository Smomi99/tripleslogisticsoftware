import { cn } from '@/lib/utils';

/*
 * Parts compared with each other — statuses, top customers, top ports — as
 * one horizontal bar per part on one baseline, in the card's module colour.
 * A bar on a shared baseline compares more exactly than a slice of a pie.
 *
 * Every value is printed beside its bar, so the list is its own table view.
 * Bars are 8px, square at the baseline with a rounded end, on a track one
 * step lighter in the same hue.
 */

export interface BarListItem {
  key: string;
  label: string;
  /** A second, quieter label — a port's country. */
  detail?: string | undefined;
  value: number;
}

export function BarList({
  label,
  items,
  format,
  empty,
}: {
  /** What the list shows, for a screen reader. */
  label: string;
  items: BarListItem[];
  format: (n: number) => string;
  /** Shown when there is nothing to compare. */
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-cell text-steel">{empty}</p>;
  }
  const max = Math.max(0, ...items.map((i) => i.value));

  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-cell">
            <span className="min-w-0 truncate text-hull" title={item.detail === undefined ? item.label : `${item.label} · ${item.detail}`}>
              {item.label}
              {item.detail !== undefined && <span className="text-steel"> · {item.detail}</span>}
            </span>
            <span className="shrink-0 font-mono font-medium text-hull" data-numeric="">
              {format(item.value)}
            </span>
          </div>
          <div aria-hidden="true" className="h-2 rounded-r-full bg-module-soft">
            <div
              className={cn('h-full rounded-r-[4px] bg-harbour')}
              // A zero draws nothing; any other value at least a visible stub.
              style={{ width: `${max === 0 || item.value <= 0 ? 0 : Math.max(1.5, (item.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
