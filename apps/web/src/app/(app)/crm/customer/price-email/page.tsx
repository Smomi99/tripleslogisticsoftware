'use client';

import {
  BUSINESS_AREA_LABEL,
  type BusinessArea,
  CUSTOMER_TYPE_LABEL,
  type CustomerType,
  DEFAULT_PRICE_EMAIL_MESSAGE,
  defaultPriceEmailSubject,
  type EmailCheckDto,
  type FreightRateDto,
  type LookupOption,
  PRICE_EMAIL_MAX_RATES,
  type PriceEmailContextDto,
  type PriceEmailOptionsDto,
  type PriceEmailRatesDto,
  type PriceEmailRecipientsDto,
  type PriceEmailSendResultDto,
  priceEmailHtml,
  RATE_MODE_LABEL,
  type RateMode,
} from '@ff/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
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
 * CRM → Customer → Email prices (2026-09-29).
 *
 * Three steps down the page — who, which rates, what it says — and a summary
 * beside them that holds the one Send button and says plainly what is still
 * in the way. Each customer gets their own letter; replies go to the Price
 * team; only selling prices ever reach the text.
 */

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour';

/** "Chattogram (BDCGP)" → "Chattogram", for a subject line that reads like one. */
const bareName = (name: string): string => name.replace(/\s*\([^)]*\)$/, '');

/** React keys for address chips — only ever compared, never shown. */
let keySeq = 0;
const key = (): string => `a${(keySeq += 1)}`;

function PriceEmailScreen() {
  const params = useSearchParams();
  const { authorizedRequest, can } = useSession();

  // The Customer list's filters, exactly as the button carried them.
  const filters = useMemo(() => {
    const pick = (key: string) => {
      const value = params.get(key);
      return value === null || value === '' ? undefined : value;
    };
    return {
      search: pick('search'),
      customerType: pick('customerType') as CustomerType | undefined,
      businessArea: pick('businessArea') as BusinessArea | undefined,
      industrySectorId: pick('industrySectorId'),
    };
  }, [params]);

  const [context, setContext] = useState<PriceEmailContextDto | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sectorName, setSectorName] = useState<string | null>(null);

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
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(name, value);
    }
    void (async () => {
      try {
        const [ctx, found] = await Promise.all([
          authorizedRequest<PriceEmailContextDto>('/api/tenant/crm/customer-price-email/context'),
          authorizedRequest<PriceEmailRecipientsDto>(
            `/api/tenant/crm/customer-price-email/recipients?${query.toString()}`,
          ),
        ]);
        if (cancelled) return;
        setContext(ctx);
        setMode(ctx.modes[0] ?? null);
        setRecipients(
          found.customers.map((c) => ({
            ...c,
            emails: c.emails.map((e) => ({ ...e, key: key(), checking: false })),
          })),
        );
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof ApiError ? error.message : 'Could not load the customers.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, filters]);

  // The commodity filter arrives as an id; the header names it.
  useEffect(() => {
    if (filters.industrySectorId === undefined) return;
    void authorizedRequest<LookupOption[]>('/api/tenant/crm/customers/sectors')
      .then((sectors) =>
        setSectorName(sectors.find((s) => s.id === filters.industrySectorId)?.name ?? null),
      )
      .catch(() => setSectorName(null));
  }, [authorizedRequest, filters.industrySectorId]);

  // A new mode means new ports: the old picks would not exist in it.
  useEffect(() => {
    if (mode === null) return;
    let cancelled = false;
    setPolIds([]);
    setPodIds([]);
    setCarrierId('');
    setRates(null);
    void authorizedRequest<PriceEmailOptionsDto>(
      `/api/tenant/crm/customer-price-email/options?mode=${mode}`,
    )
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
  }, [authorizedRequest, mode]);

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
      void authorizedRequest<PriceEmailRatesDto>(
        `/api/tenant/crm/customer-price-email/rates?${query.toString()}`,
      )
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
  }, [authorizedRequest, carrierId, mode, podIds, polIds]);

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
  function patchAddress(customerId: string, k: string, patch: Partial<AddressRow> | null): void {
    setRecipients((current) =>
      current === null
        ? current
        : current.map((r) =>
            r.customerId !== customerId
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
  async function check(customerId: string, k: string, address: string): Promise<void> {
    try {
      const [result] = await authorizedRequest<EmailCheckDto[]>(
        '/api/tenant/crm/customer-price-email/check',
        { method: 'POST', body: { addresses: [address] } },
      );
      patchAddress(customerId, k, {
        address: result?.address ?? address,
        valid: result?.valid ?? false,
        reason: result?.reason ?? 'Could not be checked.',
        checking: false,
      });
    } catch {
      patchAddress(customerId, k, {
        valid: false,
        reason: 'Could not be checked — try editing it again.',
        checking: false,
      });
    }
  }

  function isDuplicate(customerId: string, address: string, except?: string): boolean {
    const row = recipients?.find((r) => r.customerId === customerId);
    return (
      row?.emails.some(
        (e) => e.key !== except && e.address.toLowerCase() === address.toLowerCase(),
      ) ?? false
    );
  }

  function editAddress(customerId: string, k: string, next: string): void {
    if (isDuplicate(customerId, next, k)) {
      toast.error(`${next} is already on this customer.`);
      return;
    }
    patchAddress(customerId, k, { address: next, checking: true, valid: false, reason: null });
    void check(customerId, k, next);
  }

  function addAddress(customerId: string, address: string): void {
    if (isDuplicate(customerId, address)) {
      toast.error(`${address} is already on this customer.`);
      return;
    }
    const k = key();
    setRecipients((current) =>
      current === null
        ? current
        : current.map((r) =>
            r.customerId !== customerId
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
    void check(customerId, k, address);
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

  const blockers: ReactNode[] = [];
  if (context !== null && replyTo.length === 0) {
    blockers.push(
      <>
        Add the Price team address in{' '}
        <Link href="/setting/notification" className="text-harbour hover:underline">
          Settings → Notifications
        </Link>{' '}
        — customer replies go there.
      </>,
    );
  }
  if (recipients !== null && sendable.length === 0) blockers.push('No customer has a valid address yet.');
  if (checking) blockers.push('Still checking addresses…');
  if (rates === null) blockers.push('Pick a POL and a POD to load the rates.');
  else if (chosen.length === 0) blockers.push('Tick at least one rate to send.');
  if (subject.trim() === '') blockers.push('Write a subject.');
  if (message.trim() === '') blockers.push('Write the message.');

  const preview = sendable[0] ?? null;

  async function send(): Promise<void> {
    setSending(true);
    try {
      const result = await authorizedRequest<PriceEmailSendResultDto>(
        '/api/tenant/crm/customer-price-email/send',
        {
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
              customerId: r.customerId,
              emails: r.good.map((e) => e.address),
            })),
          },
        },
      );
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
  const described =
    [
      filters.search === undefined ? null : `“${filters.search}”`,
      filters.customerType === undefined ? null : CUSTOMER_TYPE_LABEL[filters.customerType],
      filters.businessArea === undefined ? null : BUSINESS_AREA_LABEL[filters.businessArea],
      filters.industrySectorId === undefined ? null : (sectorName ?? 'one commodity'),
    ]
      .filter((part): part is string => part !== null)
      .join(' · ') || 'all active customers';

  const header = (
    <ChildScreenHeader
      parentLabel="Customer"
      parentName="Email prices"
      title={`To the customers on your list — ${described}.`}
      backHref="/crm/customer"
    />
  );

  if (!can('CRM.CUSTOMER.PRICE_EMAIL')) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          title="Emailing prices is not part of your role"
          description="Ask an administrator for the Customer → Email prices permission."
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
            Each customer gets their own email over the next few minutes. Replies go to{' '}
            {replyTo.join(', ')}.
          </p>
          <Button asChild className="mt-4">
            <Link href="/crm/customer">Back to customers</Link>
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
                No active customers match those filters.{' '}
                <Link href="/crm/customer" className="text-harbour hover:underline">
                  Change them on the Customer list.
                </Link>
              </p>
            ) : (
              <RecipientsPanel
                recipients={recipients}
                onEdit={editAddress}
                onRemove={(customerId, k) => patchAddress(customerId, k, null)}
                onAdd={addAddress}
                onRemoveAllInvalid={removeAllInvalid}
              />
            )}
          </Step>

          {/* ----------------------------------------------------- 2. rates */}
          <Step
            n={2}
            title="Rates"
            hint="One POL to several PODs, or several POLs to one POD. Only lanes with a published rate today are offered."
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
            hint="The same letter goes to everyone, opening with their own company name. Edit anything."
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
                customerName={preview?.customerName ?? 'Customer name'}
                to={preview?.good.map((e) => e.address) ?? []}
                replyTo={replyTo}
                subject={subject}
                html={priceEmailHtml({
                  customerName: preview?.customerName ?? 'Customer name',
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
            <SummaryLine label="Customers" value={sendable.length} note="each gets their own email" />
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
            Send to {sendable.length} customer{sendable.length === 1 ? '' : 's'}
          </Button>
        </aside>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={`Send ${sendable.length} email${sendable.length === 1 ? '' : 's'}?`}
        message={`Each customer gets their own email, with only their own addresses on it. Replies go to ${replyTo.join(', ')}. This cannot be taken back once it leaves.`}
        confirmLabel={`Send to ${sendable.length} customer${sendable.length === 1 ? '' : 's'}`}
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
 * The letter as the first customer will read it — the very HTML the server
 * sends, built by the same shared function.
 *
 * In a sandboxed frame: the email's inline styles stay out of the page's, the
 * page's stay out of the email's, and nothing in the frame can run.
 */
function Preview({
  customerName,
  to,
  replyTo,
  subject,
  html,
}: {
  customerName: string;
  to: string[];
  replyTo: string[];
  subject: string;
  html: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-manifest border border-line bg-paper">
      <p className="label-manifest border-b border-line px-3 py-2">Preview — {customerName}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-2 text-cell">
        <dt className="text-steel">To</dt>
        <dd className="break-all text-hull">{to.length === 0 ? '—' : to.join(', ')}</dd>
        <dt className="text-steel">Reply-To</dt>
        <dd className="break-all text-hull">{replyTo.length === 0 ? '—' : replyTo.join(', ')}</dd>
        <dt className="text-steel">Subject</dt>
        <dd className="text-hull">{subject === '' ? '—' : subject}</dd>
      </dl>
      <iframe
        title={`Email preview for ${customerName}`}
        sandbox=""
        srcDoc={`<!doctype html><html><body style="margin:12px;background:#fff">${html}</body></html>`}
        className="h-140 w-full bg-surface"
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <PriceEmailScreen />
    </Suspense>
  );
}
