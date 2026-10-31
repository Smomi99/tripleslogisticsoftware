'use client';

import { type FreightRateDto, purchasePrice } from '@ff/shared';
import { Fragment, type ReactNode } from 'react';

import { RowActions } from '@/components/ui/row-actions';
import { cn } from '@/lib/utils';

/**
 * One rate as a card — how the rate tables read on a phone (§12: below md the
 * rows render as cards).
 *
 * The purchase screens and the price lists both draw it, so a rate reads the
 * same wherever it turns up on a phone: code on top, the lane, every tier's
 * price in a grid of its own (the prices are what the screen is for, so they
 * come before the details), then the details, then the actions as chips.
 */
export interface RateCardDetail {
  label: string;
  value: ReactNode;
  /** Mono with tabular figures — dates, counts, days. */
  numeric?: boolean;
}

export function RateCard({
  rate,
  tiers,
  showBuy,
  mutePrices = false,
  badge,
  details,
  actions,
  children,
}: {
  rate: FreightRateDto;
  tiers: { id: string; code: string; label: string }[];
  /** Off hides the buy figure even when the server sent it (the price list's screen-share switch). */
  showBuy: boolean;
  /** Dims the prices, as the price list does for a lapsed rate. */
  mutePrices?: boolean;
  /** Beside the code — the rate's status. */
  badge?: ReactNode;
  details: RateCardDetail[];
  actions?: ReactNode;
  /** Under the details — the price list's local-charge breakdown. */
  children?: ReactNode;
}) {
  return (
    <article className="overflow-hidden rounded-card border border-line bg-surface shadow-manifest">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-module-soft px-4 py-2.5">
        <span className="truncate font-mono font-medium text-harbour" data-numeric="">
          {rate.code}
        </span>
        {badge}
      </header>

      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-body font-semibold text-hull">
            {rate.polName ?? rate.polCode}
            <span className="px-1.5 font-normal text-steel" aria-label="to">
              →
            </span>
            {rate.podName ?? rate.podCode}
          </p>
          <p className="text-cell text-steel">
            {rate.carrierName} · {rate.goodsTypeName}
          </p>
        </div>

        <ul className="grid grid-cols-2 gap-2" aria-label="Prices">
          {tiers.map((tier) => {
            const line = rate.lines.find((l) => l.tierId === tier.id);
            return (
              <li key={tier.id} className="rounded-manifest border border-line px-3 py-2" title={tier.label}>
                <span className="label-manifest block">{tier.code}</span>
                {line === undefined ? (
                  <span className="font-mono text-cell text-steel">—</span>
                ) : (
                  <div className="font-mono text-cell tabular-nums">
                    <div className={mutePrices ? 'text-steel' : 'font-medium text-hull'}>
                      {purchasePrice(line.sellPrice, rate.mode)}{' '}
                      <span className="font-normal text-steel">{rate.currencyCode}</span>
                    </div>
                    {/* Absent unless the server sent it (§4 rule 5). */}
                    {showBuy && line.buyPrice !== undefined && (
                      <div className="text-steel">buy {purchasePrice(line.buyPrice, rate.mode)}</div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <dl className="grid grid-cols-[minmax(6.5rem,38%)_minmax(0,1fr)] gap-x-3 gap-y-2 text-cell">
          {details.map((detail) => (
            <Fragment key={detail.label}>
              <dt className="label-manifest pt-px">{detail.label}</dt>
              <dd
                className={cn('min-w-0 break-words text-hull', detail.numeric === true && 'font-mono tabular-nums')}
              >
                {detail.value}
              </dd>
            </Fragment>
          ))}
        </dl>

        {children}
      </div>

      {/* Collapses when every action was a permission the user lacks. */}
      {actions !== undefined && (
        <div className="border-t border-line px-4 py-3 empty:hidden">
          <RowActions layout="card">{actions}</RowActions>
        </div>
      )}
    </article>
  );
}
