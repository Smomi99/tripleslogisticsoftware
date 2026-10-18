'use client';

import type { StatementRowDto } from '@ff/shared';

import { cn } from '@/lib/utils';

/**
 * A financial statement's grid: Particulars, then one money column per period
 * — the Balance Sheet's and the Cash Flow Statement's (the Income Statement
 * keeps its own, for its percentage rows). Every figure is the server's; this
 * only lays them out, in the Income Statement's style.
 */

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-01" → "01-Oct-2026", the statements' date style. */
export function sheetDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${SHORT[Number(m) - 1]}-${y}`;
}

/** A negative figure reads with its minus sign, in --alert; an empty line as a dash. */
function figure(value: string | null, row: StatementRowDto): { text: string; negative: boolean } {
  if (value === null) return { text: '', negative: false };
  const n = Number(value);
  if (n === 0 && row.kind === 'LINE') return { text: '—', negative: false };
  const shown = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { text: n < 0 ? `-${shown}` : shown, negative: n < 0 };
}

export function StatementTable({
  columns,
  rows,
  pending = false,
}: {
  columns: { label: string; sub: string }[];
  rows: StatementRowDto[];
  pending?: boolean;
}) {
  return (
    <div className={cn('overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest', pending && 'opacity-60')}>
      <table className="w-full min-w-[640px] border-collapse text-cell">
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-line bg-paper">
            <th className="label-manifest px-4 py-2 text-left">Particulars</th>
            {columns.map((c) => (
              <th key={c.label + c.sub} className="px-4 py-2 text-right">
                <span className="label-manifest block">{c.label}</span>
                <span className="block font-mono text-[11px] font-normal tabular-nums text-steel">{c.sub}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.kind === 'SECTION' || row.kind === 'GROUP' ? (
              <tr key={row.key}>
                <td
                  colSpan={columns.length + 1}
                  className={cn(
                    'px-4 pb-1 text-hull',
                    row.kind === 'SECTION' ? 'pt-4 text-body font-semibold uppercase tracking-wide' : 'pt-2 font-semibold',
                  )}
                >
                  {row.label}
                </td>
              </tr>
            ) : (
              <tr
                key={row.key}
                className={cn(
                  'border-line',
                  row.kind === 'LINE' && 'hover:bg-row-hover',
                  row.kind === 'SUBTOTAL' && 'border-t font-semibold',
                  row.kind === 'TOTAL' && 'border-t bg-paper font-semibold uppercase',
                  row.kind === 'CHECK' && 'border-t bg-alert/5 font-semibold text-alert',
                )}
              >
                <td className={cn('px-4 py-1.5', row.kind === 'LINE' ? 'pl-8' : '', row.kind === 'CHECK' ? 'text-alert' : 'text-hull')}>
                  {row.label}
                </td>
                {row.amounts.map((amount, i) => {
                  const shown = figure(amount, row);
                  return (
                    <td
                      key={i}
                      className={cn('px-4 py-1.5 text-right font-mono tabular-nums', shown.negative && 'text-alert')}
                    >
                      {shown.text}
                    </td>
                  );
                })}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
