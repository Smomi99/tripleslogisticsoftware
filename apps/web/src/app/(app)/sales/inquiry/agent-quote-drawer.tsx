'use client';

import type {
  AgentQuoteDecision,
  AgentQuoteOptionDto,
  InquiryDto,
  StaffAgentQuoteDto,
} from '@ff/shared';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { StatusThread } from '@/components/agent-quote/status-thread';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { CONVERT_FEATURE, ConvertQuoteForm, modeOf } from './convert-quote-form';

/**
 * What the agents quoted, and what they changed.
 *
 * The mirror of the agent's own quote form. Without it a price submitted by an
 * agent sits in the database where nobody at the forwarder can see it.
 *
 * A quotation is now a breakdown rather than a number: one or more alternative
 * offers, each a table of charges under its own routing. The collapsed row
 * carries what a buyer scans — who, how much, how long — and the detail below
 * carries every line of it, so comparing two agents does not mean opening two
 * emails.
 *
 * The amendment history is still the part worth having: an agent who drops from
 * 1450 to 1399 the day before a decision is telling you something. It comes
 * from the audit trail, so it covers every write — including one made outside
 * this screen.
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
  WON: 'active',
  LOST: 'inactive',
  WITHDRAWN: 'inactive',
};

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted',
  WON: 'Won',
  LOST: 'Lost',
  WITHDRAWN: 'Withdrawn',
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
          {entry.changes.length > 0 && (
            <ul className="ml-4 flex flex-col gap-0.5">
              {entry.changes.map((change) => (
                <li key={change.field} className="text-cell text-steel">
                  <span className="text-hull">{change.field}</span>: {change.from ?? '—'} →{' '}
                  <span className="text-hull">{change.to ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/** An option's totals, one per currency it uses. */
function Totals({ option, className }: { option: AgentQuoteOptionDto; className?: string }) {
  if (option.totals.length === 0) return <span className="text-steel">—</span>;
  return (
    <span className={className ?? 'flex flex-col items-end'}>
      {option.totals.map((total) => (
        <span
          key={total.currencyId}
          className="whitespace-nowrap font-mono text-cell tabular-nums text-hull"
        >
          {total.currencyCode ?? ''} {money(total.amount)}
        </span>
      ))}
    </span>
  );
}

/** One offer, opened out: every charge line and the routing it travels on. */
function OptionDetail({ option }: { option: AgentQuoteOptionDto }) {
  const facts = [
    ['Carrier', option.carrierName],
    ['T/T', option.transitDays === null ? null : `${option.transitDays} days`],
    ['Via', option.via],
    ['POD free days', option.podFreeDays === null ? null : String(option.podFreeDays)],
    ['Validity', option.validUntil],
    ['ETD', option.etd],
    ['ETA', option.eta],
  ] as const;

  return (
    <div className="rounded-manifest border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-cell font-semibold text-hull">Option {option.position}</span>
        <Totals option={option} className="flex flex-wrap items-baseline gap-x-3" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-180 border-collapse">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest px-3 py-1.5 text-left">Carrier</th>
              <th className="label-manifest px-3 py-1.5 text-left">Cost head</th>
              <th className="label-manifest px-3 py-1.5 text-left">Container</th>
              <th className="label-manifest px-3 py-1.5 text-left">Unit</th>
              <th className="label-manifest px-3 py-1.5 text-right">Qty</th>
              <th className="label-manifest px-3 py-1.5 text-right">Unit price</th>
              <th className="label-manifest px-3 py-1.5 text-left">Cur</th>
              <th className="label-manifest px-3 py-1.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {option.lines.map((line) => (
              <tr key={line.id} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5 text-cell text-steel">{line.carrierName ?? '—'}</td>
                <td className="px-3 py-1.5 text-cell text-hull">{line.costHeadName}</td>
                <td className="px-3 py-1.5 text-cell text-steel">
                  {line.containerTypeName ?? '—'}
                </td>
                <td className="px-3 py-1.5 text-cell text-steel">{line.costUnitName ?? '—'}</td>
                <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                  {line.quantity}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                  {money(line.unitPrice)}
                </td>
                <td className="px-3 py-1.5 font-mono text-cell text-steel">
                  {line.currencyCode ?? '—'}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                  {money(line.totalAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-3 py-2">
        {facts.map(([label, value]) => (
          <span key={label} className="flex items-baseline gap-1.5">
            <span className="label-manifest">{label}</span>
            <span className="font-mono text-cell tabular-nums text-hull">{value ?? '—'}</span>
          </span>
        ))}
      </div>

      {option.remarks !== null && option.remarks !== '' && (
        <p className="whitespace-pre-line border-t border-line px-3 py-2 text-cell text-hull">
          {option.remarks}
        </p>
      )}
    </div>
  );
}

export function AgentQuoteDrawer({
  inquiry,
  onClose,
}: {
  inquiry: InquiryDto | null;
  onClose: () => void;
}) {
  const { authorizedRequest, can } = useSession();
  const [quotes, setQuotes] = useState<StaffAgentQuoteDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toSettle, setToSettle] = useState<{
    quote: StaffAgentQuoteDto;
    decision: AgentQuoteDecision;
  } | null>(null);
  const [settleMessage, setSettleMessage] = useState('');
  const [toConvert, setToConvert] = useState<StaffAgentQuoteDto | null>(null);

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

  const mayDecide = can('SALES.INQUIRY.ATTACH_PRICE');

  async function settle(): Promise<void> {
    if (inquiry === null || toSettle === null) return;
    const { quote, decision } = toSettle;
    setBusy(quote.id);
    try {
      await authorizedRequest(
        `/api/tenant/sales/inquiries/${inquiry.id}/agent-quotes/${quote.id}/decision`,
        {
          method: 'POST',
          body: {
            decision,
            ...(settleMessage.trim() === '' ? {} : { comment: settleMessage.trim() }),
          },
        },
      );
      toast.success(
        decision === 'WON' ? `${quote.agentName} won it` : `${quote.agentName} told`,
      );
      setToSettle(null);
      setSettleMessage('');
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

  // Converting creates a purchase rate, so it needs the purchase permission for
  // THIS inquiry's mode — not whichever one happened to be typed first.
  const convertMode = modeOf(inquiry);
  const mayConvert = convertMode !== null && can(`${CONVERT_FEATURE[convertMode]}.CREATE`);

  const losing = toSettle?.decision === 'LOST';

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
            description="The agents you selected have not priced this inquiry. They can see it on their Agent Inquiry screen, and were emailed when it was raised."
          />
        )}

        {quotes !== null && quotes.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-2 py-2 text-left">Agent</th>
                <th className="label-manifest px-2 py-2 text-left">Offer</th>
                <th className="label-manifest px-2 py-2 text-right">Total</th>
                <th className="label-manifest px-2 py-2 text-right">T/T</th>
                <th className="label-manifest px-2 py-2 text-left">Valid until</th>
                <th className="label-manifest px-2 py-2 text-left">Status</th>
                <th className="label-manifest px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => {
                // A quote from before the breakdown existed has no options; it
                // still has to render, so it becomes one pseudo-row carrying
                // the headline figure it was submitted with.
                const rows: {
                  key: string;
                  label: string;
                  option: AgentQuoteOptionDto | null;
                }[] =
                  quote.options.length > 0
                    ? quote.options.map((option) => ({
                        key: option.id,
                        label: `Option ${option.position}`,
                        option,
                      }))
                    : [{ key: `${quote.id}-legacy`, label: 'Quoted price', option: null }];

                return (
                  // The key belongs on the Fragment, not on the first <tr>
                  // inside it — a row and its expanded detail are siblings of
                  // one list entry.
                  <Fragment key={quote.id}>
                    {rows.map((row, index) => (
                      <tr
                        key={row.key}
                        className={
                          index === rows.length - 1
                            ? 'border-b border-line hover:bg-row-hover [&>td]:align-top'
                            : 'hover:bg-row-hover [&>td]:align-top'
                        }
                      >
                        {index === 0 && (
                          <td
                            rowSpan={rows.length}
                            className="whitespace-nowrap px-2 py-2 text-cell text-hull"
                          >
                            {quote.agentName}
                            {quote.submittedByName !== null && (
                              <div className="text-steel">{quote.submittedByName}</div>
                            )}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-2 py-2 text-cell text-steel">
                          {row.label}
                          {row.option?.carrierName != null && (
                            <div className="text-hull">{row.option.carrierName}</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right">
                          {row.option === null ? (
                            <span className="font-mono text-cell tabular-nums text-hull">
                              {quote.currencyCode ?? ''} {money(quote.amount)}
                            </span>
                          ) : (
                            <Totals option={row.option} />
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-cell tabular-nums text-steel">
                          {(row.option === null ? quote.transitDays : row.option.transitDays) ??
                            '—'}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 font-mono text-cell tabular-nums text-steel">
                          {(row.option === null ? quote.validUntil : row.option.validUntil) ?? '—'}
                        </td>
                        {index === 0 && (
                          <td rowSpan={rows.length} className="px-2 py-2 text-cell">
                            <Status tone={STATUS_TONE[quote.status] ?? 'inactive'}>
                              {STATUS_LABEL[quote.status] ?? quote.status}
                            </Status>
                          </td>
                        )}
                        {index === 0 && (
                          <td
                            rowSpan={rows.length}
                            className="whitespace-nowrap px-2 py-2 text-right text-cell"
                          >
                            <span className="inline-flex items-center gap-3">
                              {/* Only on a quote you have won: turning a price
                                  you did not take into a purchase rate would
                                  file a commitment you never made. */}
                              {decidable && quote.status === 'WON' && mayConvert && (
                                <Button
                                  variant="text"
                                  size="inline"
                                  onClick={() => setToConvert(quote)}
                                >
                                  Convert to rate
                                </Button>
                              )}
                              {decidable && mayDecide && quote.status !== 'WITHDRAWN' && (
                                <>
                                  {quote.status !== 'WON' && (
                                    <Button
                                      variant="text"
                                      size="inline"
                                      disabled={busy === quote.id}
                                      onClick={() => {
                                        setSettleMessage('');
                                        setToSettle({ quote, decision: 'WON' });
                                      }}
                                    >
                                      Won
                                    </Button>
                                  )}
                                  {quote.status !== 'LOST' && (
                                    <Button
                                      variant="destructive"
                                      size="inline"
                                      disabled={busy === quote.id}
                                      onClick={() => {
                                        setSettleMessage('');
                                        setToSettle({ quote, decision: 'LOST' });
                                      }}
                                    >
                                      Lost
                                    </Button>
                                  )}
                                </>
                              )}
                              <button
                                type="button"
                                className="text-harbour hover:underline"
                                onClick={() => setOpen(open === quote.id ? null : quote.id)}
                              >
                                {(() => {
                                  // Count what the AGENT changed. A decision is
                                  // our own entry in the trail and would read as
                                  // though they had moved their price.
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
                        )}
                      </tr>
                    ))}

                    {open === quote.id && (
                      <tr className="border-b border-line bg-paper">
                        <td colSpan={7} className="px-2 py-3">
                          <div className="flex flex-col gap-4">
                            {quote.options.map((option) => (
                              <OptionDetail key={option.id} option={option} />
                            ))}

                            {quote.remarks !== null && quote.remarks !== '' && (
                              <div>
                                <span className="label-manifest">Their remarks</span>
                                <p className="mt-0.5 whitespace-pre-line text-cell text-hull">
                                  {quote.remarks}
                                </p>
                              </div>
                            )}

                            <div>
                              <span className="label-manifest">Messages</span>
                              <div className="mt-1">
                                <StatusThread
                                  endpoint={`/api/tenant/sales/inquiries/${inquiry.id}/agent-quotes/${quote.id}/comments`}
                                  canPost={mayDecide}
                                  emptyHint="Nothing said yet. Anything written here is visible to the agent."
                                />
                              </div>
                            </div>

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
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/*
        §12: every destructive action confirms — and this one carries the
        message the agent will read.
        Required on a loss. "You lost" with no reason is the answer that makes
        an agent stop pricing you sharply, and the client wrote the wording
        they wanted themselves.
      */}
      <Modal
        open={toSettle !== null}
        onOpenChange={(next) => {
          if (!next) {
            setToSettle(null);
            setSettleMessage('');
          }
        }}
        title={losing ? 'Tell them it went elsewhere' : 'Award this business'}
        description={
          toSettle === null
            ? ''
            : losing
              ? `${toSettle.quote.agentName} will see your message on ${inquiry.code} and can no longer amend their price.`
              : `${toSettle.quote.agentName} will see that they won ${inquiry.code}. Their price is then fixed.`
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="settle-message" className="label-manifest">
              Message to the agent {losing ? '(required)' : '(optional)'}
            </label>
            <textarea
              id="settle-message"
              rows={3}
              value={settleMessage}
              onChange={(e) => setSettleMessage(e.target.value)}
              className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
              placeholder={
                losing
                  ? 'Business LOST, your price was not competitive'
                  : 'Anything they should know before the booking.'
              }
            />
            {losing && (
              <p className="text-cell text-steel">
                They will quote you again on the strength of this. Say what beat them.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setToSettle(null);
                setSettleMessage('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant={losing ? 'danger' : 'primary'}
              disabled={busy !== null || (losing && settleMessage.trim() === '')}
              onClick={() => void settle()}
            >
              {losing ? 'Mark as lost' : 'Mark as won'}
            </Button>
          </div>
        </div>
      </Modal>

      <ConvertQuoteForm
        inquiry={inquiry}
        quote={toConvert}
        onClose={() => setToConvert(null)}
        onConverted={() => void load()}
      />
    </Modal>
  );
}
