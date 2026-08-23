'use client';

import type { AgentQuoteDecision, InquiryDto, StaffAgentQuoteDto } from '@ff/shared';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * What the agents quoted, and what they changed.
 *
 * The mirror of the portal's quote form. Without it a price submitted by an
 * agent sits in the database where nobody at the forwarder can see it.
 *
 * The amendment history is the part worth having: an agent who drops from 1450
 * to 1399 the day before a decision is telling you something, and answering
 * "what did they change?" should not need a DBA. It comes from the audit trail,
 * so it covers every write — including one made outside this screen.
 */

/** "1450.5" -> "1,450.50", so a column of prices lines up (§12). */
function money(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : amount;
}

const STATUS_TONE: Record<string, 'active' | 'pending' | 'inactive' | 'overdue'> = {
  SUBMITTED: 'pending',
  ACCEPTED: 'active',
  DECLINED: 'inactive',
  WITHDRAWN: 'inactive',
};

function History({ quote }: { quote: StaffAgentQuoteDto }) {
  if (quote.history.length === 0) {
    return <p className="text-cell text-steel">No changes since it was submitted.</p>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {quote.history.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="flex flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-cell tabular-nums text-steel">
              {new Date(entry.at).toLocaleString()}
            </span>
            <span className="text-cell text-hull">
              {entry.kind === 'SUBMITTED'
                ? 'Submitted'
                : entry.kind === 'DECIDED'
                  ? 'Answered by your team'
                  : 'Amended'}
            </span>
          </span>
          {entry.changes.map((change) => {
            // The snapshot holds the raw column value; a price in a diff should
            // read the same way as the price in the row above it.
            const show = (v: string | null) =>
              v === null ? '—' : change.field === 'Price' ? money(v) : v;
            return (
              <span key={change.field} className="text-cell text-steel">
                {change.field}:{' '}
                <span className="font-mono tabular-nums text-alert line-through">
                  {show(change.from)}
                </span>{' '}
                →{' '}
                <span className="font-mono tabular-nums text-hull">{show(change.to)}</span>
              </span>
            );
          })}
        </li>
      ))}
    </ol>
  );
}

export function AgentQuoteDrawer({
  inquiry,
  onClose,
}: {
  inquiry: InquiryDto | null;
  onClose: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [quotes, setQuotes] = useState<StaffAgentQuoteDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDecline, setToDecline] = useState<StaffAgentQuoteDto | null>(null);

  const load = useCallback(async () => {
    if (inquiry === null) return;
    setQuotes(null);
    setError(null);
    try {
      setQuotes(
        await authorizedRequest<StaffAgentQuoteDto[]>(
          `/api/tenant/sales/inquiries/${inquiry.id}/agent-quotes`,
        ),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the quotes.');
    }
  }, [authorizedRequest, inquiry]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(quote: StaffAgentQuoteDto, decision: AgentQuoteDecision): Promise<void> {
    if (inquiry === null) return;
    setBusy(quote.id);
    try {
      await authorizedRequest(
        `/api/tenant/sales/inquiries/${inquiry.id}/agent-quotes/${quote.id}/decision`,
        { method: 'POST', body: { decision } },
      );
      toast.success(
        decision === 'ACCEPTED'
          ? `Accepted ${quote.agentName}`
          : `Declined ${quote.agentName}`,
      );
      setToDecline(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not record that.');
    } finally {
      setBusy(null);
    }
  }

  if (inquiry === null) return null;

  // A settled inquiry takes no more decisions, the same rule that stops it
  // being re-quoted.
  const decidable = inquiry.status !== 'WON' && inquiry.status !== 'LOST';

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Agent quotes — ${inquiry.code}`}
      description="What your agents came back with, and what they have changed since."
      size="wide"
    >
      <div className="flex flex-col gap-4">
        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}
        {quotes === null && error === null && <p className="text-cell text-steel">Loading…</p>}

        {quotes !== null && quotes.length === 0 && (
          <EmptyState
            title="No quotes yet"
            description="The agents you selected have not priced this inquiry. They can see it in the portal, and were emailed when it was raised."
          />
        )}

        {quotes !== null && quotes.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-2 py-2 text-left">Agent</th>
                <th className="label-manifest px-2 py-2 text-right">Price</th>
                <th className="label-manifest px-2 py-2 text-right">Transit</th>
                <th className="label-manifest px-2 py-2 text-left">Valid until</th>
                <th className="label-manifest px-2 py-2 text-left">Status</th>
                <th className="label-manifest px-2 py-2 text-right">Changes</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => (
                // The key belongs on the Fragment, not on the first <tr> inside
                // it — a row and its expanded detail are two siblings of one
                // list entry.
                <Fragment key={quote.id}>
                  <tr className="border-b border-line hover:bg-row-hover [&>td]:align-top">
                    <td className="whitespace-nowrap px-2 py-2 text-cell text-hull">
                      {quote.agentName}
                      {quote.submittedByName !== null && (
                        <div className="text-steel">{quote.submittedByName}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-cell tabular-nums text-hull">
                      {quote.currencyCode ?? ''} {money(quote.amount)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-cell tabular-nums text-steel">
                      {quote.transitDays ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-cell tabular-nums text-steel">
                      {quote.validUntil ?? '—'}
                    </td>
                    <td className="px-2 py-2 text-cell">
                      <Status tone={STATUS_TONE[quote.status] ?? 'inactive'}>{quote.status}</Status>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-cell">
                      <span className="inline-flex items-center gap-3">
                        {/* Reversible on purpose: Accept and Decline are one
                            mis-click apart, and a decided quote can no longer
                            be amended by the agent. */}
                        {decidable && quote.status !== 'WITHDRAWN' && (
                          <>
                            {quote.status !== 'ACCEPTED' && (
                              <Button
                                variant="text"
                                size="inline"
                                disabled={busy === quote.id}
                                onClick={() => void decide(quote, 'ACCEPTED')}
                              >
                                Accept
                              </Button>
                            )}
                            {quote.status !== 'DECLINED' && (
                              <Button
                                variant="destructive"
                                size="inline"
                                disabled={busy === quote.id}
                                onClick={() => setToDecline(quote)}
                              >
                                Decline
                              </Button>
                            )}
                          </>
                        )}
                        {/* The count is the useful signal on a dense row: an
                            amended quote is worth opening, an untouched one is
                            not. */}
                        <button
                          type="button"
                          className="text-harbour hover:underline"
                          onClick={() => setOpen(open === quote.id ? null : quote.id)}
                        >
                          {(() => {
                            // Count what the AGENT changed. A decision is our
                            // own entry in the trail and would otherwise read
                            // as though they had moved their price.
                            const amendments = quote.history.filter(
                              (h) => h.kind === 'AMENDED',
                            ).length;
                            return amendments === 0
                              ? 'Details'
                              : `${amendments} amendment${amendments === 1 ? '' : 's'}`;
                          })()}
                        </button>
                      </span>
                    </td>
                  </tr>
                  {open === quote.id && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={6} className="px-2 py-3">
                        <div className="flex flex-col gap-3">
                          {quote.remarks !== null && quote.remarks !== '' && (
                            <div>
                              <span className="label-manifest">Their remarks</span>
                              <p className="mt-0.5 whitespace-pre-line text-cell text-hull">
                                {quote.remarks}
                              </p>
                            </div>
                          )}
                          <div>
                            <span className="label-manifest">History</span>
                            <div className="mt-1">
                              <History quote={quote} />
                            </div>
                          </div>
                          <span className="font-mono text-cell tabular-nums text-steel">
                            {quote.code} · submitted{' '}
                            {new Date(quote.submittedAt).toLocaleString()}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* §12: every destructive action confirms. Declining tells an outside
          company their price was rejected, and stops them amending it. */}
      <Modal
        open={toDecline !== null}
        onOpenChange={(next) => !next && setToDecline(null)}
        title="Decline this quote"
        description={
          toDecline === null
            ? ''
            : `${toDecline.agentName} will no longer be able to amend their price on ${inquiry.code}.`
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setToDecline(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy !== null}
            onClick={() => toDecline !== null && void decide(toDecline, 'DECLINED')}
          >
            Decline
          </Button>
        </div>
      </Modal>
    </Modal>
  );
}
