'use client';

import {
  type DebitInvoiceDto,
  type DebitInvoiceOptionsDto,
  type DebitInvoicePrefillDto,
  type DebitInvoiceSaveInput,
  DEBIT_INVOICE_DISPLAY_STATUS_LABEL,
  debitInvoiceSaveSchema,
  PAYMENT_STATUS_LABEL,
  SHIPMENT_STATUS_LABEL,
  SUPPLIER_PAYMENT_STATUS_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import {
  type BlockDraft,
  blankLine,
  CostBlocksEditor,
  costTotals,
  type LineDraft,
  LineGrid,
  lineBody,
  lineFrom,
  nextKey,
  withEveryType,
} from './cost-blocks';
import { DISPLAY_STATUS_TONE, fmt, money, previewLine } from './format';

/**
 * The invoice `Make invoice` opens — the lower half of the client's
 * `Awaiting Debit Note` sheet (rows 14–64), and `Create New` on Debit Invoice.
 *
 * Laid out as the sheet is: the booking at the top, Cost Details (Buying from
 * Carrier, Agent, Vendor), then Selling Price, then Gross profit and GP %, the
 * customer's email, and the four buttons along the foot. docs/MODULE_ACCOUNTS
 * §2.2 is the transcription; §3.7 decides what may change after it is sent.
 *
 * The figures shown while typing are a preview. On save the server recomputes
 * every one of them — the line amounts are GENERATED columns — and the form is
 * rebuilt from what it stored, so the screen ends every save agreeing with the
 * record.
 */

const INVOICE = 'ACCOUNTS.DEBIT_INVOICE';

export type DebitInvoiceFormMode =
  | { kind: 'freight'; shipmentId: string; prefill: DebitInvoicePrefillDto }
  | { kind: 'other' }
  | { kind: 'edit'; invoice: DebitInvoiceDto };

function initialState(mode: DebitInvoiceFormMode, options: DebitInvoiceOptionsDto) {
  const today = new Date().toISOString().slice(0, 10);
  if (mode.kind === 'freight') {
    const p = mode.prefill;
    return {
      invoiceDate: p.invoiceDate,
      customerId: p.customerId,
      currencyId: p.currencyId,
      conversionRate: p.conversionRate,
      lines: p.lines.map(lineFrom),
      blocks:
        p.costs === null
          ? []
          : withEveryType(
              p.costs.map((c) => ({
                key: nextKey(),
                id: null,
                partyType: c.partyType,
                partyId: c.partyId ?? '',
                supplierInvoiceNo: c.supplierInvoiceNo ?? '',
                currencyId: c.currencyId,
                conversionRate: c.conversionRate,
                lines: c.lines.map(lineFrom),
                fileName: null,
              })),
              options,
            ),
      emails: p.recipientEmails.join(', '),
    };
  }
  if (mode.kind === 'other') {
    return {
      invoiceDate: today,
      customerId: '',
      currencyId: options.baseCurrencyId ?? '',
      conversionRate: '1',
      lines: [] as LineDraft[],
      blocks: options.canViewBuyPrice ? withEveryType([], options) : [],
      emails: '',
    };
  }
  const inv = mode.invoice;
  return {
    invoiceDate: inv.invoiceDate,
    customerId: inv.customerId,
    currencyId: inv.currencyId,
    conversionRate: inv.conversionRate,
    lines: inv.lines.map(lineFrom),
    blocks:
      inv.costs === null
        ? []
        : withEveryType(
            inv.costs.map((c) => ({
              key: nextKey(),
              id: c.id,
              partyType: c.partyType,
              partyId: c.partyId,
              supplierInvoiceNo: c.supplierInvoiceNo ?? '',
              currencyId: c.currencyId,
              conversionRate: c.conversionRate,
              lines: c.lines.map(lineFrom),
              fileName: c.supplierInvoiceFileName,
            })),
            options,
          ),
    emails: inv.recipientEmails.join(', '),
  };
}

export function DebitInvoiceForm({
  mode,
  options,
  onSaved,
}: {
  mode: DebitInvoiceFormMode;
  options: DebitInvoiceOptionsDto;
  /** Called with what the server stored, so the page can rebuild the form from it. */
  onSaved: (next: DebitInvoiceDto) => void;
}) {
  const { authorizedRequest, authorizedObjectUrl, authorizedUpload, authorizedDownload, can } = useSession();
  const router = useRouter();

  const invoice = mode.kind === 'edit' ? mode.invoice : null;
  const initial = useMemo(() => initialState(mode, options), [mode, options]);

  const [invoiceDate, setInvoiceDate] = useState(initial.invoiceDate);
  const [customerId, setCustomerId] = useState(initial.customerId);
  const [currencyId, setCurrencyId] = useState(initial.currencyId);
  const [conversionRate, setConversionRate] = useState(initial.conversionRate);
  const [lines, setLines] = useState<LineDraft[]>(initial.lines);
  const [blocks, setBlocks] = useState<BlockDraft[]>(initial.blocks);
  const [emails, setEmails] = useState(initial.emails);
  const [busy, setBusy] = useState<'save' | 'send' | 'cancel' | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const isNew = invoice === null;
  const canEdit = isNew
    ? mode.kind === 'freight'
      ? can('ACCOUNTS.AWAITING_FREIGHT_INV.CREATE')
      : can(`${INVOICE}.CREATE`)
    : can(`${INVOICE}.EDIT`);
  /** §3.7, as the server decided it — never re-derived here. */
  const sellEditable = canEdit && (invoice === null || invoice.sellEditable);
  const costEditable = canEdit && options.canViewBuyPrice && (invoice === null || invoice.costEditable);
  const showCosts = options.canViewBuyPrice && blocks.length > 0;

  const currency = (id: string) => options.currencies.find((c) => c.id === id);
  const baseCode = options.baseCurrencyCode ?? '';
  const sellCode = currency(currencyId)?.code ?? '';
  const isBase = (id: string) => id !== '' && id === options.baseCurrencyId;

  /** Changing a grid's currency takes today's rate for it — 1 for the base (§3.4). */
  function rateFor(id: string): string {
    if (isBase(id)) return '1';
    return currency(id)?.rate ?? '';
  }

  // ------------------------------------------------------------ the maths

  const sellTotals = useMemo(() => {
    let total = 0;
    let base = 0;
    for (const line of lines) {
      const p = previewLine(line.quantity, line.unitPrice, conversionRate);
      total += p.amount ?? 0;
      base += p.base ?? 0;
    }
    return { total, base };
  }, [lines, conversionRate]);

  const grandCost = useMemo(() => costTotals(blocks).grandBase, [blocks]);
  const grossProfit = sellTotals.base - grandCost;
  const gpPercent = sellTotals.base > 0 ? (grossProfit / sellTotals.base) * 100 : null;

  // ----------------------------------------------------------- the body

  function body(): DebitInvoiceSaveInput {
    // A price-list row is a quotation's word for its own source; on the invoice it was typed.
    const toLine = (l: LineDraft) => lineBody(l, l.source === 'AUTO' ? 'MANUAL' : l.source);
    return {
      invoiceDate,
      customerId: mode.kind === 'other' ? customerId : null,
      shipmentId: null,
      currencyId,
      conversionRate: conversionRate.trim(),
      lines: lines.filter((l) => !blankLine(l)).map(toLine),
      ...(options.canViewBuyPrice && blocks.length > 0
        ? {
            costs: blocks.map((b) => ({
              id: b.id,
              partyType: b.partyType,
              partyId: b.partyId === '' ? null : b.partyId,
              supplierInvoiceNo: b.supplierInvoiceNo.trim() === '' ? null : b.supplierInvoiceNo.trim(),
              currencyId: b.currencyId,
              conversionRate: b.conversionRate.trim(),
              lines: b.lines.filter((l) => !blankLine(l)).map(toLine),
            })),
          }
        : {}),
      recipientEmails: emails
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== ''),
    };
  }

  /** The shared Zod schema, before the round trip — the server checks it again. */
  function validate(payload: DebitInvoiceSaveInput): boolean {
    const parsed = debitInvoiceSaveSchema.safeParse(payload);
    if (parsed.success) return true;
    const issue = parsed.error.issues[0];
    toast.error(issue?.message ?? 'Check the invoice and try again.');
    return false;
  }

  /** Saves, and returns what the server stored. */
  async function save(): Promise<DebitInvoiceDto | null> {
    const payload = body();
    if (!validate(payload)) return null;
    try {
      if (mode.kind === 'freight') {
        return await authorizedRequest<DebitInvoiceDto>(
          `/api/tenant/accounts/shipments/${mode.shipmentId}/debit-invoice`,
          { method: 'POST', body: payload },
        );
      }
      if (mode.kind === 'other') {
        return await authorizedRequest<DebitInvoiceDto>('/api/tenant/accounts/debit-invoices', {
          method: 'POST',
          body: payload,
        });
      }
      // §3.7: once money is received only the cost side moves.
      if (!mode.invoice.sellEditable) {
        return await authorizedRequest<DebitInvoiceDto>(
          `/api/tenant/accounts/debit-invoices/${mode.invoice.id}/costs`,
          { method: 'PUT', body: { costs: payload.costs ?? [] } },
        );
      }
      return await authorizedRequest<DebitInvoiceDto>(
        `/api/tenant/accounts/debit-invoices/${mode.invoice.id}`,
        { method: 'PATCH', body: payload },
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save the invoice.');
      return null;
    }
  }

  function landOn(saved: DebitInvoiceDto): void {
    if (isNew) router.replace(`/accounts/debit-invoice/${saved.id}` as Route);
    else onSaved(saved);
  }

  async function onDraft(): Promise<void> {
    setBusy('save');
    const saved = await save();
    setBusy(null);
    if (saved === null) return;
    toast.success(isNew ? `Saved as ${saved.code}` : 'Saved');
    landOn(saved);
  }

  async function onSend(): Promise<void> {
    const to = emails
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '');
    if (to.length === 0) {
      toast.error('Add at least one address to send it to.');
      return;
    }
    setBusy('send');
    const saved = canEdit && (sellEditable || costEditable) ? await save() : invoice;
    if (saved === null) {
      setBusy(null);
      return;
    }
    try {
      const sent = await authorizedRequest<DebitInvoiceDto>(
        `/api/tenant/accounts/debit-invoices/${saved.id}/send`,
        { method: 'POST', body: { to } },
      );
      toast.success(`${sent.code} sent`);
      landOn(sent);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not send the invoice.');
      // Saved but not sent: stay on what was stored rather than the stale form.
      if (isNew) router.replace(`/accounts/debit-invoice/${saved.id}` as Route);
    } finally {
      setBusy(null);
    }
  }

  async function onPrint(): Promise<void> {
    if (invoice === null) return;
    try {
      const url = await authorizedObjectUrl(`/api/tenant/accounts/debit-invoices/${invoice.id}/pdf`);
      window.open(url, '_blank', 'noopener');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not open the invoice.');
    }
  }

  async function onCancelInvoice(): Promise<void> {
    if (invoice === null) return;
    setBusy('cancel');
    try {
      const done = await authorizedRequest<DebitInvoiceDto>(
        `/api/tenant/accounts/debit-invoices/${invoice.id}/cancel`,
        { method: 'POST', body: { reason: cancelReason } },
      );
      toast.success(`${done.code} cancelled`);
      setCancelOpen(false);
      onSaved(done);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not cancel the invoice.');
    } finally {
      setBusy(null);
    }
  }

  async function uploadFor(block: BlockDraft, file: File): Promise<void> {
    if (invoice === null || block.id === null) return;
    try {
      const result = await authorizedUpload<{ fileName: string }>(
        `/api/tenant/accounts/debit-invoices/${invoice.id}/costs/${block.id}/file`,
        file,
      );
      setBlocks((current) =>
        current.map((b) => (b.key === block.key ? { ...b, fileName: result.fileName } : b)),
      );
      toast.success('Invoice uploaded');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not upload the file.');
    }
  }

  async function downloadFor(block: BlockDraft): Promise<void> {
    if (invoice === null || block.id === null) return;
    try {
      await authorizedDownload(
        `/api/tenant/accounts/debit-invoices/${invoice.id}/costs/${block.id}/file`,
        block.fileName ?? 'supplier-invoice',
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not download the file.');
    }
  }

  const booking = mode.kind === 'freight' ? mode.prefill.booking : (invoice?.booking ?? null);
  const customerName =
    mode.kind === 'freight' ? mode.prefill.customerName : (invoice?.customerName ?? null);

  // ------------------------------------------------------------ the page

  return (
    <div className="flex flex-col gap-5">
      {/* --------------------------------------------------- the booking */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-mono text-page-title tabular-nums text-hull">
              {invoice?.code ?? 'New debit invoice'}
            </h2>
            {invoice !== null && (
              <Status tone={DISPLAY_STATUS_TONE[invoice.displayStatus]}>
                {DEBIT_INVOICE_DISPLAY_STATUS_LABEL[invoice.displayStatus]}
              </Status>
            )}
            <span className="text-cell text-steel">
              {mode.kind === 'other' || invoice?.kind === 'OTHER' ? 'Other invoice' : 'Freight invoice'}
            </span>
          </div>
          <Link
            href={
              mode.kind === 'freight'
                ? { pathname: '/accounts/awaiting-freight-inv' }
                : { pathname: '/accounts/debit-invoice' }
            }
            className="text-cell text-harbour hover:underline"
          >
            ← Back to list
          </Link>
        </div>

        {mode.kind === 'freight' && mode.prefill.notes.length > 0 && (
          <ul className="mb-4 flex flex-col gap-1 rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2">
            {mode.prefill.notes.map((note) => (
              <li key={note} className="text-cell text-hull">
                {note}
              </li>
            ))}
          </ul>
        )}

        {invoice?.status === 'CANCELLED' && (
          <p className="mb-4 rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
            Cancelled {invoice.cancelledAt?.slice(0, 10)} — {invoice.cancelReason}
          </p>
        )}

        {booking !== null && (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['Inquiry No', booking.inquiryCode],
                ['Quotation No', booking.quotationCode],
                ['Quotation Date', booking.quotationDate],
                ['Booking No', booking.bookingCode],
                ['Customer', customerName],
                ['Commodity', booking.commodity],
                ['Shipment Type', booking.shipmentType === 'AIR' ? 'Air' : 'Sea'],
                ['Booking stage', SHIPMENT_STATUS_LABEL[booking.bookingStatus]],
                [booking.shipmentType === 'AIR' ? 'AOL' : 'POL', booking.polName],
                [booking.shipmentType === 'AIR' ? 'AOD' : 'POD', booking.podName],
                ['Required Container', booking.requiredContainer],
                [booking.shipmentType === 'AIR' ? 'Airlines' : 'Carrier', booking.carrierName],
              ] as [string, string | null][]
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="label-manifest">{label}</dt>
                <dd className="text-body text-hull">{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
          {mode.kind === 'other' && (
            <Field id="customerId" label="Customer" required>
              <Select
                id="customerId"
                value={customerId}
                disabled={!sellEditable}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Choose the customer to bill</option>
                {options.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {invoice?.kind === 'OTHER' && (
            <Field id="customerName" label="Customer">
              <Input id="customerName" value={invoice.customerName} readOnly />
            </Field>
          )}
          <Field id="invoiceDate" label="Invoice date" required>
            <Input
              id="invoiceDate"
              type="date"
              value={invoiceDate}
              disabled={!sellEditable}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </Field>
          <Field id="currencyId" label="Invoice currency" required hint="One currency per invoice, as on the quotation.">
            <Select
              id="currencyId"
              value={currencyId}
              disabled={!sellEditable}
              onChange={(e) => {
                setCurrencyId(e.target.value);
                setConversionRate(rateFor(e.target.value));
              }}
            >
              {options.currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.id === options.baseCurrencyId ? ' (base)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id="conversionRate"
            label={`Conversion rate (${baseCode || 'base'} per 1 ${sellCode || 'unit'})`}
            required
            hint="Frozen on the invoice. The receipt is booked at this rate."
          >
            <Input
              id="conversionRate"
              numeric
              inputMode="decimal"
              value={conversionRate}
              disabled={!sellEditable || isBase(currencyId)}
              onChange={(e) => setConversionRate(e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* ---------------------------------------------- Cost Details (B19) */}
      {showCosts && (
        <CostBlocksEditor
          blocks={blocks}
          onChange={setBlocks}
          options={options}
          editable={costEditable}
          invoiceNo
          description={
            mode.kind === 'freight'
              ? 'Pulled from the quotation’s cost details. What the carrier, agent and vendor charged — never printed on the customer’s invoice.'
              : 'What the carrier, agent and vendor charged. Never printed on the customer’s invoice.'
          }
          footer={(block) => (
            <>
              <span className="label-manifest">Upload invoice</span>
              {block.id === null ? (
                <span className="text-steel">Save the invoice first, then attach the supplier’s copy.</span>
              ) : (
                <>
                  {block.fileName !== null && (
                    <button
                      type="button"
                      className="text-harbour hover:underline"
                      onClick={() => void downloadFor(block)}
                    >
                      {block.fileName}
                    </button>
                  )}
                  {costEditable && (
                    <label className="cursor-pointer text-harbour hover:underline">
                      {block.fileName === null ? 'Choose file' : 'Replace'}
                      <input
                        type="file"
                        className="sr-only"
                        accept="application/pdf,image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file !== undefined) void uploadFor(block, file);
                        }}
                      />
                    </label>
                  )}
                </>
              )}
              <CreditInvoicePaid invoice={invoice} blockId={block.id} />
            </>
          )}
        />
      )}

      {/* ------------------------------------------------ Selling Price (B51) */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h3 className="text-section text-hull">Selling Price</h3>
            <p className="text-cell text-steel">
              {mode.kind === 'freight'
                ? 'Pulled from the quotation. Add or remove charges, or change a quantity, as the shipment turned out.'
                : 'What the customer is billed. This is what the invoice prints.'}
            </p>
          </div>
          {invoice !== null && !invoice.sellEditable && invoice.status !== 'CANCELLED' && (
            <p className="text-cell text-signal">
              Money has been received, so the bill is fixed. The cost side can still change.
            </p>
          )}
        </div>
        <LineGrid
          lines={lines}
          priceLabel="Selling price"
          currencyCode={sellCode}
          rate={conversionRate}
          baseCode={baseCode}
          editable={sellEditable}
          options={options}
          onChange={setLines}
        />
      </section>

      {/* ---------------------------------------------------- the totals */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="label-manifest">Total Sell price</dt>
            <dd className="font-mono text-page-title tabular-nums text-hull">
              {fmt(sellTotals.total)} <span className="text-body text-steel">{sellCode}</span>
            </dd>
            {!isBase(currencyId) && (
              <dd className="font-mono text-cell tabular-nums text-steel">
                {fmt(sellTotals.base)} {baseCode}
              </dd>
            )}
          </div>
          {options.canViewBuyPrice && (
            <>
              <div>
                <dt className="label-manifest">Grand total cost</dt>
                <dd className="font-mono text-page-title tabular-nums text-hull">
                  {fmt(grandCost)} <span className="text-body text-steel">{baseCode}</span>
                </dd>
              </div>
              <div>
                <dt className="label-manifest">Gross profit</dt>
                <dd
                  className={`font-mono text-page-title tabular-nums ${grossProfit < 0 ? 'text-alert' : 'text-hull'}`}
                >
                  {fmt(grossProfit)} <span className="text-body text-steel">{baseCode}</span>
                </dd>
              </div>
              <div>
                <dt className="label-manifest">GP %</dt>
                <dd className="font-mono text-page-title tabular-nums text-hull">
                  {gpPercent === null ? '—' : `${gpPercent.toFixed(2)}%`}
                </dd>
              </div>
            </>
          )}
        </dl>

        {invoice !== null && invoice.status === 'ISSUED' && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-body text-hull">
              <span className="label-manifest mr-2">Received</span>
              <span className="font-mono tabular-nums">{money(invoice.currencyCode, invoice.receivedAmount)}</span>
              <span className="label-manifest ml-6 mr-2">Outstanding</span>
              <span className="font-mono tabular-nums">{money(invoice.currencyCode, invoice.outstandingAmount)}</span>
              <span className="ml-6">
                <Status tone={invoice.paymentStatus === 'PAID' ? 'active' : 'pending'}>
                  {PAYMENT_STATUS_LABEL[invoice.paymentStatus]}
                </Status>
              </span>
            </p>
            {invoice.paymentStatus !== 'PAID' && can('ACCOUNTS.DEBIT_INVOICE.RECEIVE') && can('ACCOUNTS.INCOME.CREATE') && (
              <Link
                href={`/accounts/income/new?debitInvoice=${invoice.id}` as Route}
                className="mt-2 inline-block text-body text-harbour hover:underline"
              >
                Receive
              </Link>
            )}
            {invoice.receipts.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {invoice.receipts.map((r) => (
                  <li key={r.id} className="font-mono text-cell tabular-nums text-steel">
                    {r.paymentDate} · {money(invoice.currencyCode, r.amount)}
                    {r.journalEntryId !== null && (
                      <>
                        {' · '}
                        {can('ACCOUNTS.INCOME.VIEW') ? (
                          <Link href={`/accounts/income/${r.journalEntryId}` as Route} className="text-harbour hover:underline">
                            {r.journalEntryCode}
                          </Link>
                        ) : (
                          r.journalEntryCode
                        )}
                      </>
                    )}
                    {r.bankChargeBase !== null && ` · Bank charge ${money(baseCode, r.bankChargeBase)}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* --------------------------------------- Email id + the buttons */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <Field
          id="emails"
          label="Email id of Customer"
          hint="Prefilled from the customer’s contacts. Separate more with commas."
        >
          <Input
            id="emails"
            value={emails}
            disabled={invoice?.status === 'CANCELLED'}
            onChange={(e) => setEmails(e.target.value)}
          />
        </Field>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {canEdit && (sellEditable || costEditable) && (
            <Button variant="secondary" onClick={() => void onDraft()} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : invoice?.status === 'ISSUED' ? 'Save changes' : 'Save draft'}
            </Button>
          )}
          {can(`${INVOICE}.SEND`) && invoice?.status !== 'CANCELLED' && (
            <Button onClick={() => void onSend()} disabled={busy !== null}>
              {busy === 'send' ? 'Sending…' : invoice?.status === 'ISSUED' ? 'Save & send again' : 'Save & Send'}
            </Button>
          )}
          {invoice !== null && can(`${INVOICE}.EXPORT_PDF`) && (
            <Button variant="secondary" onClick={() => void onPrint()}>
              Print
            </Button>
          )}
          {invoice !== null && invoice.cancellable && can(`${INVOICE}.CANCEL`) && (
            <Button variant="destructive" onClick={() => setCancelOpen(true)} disabled={busy !== null}>
              Cancel invoice
            </Button>
          )}
          {invoice === null && (
            <Link
              href={
                mode.kind === 'freight'
                  ? { pathname: '/accounts/awaiting-freight-inv' }
                  : { pathname: '/accounts/debit-invoice' }
              }
              className="text-body text-steel hover:underline"
            >
              Discard
            </Link>
          )}
          {invoice?.sentAt != null && (
            <p className="text-cell text-steel">Last sent {invoice.sentAt.slice(0, 10)}.</p>
          )}
        </div>
      </section>

      <Modal
        open={cancelOpen}
        onOpenChange={(open) => {
          setCancelOpen(open);
          if (!open) setCancelReason('');
        }}
        title={`Cancel ${invoice?.code ?? 'this invoice'}?`}
        description={
          invoice?.kind === 'FREIGHT'
            ? 'The number is kept on the record, and the booking goes back on Awaiting Freight Inv to be invoiced again.'
            : 'The number is kept on the record.'
        }
      >
        <div className="flex flex-col gap-4">
          <Field id="cancelReason" label="Reason" required>
            <textarea
              id="cancelReason"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            />
          </Field>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null || cancelReason.trim() === ''}
              onClick={() => void onCancelInvoice()}
            >
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel invoice'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * What Expense vouchers have paid against a saved cost block — the Credit
 * Invoice's Payment Status (§14.2), with `Make Payment` beside it.
 */
function CreditInvoicePaid({ invoice, blockId }: { invoice: DebitInvoiceDto | null; blockId: string | null }) {
  const { can } = useSession();
  const cost = invoice?.costs?.find((c) => c.id === blockId);
  if (invoice === null || invoice.status !== 'ISSUED' || cost === undefined) return null;
  return (
    <p className="flex items-center gap-3 text-cell text-steel">
      <Status tone={cost.paymentStatus === 'PAID' ? 'active' : 'pending'}>
        {SUPPLIER_PAYMENT_STATUS_LABEL[cost.paymentStatus]}
      </Status>
      {cost.paymentStatus !== 'UNPAID' && (
        <span className="font-mono tabular-nums">
          {money(cost.currencyCode, cost.paidAmount)} paid
        </span>
      )}
      {cost.paymentStatus !== 'PAID' && can('ACCOUNTS.EXPENSE.CREATE') && (
        <Link
          href={`/accounts/expense/new?creditInvoice=${cost.id}` as Route}
          className="text-harbour hover:underline"
        >
          Make Payment
        </Link>
      )}
    </p>
  );
}
