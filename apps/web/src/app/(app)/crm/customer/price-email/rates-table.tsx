'use client';

import {
  formatPriceEmailAmount,
  formatPriceEmailDay,
  type FreightRateDto,
  PRICE_EMAIL_PER_UNIT,
  priceEmailTiers,
} from '@ff/shared';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Step 2's table — the Price List's layout, so a planner reads it the way
 * they already read rates: code, lane, carrier, one column per container size
 * or weight break, then the terms. Selling prices only; the server never sent
 * anything else.
 *
 * A tick on each row says whether it goes in the email. Everything found
 * starts ticked, because the lanes were just chosen on purpose.
 */
export function RatesTable({
  rates,
  picked,
  onChange,
}: {
  rates: FreightRateDto[];
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const tiers = priceEmailTiers(rates);
  const mode = rates[0]?.mode ?? 'SEA_FCL';
  const all = rates.length > 0 && rates.every((r) => picked.has(r.id));
  const some = rates.some((r) => picked.has(r.id));

  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-cell text-steel">Prices {PRICE_EMAIL_PER_UNIT[mode]}.</p>
      <div className="max-h-112 overflow-auto rounded-manifest border border-line">
        <table className="w-full min-w-max border-collapse text-cell">
          <thead className="sticky top-0 z-10">
            <tr className="bg-paper text-left">
              <th className="w-10 border-b border-line bg-paper px-2.5 py-2">
                <input
                  type="checkbox"
                  aria-label="Tick every rate"
                  checked={all}
                  ref={(el) => {
                    // "Some ticked" is a third state a checkbox can only show this way.
                    if (el !== null) el.indeterminate = some && !all;
                  }}
                  onChange={() => onChange(all ? new Set() : new Set(rates.map((r) => r.id)))}
                  className="size-4 accent-harbour"
                />
              </th>
              <Th>Code</Th>
              <Th>POL</Th>
              <Th>POD</Th>
              <Th>Carrier</Th>
              <Th>Goods</Th>
              {tiers.map((tier) => (
                <Th key={tier.tierId} numeric>
                  {tier.label}
                </Th>
              ))}
              <Th numeric>Local charges</Th>
              <Th>Route</Th>
              <Th numeric>Transit</Th>
              <Th numeric>Free days</Th>
              <Th>Valid until</Th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => {
              const on = picked.has(rate.id);
              const text = on ? 'text-hull' : 'text-steel';
              return (
                <tr
                  key={rate.id}
                  className={cn(
                    'border-b border-line last:border-0 [&>td]:align-top',
                    on ? 'hover:bg-row-hover' : 'bg-paper',
                  )}
                >
                  <td className="px-2.5 py-2">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(rate.id)}
                      aria-label={`Send ${rate.polName} to ${rate.podName}, ${rate.carrierName}`}
                      className="size-4 accent-harbour"
                    />
                  </td>
                  {/* §12: the business code in mono on a faintly tinted gutter. */}
                  <td className="whitespace-nowrap bg-paper/60 px-2.5 py-2 font-mono tabular-nums text-steel">
                    {rate.code}
                  </td>
                  <Td className={text}>{rate.polName}</Td>
                  <Td className={text}>{rate.podName}</Td>
                  <Td className={text}>{rate.carrierName}</Td>
                  <Td className={text}>{rate.goodsTypeName}</Td>
                  {tiers.map((tier) => {
                    const line = rate.lines.find((l) => l.tierId === tier.tierId);
                    return (
                      <td
                        key={tier.tierId}
                        className={cn('px-2.5 py-2 text-right font-mono tabular-nums', text)}
                      >
                        {line === undefined ? (
                          <span className="text-steel">—</span>
                        ) : (
                          <>
                            <div className="whitespace-nowrap">
                              {formatPriceEmailAmount(line.sellPrice)}{' '}
                              <span className="text-steel">{rate.currencyCode}</span>
                            </div>
                            {line.minCharge !== null && (
                              <div className="text-steel">
                                min {formatPriceEmailAmount(line.minCharge)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                  <td
                    className="px-2.5 py-2 text-right text-steel"
                    // Named on hover; the email lists them in full under the table.
                    title={
                      rate.localCharges.length === 0
                        ? undefined
                        : rate.localCharges
                            .map(
                              (c) =>
                                `${c.side === 'POL' ? 'Origin' : 'Destination'}: ${c.costHeadName}` +
                                `${c.containerSizeCode === null ? '' : `, ${c.containerSizeCode}`} ` +
                                `${c.currencyCode} ${formatPriceEmailAmount(c.amount)}`,
                            )
                            .join('\n')
                    }
                  >
                    {rate.localCharges.length === 0 ? (
                      <span className="font-mono">—</span>
                    ) : (
                      <span className="cursor-help underline decoration-dotted underline-offset-2">
                        {rate.localCharges.length === 1 ? '1 line' : `${rate.localCharges.length} lines`}
                      </span>
                    )}
                  </td>
                  <Td className="text-steel">{rate.route ?? '—'}</Td>
                  <td className="px-2.5 py-2 text-right font-mono tabular-nums text-steel">
                    {rate.transitDays ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 text-right font-mono tabular-nums text-steel">
                    {rate.freeDays ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2 font-mono tabular-nums">
                    <div className={rate.expiringSoon ? 'text-signal' : text}>
                      {formatPriceEmailDay(rate.validTo)}
                    </div>
                    <div className="text-steel">from {formatPriceEmailDay(rate.validFrom)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th
      className={cn(
        'label-manifest whitespace-nowrap border-b border-line bg-paper px-2.5 py-2',
        numeric === true ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('whitespace-nowrap px-2.5 py-2', className)}>{children}</td>;
}
