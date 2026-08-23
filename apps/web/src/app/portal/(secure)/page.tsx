'use client';

import type { AgentInquiryDto } from '@ff/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { Status } from '@/components/ui/status';
import { usePortalSession } from '@/lib/portal-session';

/**
 * "1450.5" -> "1450.50".
 *
 * The API sends money as a decimal string (§4 rule 6) and Postgres does not pad
 * trailing zeros. Money in a column reads as money only when the decimal places
 * line up, which is the entire argument behind §12's tabular figures.
 */
function money(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : amount;
}

/**
 * The inquiries this agent was sent (§5).
 *
 * Every row is one the forwarder chose to show them. There is no browse, no
 * search across the workspace and no "open inquiries near you" — being selected
 * is the whole of the authorization model, and the screen should read that way.
 */
export default function PortalInquiryListPage() {
  const { list } = usePortalSession();
  const [inquiries, setInquiries] = useState<AgentInquiryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await list<AgentInquiryDto[]>(
        `/api/portal/inquiries${pendingOnly ? '?pending=true' : ''}`,
      );
      setInquiries(result.data);
    } catch {
      setError('Could not load your inquiries. Try again in a moment.');
    }
  }, [list, pendingOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-page-title text-hull">Inquiries</h1>
        <label className="flex items-center gap-2 text-body text-steel">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(event) => setPendingOnly(event.target.checked)}
            className="h-4 w-4 rounded-manifest border-line accent-harbour"
          />
          Not yet quoted
        </label>
      </div>

      {error !== null && (
        <p role="alert" className="text-body text-alert">
          {error}
        </p>
      )}

      {inquiries === null && error === null && <p className="text-body text-steel">Loading…</p>}

      {inquiries !== null && inquiries.length === 0 && (
        <EmptyState
          title={pendingOnly ? 'Nothing waiting for a price' : 'No inquiries yet'}
          description={
            pendingOnly
              ? 'You have quoted everything your forwarder has sent you.'
              : 'When your forwarder sends you an inquiry to price, it will appear here and you will get an email.'
          }
        />
      )}

      {inquiries !== null && inquiries.length > 0 && (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Inquiry</th>
                <th className="label-manifest px-3 py-2 text-left">Lane</th>
                <th className="label-manifest px-3 py-2 text-left">Type</th>
                <th className="label-manifest px-3 py-2 text-left">Wanted by</th>
                <th className="label-manifest px-3 py-2 text-right">Your quote</th>
                <th className="label-manifest px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {inquiries.map((inquiry) => (
                <tr key={inquiry.id} className="border-b border-line last:border-0 hover:bg-row-hover">
                  {/* §12: the business code is mono, on a tinted gutter — the
                      anchor the eye returns to when scanning a column. */}
                  <td className="bg-paper/40 px-3 py-2 font-mono text-cell tabular-nums text-hull">
                    {inquiry.code}
                  </td>
                  <td className="px-3 py-2 text-cell text-hull">
                    {inquiry.polName ?? '—'} → {inquiry.podName ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-cell text-steel">
                    {inquiry.shipmentType}
                    {inquiry.loadingType !== null && ` · ${inquiry.loadingType}`}
                  </td>
                  <td className="px-3 py-2 font-mono text-cell tabular-nums text-steel">
                    {inquiry.validTo ?? '—'}
                  </td>
                  {/* §12: numbers right-aligned, and the header with them. */}
                  <td className="px-3 py-2 text-right text-cell">
                    {inquiry.quote === null ? (
                      <Status tone="pending" className="justify-end">
                        Not quoted
                      </Status>
                    ) : (
                      <span className="font-mono tabular-nums text-hull">
                        {inquiry.quote.currencyCode ?? ''} {money(inquiry.quote.amount)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/portal/inquiries/${inquiry.id}`}
                      className="text-cell text-harbour hover:underline"
                    >
                      {inquiry.quote === null ? 'Quote' : 'Open'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
