'use client';

import {
  DEFAULT_PRICE_EMAIL_MESSAGE,
  defaultPriceEmailSubject,
  type EmailCheckDto,
  type FreightRateDto,
  type LookupOption,
  PRICE_EMAIL_MAX_RATES,
  PRICE_EMAIL_PARTY_NOUN,
  type PriceEmailContextDto,
  type PriceEmailOptionsDto,
  type PriceEmailParty,
  type PriceEmailRatesDto,
  type PriceEmailRecipientsDto,
  type PriceEmailSendResultDto,
  priceEmailHtml,
  RATE_MODE_LABEL,
  type RateMode,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { MultiSelect } from '@/components/ui/multi-select';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { RatesTable } from './rates-table';
import { type AddressRow, type RecipientRow, RecipientsPanel } from './recipients-panel';

/**
 * Email prices — CRM → Customer (2026-09-29) and CRM → Agent (2026-10-06).
 *
 * Three steps down the page — who, which rates, what it says — and a summary
 * beside them that holds the one Send button and says plainly what is still
 * in the way. Each customer or agent gets their own letter; replies go to the
 * Price team; only selling prices ever reach the text.
 *
 * One screen for both: the agents' is the customers' in every respect, and
 * two copies would drift the first time either changed.
 * The route pages read their list's filters and say them in words; everything
 * else is here.
 */

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour';

/** Where each party's list lives, and the permission its button needs. */
const LIST_HREF: Record<PriceEmailParty, Route> = {
  customer: '/crm/customer',
  agent: '/crm/agent',
};
const PERMISSION: Record<PriceEmailParty, string> = {
  customer: 'CRM.CUSTOMER.PRICE_EMAIL',
  agent: 'CRM.AGENT.PRICE_EMAIL',
};

/** "Chattogram (BDCGP)" → "Chattogram", for a subject line that reads like one. */
const bareName = (name: string): string => name.replace(/\s*\([^)]*\)$/, '');

/** React keys for address chips — only ever compared, never shown. */
let keySeq = 0;
const key = (): string => `a${(keySeq += 1)}`;

export function PriceEmailScreen({
  party,
  filters,
  described,
}: {
  party: PriceEmailParty;
  /** The list's search and filters, exactly as its button carried them. */
  filters: Record<string, string>;
  /** Those filters in words for the header; null when the list was unfiltered. */
  described: string | null;
}) {
  const { authorizedRequest, can } = useSession();
  const noun = PRICE_EMAIL_PARTY_NOUN[party];
  const base = `/api/tenant/crm/${party}-price-email`;
  const listHref = LIST_HREF[party];

  // A string, so a page that rebuilds the object each render does not reload.
  const filterQuery = new URLSearchParams(filters).toString();

  const [context, setContext] = useState<PriceEmailContextDto | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<RateMode | null>(null);
  const [options, setOptions] = useState<PriceEmailOptionsDto>({ pols: [], pods: [], carriers: [] });
  const [polIds, setPolIds] = useState<string[]>([]);
  const [podIds, setPodIds] = useState<string[]>([]);
  const [carrierId, setCarrierId] = useState('');
  const [includeLocal, setIncludeLocal] = useState(true);

  const [rates, setRates] = useState<FreightRateDto[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [ratesLoading, setRatesLoading] = useState(false);
  /** The rates ticked to go in the email — every one found, until somebody unticks. */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [subject, setSubject] = useState('');
  const [subjectEdited, setSubjectEdited] = useState(false);
  const [message, setMessage] = useState(DEFAULT_PRICE_EMAIL_MESSAGE);

  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<number | null>(null);

  // ------------------------------------------------------------------ load
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ctx, found] = await Promise.all([
          authorizedRequest<PriceEmailContextDto>(`${base}/context`),
          authorizedRequest<PriceEmailRecipientsDto>(`${base}/recipients?${filterQuery}`),
        ]);
        if (cancelled) return;
        setContext(ctx);
        setMode(ctx.modes[0] ?? null);
        setRecipients(
          found.recipients.map((r) => ({
            ...r,
            emails: r.emails.map((e) => ({ ...e, key: key(), checking: false })),
          })),
        );
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof ApiError ? error.message : `Could not load the ${noun.many}.`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, base, filterQuery, noun.many]);

  // A new mode means new ports: the old picks would not exist in it.
  useEffect(() => {
    if (mode === null) return;
    let cancelled = false;
    setPolIds([]);
    setPodIds([]);
    setCarrierId('');
    setRates(null);
    void authorizedRequest<PriceEmailOptionsDto>(`${base}/options?mode=${mode}`)
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOptions({ pols: [], pods: [], carriers: [] });
          toast.error(error instanceof ApiError ? error.message : 'Could not load the ports.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, base, mode]);

  // The rates for the lanes picked — debounced, since picking five PODs is five changes.
  useEffect(() => {
    if (mode === null || polIds.length === 0 || podIds.length === 0) {
      setRates(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ mode, polIds: polIds.join(','), podIds: podIds.join(',') });
      if (carrierId !== '') query.set('carrierId', carrierId);
      setRatesLoading(true);
      void authorizedRequest<PriceEmailRatesDto>(`${base}/rates?${query.toString()}`)
        .then((found) => {
          if (cancelled) return;
          setRates(found.rates);
          setTruncated(found.truncated);
          setPicked(new Set(found.rates.map((r) => r.id)));
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            toast.error(error instanceof ApiError ? error.message : 'Could not load the rates.');
          }
        })
        .finally(() => {
          if (!cancelled) setRatesLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authorizedRequest, base, carrierId, mode, podIds, polIds]);

  // The rows ticked, in the table's order — what the email will carry.
  const chosen = useMemo(() => (rates ?? []).filter((r) => picked.has(r.id)), [picked, rates]);

  // The subject follows the lanes until somebody writes their own.
  useEffect(() => {
    if (subjectEdited || mode === null) return;
    const names = (ids: string[], from: LookupOption[]) =>
      ids.map((id) => bareName(from.find((o) => o.id === id)?.name ?? '')).filter((n) => n !== '');
    setSubject(defaultPriceEmailSubject(mode, names(polIds, options.pols), names(podIds, options.pods)));
  }, [mode, options.pods, options.pols, podIds, polIds, subjectEdited]);

  // ----------------------------------------------------------- addresses
  function patchAddress(partyId: string, k: string, patch: Partial<AddressRow> | null): void {
    setRecipients((current) =>
      current === null
        ? current
        : current.map((r) =>
            r.partyId !== partyId
              ? r
              : {
                  ...r,
                  emails:
                    patch === null
                      ? r.emails.filter((e) => e.key !== k)
                      : r.emails.map((e) => (e.key === k ? { ...e, ...patch } : e)),
                },
          ),
    );
  }

  /** The server checks it the same way the list was checked — shape, then domain. */
  async function check(partyId: string, k: string, address: string): Promise<void> {
    try {
      const [result] = await authorizedRequest<EmailCheckDto[]>(`${base}/check`, {
        method: 'POST',
        body: { addresses: [address] },
      });
      patchAddress(partyId, k, {
        address: result?.address ?? address,
        valid: result?.valid ?? false,
        reason: result?.reason ?? 'Could not be checked.',
        checking: false,
      });
    } catch {
      patchAddress(partyId, k, {
        valid: false,
        reason: 'Could not be checked — try editing it again.',
        checking: false,
      });
    }
  }

  function isDuplicate(partyId: string, address: string, except?: string): boolean {
    const row = recipients?.find((r) => r.partyId === partyId);
    return (
      row?.emails.some(
        (e) => e.key !== except && e.address.toLowerCase() === address.toLowerCase(),
      ) ?? false
    );
  }

  function editAddress(partyId: string, k: string, next: string): void {
    if (isDuplicate(partyId, next, k)) {
      toast.error(`${next} is already on this ${noun.one}.`);
      return;
    }
    patchAddress(partyId, k, { address: next, checking: true, valid: false, reason: null });
    void check(partyId, k, next);
  }

  function addAddress(partyId: string, address: string): void {
    if (isDuplicate(partyId, address)) {
      toast.error(`${address} is already on this ${noun.one}.`);
      return;
    }
    const k = key();
    setRecipients((current) =>
      current === null
        ? current
        : current.map((r) =>
            r.partyId !== partyId
              ? r
              : {
                  ...r,
                  emails: [
                    ...r.emails,
                    { key: k, address, picName: null, valid: false, reason: null, checking: true },
                  ],
                },
          ),
    );
    void check(partyId, k, address);
  }

  function removeAllInvalid(): void {
    setRecipients((current) =>
      current === null
        ? current
        : current.map((r) => ({ ...r, emails: r.emails.filter((e) => e.checking || e.valid) })),
    );
    toast.success('Invalid addresses removed');
  }

  // ------------------------------------------------------------- summary
  const sendable = (recipients ?? [])
    .map((r) => ({ ...r, good: r.emails.filter((e) => !e.checking && e.valid) }))
    .filter((r) => r.good.length > 0);
  const addressCount = sendable.reduce((sum, r) => sum + r.good.length, 0);
  const invalidCount = (recipients ?? []).flatMap((r) => r.emails).filter((e) => !e.checking && !e.valid).length;
  const skipped = (recipients?.length ?? 0) - sendable.length;
  const checking = (recipients ?? []).some((r) => r.emails.some((e) => e.checking));
  const replyTo = context?.priceTeamEmails ?? [];
  const sendLabel = `Send to ${sendable.length} ${sendable.length === 1 ? noun.one : noun.many}`;

  const blockers: ReactNode[] = [];
  if (context !== null && replyTo.length === 0) {
    blockers.push(
      <>
        Add the Price team address in{' '}
        <Link href="/setting/notification" className="text-harbour hover:underline">
          Settings → Notifications
        </Link>{' '}
        — {noun.one} replies go there.
      </>,
    );
  }
  if (recipients !== null && sendable.length === 0) {
    blockers.push(`No ${noun.one} has a valid address yet.`);
  }
  if (checking) blockers.push('Still checking addresses…');
  if (rates === null) blockers.push('Pick a POL and a POD to load the rates.');
  else if (chosen.length === 0) blockers.push('Tick at least one rate to send.');
  if (subject.trim() === '') blockers.push('Write a subject.');
  if (message.trim() === '') blockers.push('Write the message.');

  const preview = sendable[0] ?? null;

  async function send(): Promise<void> {
    setSending(true);
    try {
      const result = await authorizedRequest<PriceEmailSendResultDto>(`${base}/send`, {
        method: 'POST',
        body: {
          subject,
          message,
          // Which rates, not their figures: the server reads the prices
          // back from the Price List and builds the table itself.
          mode,
          rateIds: chosen.map((r) => r.id),
          includeLocalCharges: includeLocal,
          recipients: sendable.map((r) => ({
            partyId: r.partyId,
            emails: r.good.map((e) => e.address),
          })),
        },
      });
      setConfirming(false);
      setSent(result.queued);
      toast.success(`${result.queued} emails queued`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not send those emails.');
    } finally {
      setSending(false);
    }
  }

  // --------------------------------------------------------------- render
  const header = (
    <ChildScreenHeader
      parentLabel={noun.label}
      parentName="Email prices"
      title={`To the ${noun.many} on your list — ${described ?? `all active ${noun.many}`}.`}
      backHref={listHref}
    />
  );

  if (!can(PERMISSION[party])) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          title="Emailing prices is not part of your role"
          description={`Ask an administrator for the ${noun.label} → Email prices permission.`}
        />
      </div>
    );
  }

  if (sent !== null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <section className="rounded-manifest border border-line bg-surface p-6 shadow-manifest">
          <p className="label-manifest text-verified">Queued</p>
          <h2 className="mt-1 text-page-title text-hull">
            <span className="font-mono tabular-nums">{sent}</span> emails are on their way
          </h2>
          <p className="mt-1 text-body text-steel">
            Each {noun.one} gets their own email over the next few minutes. Replies go to{' '}
            {replyTo.join(', ')}.
          </p>
          <Button asChild className="mt-4">
            <Link href={listHref}>Back to {noun.many}</Link>
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {header}

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* ------------------------------------------------ 1. recipients */}
          <Step
            n={1}
            title="Recipients"
            hint="Green addresses get the email. Click an address to correct it, × to remove it. Red ones are never sent to."
          >
            {recipients === null ? (
              <p className="text-body text-steel">Checking every address…</p>
            ) : recipients.length === 0 ? (
              <p className="text-body text-steel">
                No active {noun.many} match those filters.{' '}
                <Link href={listHref} className="text-harbour hover:underline">
                  Change them on the {noun.list}.
                </Link>
              </p>
            ) : (
              <RecipientsPanel
                party={party}
                recipients={recipients}
                onEdit={editAddress}
                onRemove={(partyId, k) => patchAddress(partyId, k, null)}
                onAdd={addAddress}
                onRemoveAllInvalid={removeAllInvalid}
              />
            )}
          </Step>

          {/* ----------------------------------------------------- 2. rates */}
          <Step
            n={2}
            title="Rates"
            hint="One POL to several PODs, or several POLs to one POD. The rates shown are the ones published and valid today."
          >
            {context !== null && context.modes.length === 0 ? (
              <p className="text-body text-steel">
                You cannot see any price list, so there are no rates to send. Ask an administrator
                for Price List access.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {mode !== null && context !== null && context.modes.length > 1 && (
                  <Segmented
                    label="Freight mode"
                    value={mode}
                    options={context.modes.map((m) => [m, RATE_MODE_LABEL[m]] as const)}
                    onChange={setMode}
                  />
                )}
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <span className="label-manifest">POL</span>
                    <MultiSelect
                      id="price-email-pol"
                      options={options.pols}
                      value={polIds}
                      onChange={(next) => {
                        setPolIds(next);
                        // Several origins means one destination — keep the first picked.
                        if (next.length > 1 && podIds.length > 1) setPodIds(podIds.slice(0, 1));
                      }}
                      placeholder="Choose origins"
                      searchPlaceholder="Filter ports"
                    />
                    {polIds.length > 1 && (
                      <span className="text-cell text-steel">One POD at a time with several POLs.</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="label-manifest">POD</span>
                    <MultiSelect
                      id="price-email-pod"
                      options={options.pods}
                      value={podIds}
                      onChange={(next) => {
                        setPodIds(next);
                        if (next.length > 1 && polIds.length > 1) setPolIds(polIds.slice(0, 1));
                      }}
                      placeholder="Choose destinations"
                      searchPlaceholder="Filter ports"
                    />
                    {podIds.length > 1 && (
                      <span className="text-cell text-steel">One POL at a time with several PODs.</span>
                    )}
                  </div>
                  <Field id="price-email-carrier" label="Carrier">
                    <Select
                      id="price-email-carrier"
                      value={carrierId}
                      onChange={(event) => setCarrierId(event.target.value)}
                    >
                      <option value="">All carriers</option>
                      {options.carriers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <label className="inline-flex items-center gap-2 text-body text-hull">
                  <input
                    type="checkbox"
                    checked={includeLocal}
                    onChange={(event) => setIncludeLocal(event.target.checked)}
                    className="size-4 accent-harbour"
                  />
                  Include origin and destination charges
                </label>

                <RatesStatus
                  loading={ratesLoading}
                  lanesPicked={polIds.length > 0 && podIds.length > 0}
                  count={rates?.length ?? null}
                  ticked={chosen.length}
                  truncated={truncated}
                />

                {rates !== null && rates.length > 0 && (
                  <RatesTable rates={rates} picked={picked} onChange={setPicked} />
                )}
              </div>
            )}
          </Step>

          {/* --------------------------------------------------- 3. message */}
          <Step
            n={3}
            title="Message"
            hint={`One letter, opening “Dear Sir/Madam,” and ending with the email signature from Settings → Notifications. Every ${noun.one} gets their own copy, sent to their own addresses only.`}
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <Field id="price-email-subject" label="Subject" required>
                  <Input
                    id="price-email-subject"
                    value={subject}
                    onChange={(event) => {
                      setSubject(event.target.value);
                      setSubjectEdited(true);
                    }}
                  />
                </Field>
                <Field id="price-email-message" label="Message" required>
                  <textarea
                    id="price-email-message"
                    rows={6}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    className={TEXTAREA}
                  />
                </Field>
              </div>

              <Preview
                recipientName={preview?.partyName ?? `${noun.label} name`}
                to={preview?.good.map((e) => e.address) ?? []}
                replyTo={replyTo}
                subject={subject}
                html={priceEmailHtml({
                  message,
                  rates: chosen,
                  includeLocalCharges: includeLocal,
                  signOff: context?.signOff ?? '',
                })}
              />
            </div>
          </Step>
        </div>

        {/* -------------------------------------------------------- summary */}
        <aside className="flex flex-col gap-3 rounded-manifest border border-line bg-surface p-4 shadow-manifest xl:sticky xl:top-4">
          <h2 className="text-section text-hull">Ready to send</h2>
          <dl className="flex flex-col gap-2 text-body">
            <SummaryLine label={`${noun.label}s`} value={sendable.length} note="each gets their own email" />
            <SummaryLine label="Addresses" value={addressCount} />
            {invalidCount > 0 && (
              <SummaryLine label="Invalid" value={invalidCount} note="not sent to" tone="alert" />
            )}
            {skipped > 0 && (
              <SummaryLine label="Skipped" value={skipped} note="no valid address" tone="signal" />
            )}
            <SummaryLine label="Rates" value={chosen.length} note="ticked in the table" />
          </dl>
          <div className="border-t border-line pt-3">
            <p className="label-manifest">Replies go to</p>
            <p className="text-body text-hull">
              {replyTo.length === 0 ? <span className="text-alert">Not set</span> : replyTo.join(', ')}
            </p>
          </div>

          {blockers.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2">
              {blockers.map((blocker, index) => (
                <li key={index} className="text-cell text-hull">
                  {blocker}
                </li>
              ))}
            </ul>
          )}

          <Button disabled={blockers.length > 0 || sending} onClick={() => setConfirming(true)}>
            {sendLabel}
          </Button>
        </aside>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={`Send ${sendable.length} email${sendable.length === 1 ? '' : 's'}?`}
        message={`Each ${noun.one} gets their own email, with only their own addresses on it. Replies go to ${replyTo.join(', ')}. This cannot be taken back once it leaves.`}
        confirmLabel={sendLabel}
        isPending={sending}
        onConfirm={() => void send()}
      />
    </div>
  );
}

/** A numbered step: the stencilled number, a title, and one line on how to use it. */
function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-manifest border border-line bg-surface shadow-manifest">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-manifest border border-harbour font-mono text-cell text-harbour">
          {n}
        </span>
        <div>
          <h2 className="text-section text-hull">{title}</h2>
          <p className="text-cell text-steel">{hint}</p>
        </div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function RatesStatus({
  loading,
  lanesPicked,
  count,
  ticked,
  truncated,
}: {
  loading: boolean;
  lanesPicked: boolean;
  count: number | null;
  ticked: number;
  truncated: boolean;
}) {
  if (!lanesPicked) return <p className="text-cell text-steel">Pick at least one POL and one POD.</p>;
  if (loading) return <p className="text-cell text-steel">Finding rates…</p>;
  if (count === null) return null;
  if (count === 0) {
    return (
      <p className="text-cell text-signal">
        No published rate covers that selection today. Try another carrier or lane.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-cell">
      <span className="text-verified">
        <span className="font-mono tabular-nums">{count}</span> rate{count === 1 ? '' : 's'} found
      </span>
      <span className="text-steel">
        <span className="font-mono tabular-nums">{ticked}</span> ticked to send — untick a row to
        leave it out.
      </span>
      {truncated && (
        <span className="text-signal">
          Showing the first {PRICE_EMAIL_MAX_RATES} — pick fewer ports to send them all.
        </span>
      )}
    </div>
  );
}

function SummaryLine({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note?: string;
  tone?: 'alert' | 'signal';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-steel">
        {label}
        {note !== undefined && <span className="block text-cell">{note}</span>}
      </dt>
      <dd
        className={cn(
          'font-mono text-section tabular-nums',
          tone === 'alert' ? 'text-alert' : tone === 'signal' ? 'text-signal' : 'text-hull',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The letter as the first recipient will read it — the very HTML the server
 * sends, built by the same shared function.
 *
 * In a sandboxed frame: the email's inline styles stay out of the page's, the
 * page's stay out of the email's, and nothing in the frame can run.
 */
function Preview({
  recipientName,
  to,
  replyTo,
  subject,
  html,
}: {
  recipientName: string;
  to: string[];
  replyTo: string[];
  subject: string;
  html: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-manifest border border-line bg-paper">
      <p className="label-manifest border-b border-line px-3 py-2">Preview — {recipientName}’s copy</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-2 text-cell">
        <dt className="text-steel">To</dt>
        <dd className="break-all text-hull">{to.length === 0 ? '—' : to.join(', ')}</dd>
        <dt className="text-steel">Reply-To</dt>
        <dd className="break-all text-hull">{replyTo.length === 0 ? '—' : replyTo.join(', ')}</dd>
        <dt className="text-steel">Subject</dt>
        <dd className="text-hull">{subject === '' ? '—' : subject}</dd>
      </dl>
      <iframe
        title={`Email preview for ${recipientName}`}
        sandbox=""
        srcDoc={`<!doctype html><html><body style="margin:12px;background:#fff">${html}</body></html>`}
        className="h-140 w-full bg-surface"
      />
    </div>
  );
}
