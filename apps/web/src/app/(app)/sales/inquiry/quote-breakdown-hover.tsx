'use client';

import type { QuoteBreakdownDto } from '@ff/shared';
import type { ReactNode } from 'react';

import { HoverPanel } from '@/components/ui/hover-panel';
import { useSession } from '@/lib/session';

/**
 * Hover — or focus — Quoted Price on the Live Inquiry list to see how it is
 * made up (client, 2026-10-26): the quoted rate's freight, each charge it
 * carries, and the total.
 */
export function QuoteBreakdownHover({
  inquiryId,
  children,
}: {
  inquiryId: string;
  children: ReactNode;
}) {
  const { authorizedRequest } = useSession();

  return (
    <HoverPanel
      title="Quoted price"
      width={360}
      load={() =>
        authorizedRequest<QuoteBreakdownDto | null>(
          `/api/tenant/sales/inquiries/${inquiryId}/quote-breakdown`,
        )
      }
      render={(breakdown) =>
        breakdown === null ? (
          <p className="text-cell text-steel">
            No rate is attached, so there is nothing to break down.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-cell text-hull">
              {breakdown.carrierName} · {breakdown.tierLabel}
            </p>
            <table className="w-full text-cell">
              <tbody>
                <tr className="border-b border-line">
                  <td className="py-1 text-hull">Freight</td>
                  <td className="py-1 font-mono text-steel">{breakdown.rateCode}</td>
                  <td className="py-1 text-right font-mono text-hull">
                    {breakdown.currencyCode} {breakdown.freightPrice}
                  </td>
                </tr>
                {breakdown.charges.map((charge, index) => (
                  <tr key={index} className="border-b border-line">
                    <td className="py-1 text-hull">{charge.costHeadName}</td>
                    <td className="py-1 text-steel">{charge.side ?? 'extra'}</td>
                    <td className="py-1 text-right font-mono text-hull">
                      {charge.currencyCode} {charge.amount}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="label-manifest pt-1.5" colSpan={2}>
                    Quoted
                  </td>
                  <td className="pt-1.5 text-right font-mono font-semibold text-hull">
                    {breakdown.currencyCode} {breakdown.quotedPrice}
                  </td>
                </tr>
              </tbody>
            </table>
            {breakdown.charges.some((c) => c.currencyCode !== breakdown.currencyCode) && (
              <p className="text-cell text-steel">
                Charges in another currency are converted to {breakdown.currencyCode} at the rate
                in force when they were chosen.
              </p>
            )}
            {!breakdown.matchesInquiry && (
              <p className="text-cell text-signal">
                The list shows the sent quotation&apos;s total; this is the rate it was quoted from.
              </p>
            )}
          </div>
        )
      }
    >
      {children}
    </HoverPanel>
  );
}
