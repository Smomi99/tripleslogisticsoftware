'use client';

import type { RatePriceChangeDto } from '@ff/shared';
import type { ReactNode } from 'react';

import { HoverPanel } from '@/components/ui/hover-panel';

/** Stored UTC, read in Dhaka (CLAUDE.md §9). The day is what matters here. */
const dayInDhaka = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

/**
 * Hover — or focus — a price on the Price drawer to see how this lane's price
 * for that carrier and size has moved (client, 2026-10-26).
 */
export function PriceHistoryHover({
  title,
  load,
  children,
}: {
  /** What the panel is about, e.g. "Evergreen Line · 20STD". */
  title: string;
  load: () => Promise<RatePriceChangeDto[]>;
  children: ReactNode;
}) {
  return (
    <HoverPanel
      title={`Price history · ${title}`}
      load={load}
      render={(entries) =>
        entries.length === 0 ? (
          <p className="text-cell text-steel">No earlier prices on record for this lane.</p>
        ) : (
          <table className="w-full text-cell">
            <thead>
              <tr className="border-b border-line">
                <th className="label-manifest py-1 text-left">Date</th>
                <th className="label-manifest py-1 text-right">Price</th>
                <th className="label-manifest py-1 text-right">Change</th>
                <th className="label-manifest py-1 pl-3 text-left">Rate</th>
                <th className="label-manifest py-1 pl-3 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.at}-${index}`} className="border-b border-line last:border-0">
                  <td className="py-1 font-mono text-steel">{dayInDhaka(entry.at)}</td>
                  <td className="py-1 text-right font-mono text-hull">
                    {entry.currencyCode} {entry.sellPrice}
                  </td>
                  <td className="py-1 text-right font-mono text-steel">
                    {entry.change === null
                      ? '—'
                      : entry.change.startsWith('-')
                        ? entry.change
                        : `+${entry.change}`}
                  </td>
                  <td className="py-1 pl-3 font-mono text-steel">{entry.rateCode}</td>
                  <td className="py-1 pl-3 text-steel">{entry.changedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    >
      {children}
    </HoverPanel>
  );
}
