'use client';

import {
  QUOTATION_STATUS_LABEL,
  type QuotationDto,
  type QuotationLineDto,
  type QuotationLineGroup,
  isoCurrency,
  quotationIsEditable,
  TRANSIT_TYPES,
  loadingTypeLabel,
} from '@ff/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * §6.5 — the Quotation screen.
 *
 * The client's own layout: a header block of the inquiry copied down, the
 * priced line grid, an Additional Charge section beneath it, and the total
 * pinned at the foot.
 *
 * Two things on this screen are load-bearing rather than decorative:
 *
 *   The total is never computed here. It is what Postgres stored — the browser
 *   showing a number the database disagrees with is how a customer ends up
 *   holding a different total to the one we recorded. The conversion below it
 *   is the deliberate exception: it is a view, it is never sent, and it reads
 *   the grid so it can answer while a price is still being typed.
 *
 *   An AUTO line and a MANUAL one are marked differently, because §6.5 asks for
 *   it and because the distinction matters: one is what the price list says,
 *   the other is a number somebody typed.
 */

export interface QuotationOptions {
  inquiries: { id: string; label: string }[];
  carriers: { id: string; label: string }[];
  vessels: { id: string; label: string }[];
  currencies: { id: string; label: string; conversion: string }[];
  /** The money this workspace thinks in — where the conversion view starts. */
  baseCurrencyId: string | null;
  baseCurrencyCode: string | null;
  costHeads: { id: string; label: string }[];
  containerSizes: { id: string; label: string }[];
  costUnits: { id: string; label: string }[];
  termsOfShipment: { id: string; label: string }[];
  modes: { id: string; label: string }[];
  canAddCharge: boolean;
  canTypePrice: boolean;
  canSend: boolean;
  canExportPdf: boolean;
}

/** A line as the grid edits it. Strings throughout — money is never a float. */
interface LineDraft {
  id?: string;
  lineGroup: QuotationLineGroup;
  costHeadId: string;
  containerSizeId: string;
  costUnitId: string;
  quantity: string;
  sellingPrice: string;
  currencyId: string;
  source: 'AUTO' | 'MANUAL';
  /** Kept so an untouched AUTO line keeps its provenance on save. */
  priceSourceRateLineId?: string | null;
  priceSourceLocalChargeId?: string | null;
}

function toDraft(line: QuotationLineDto): LineDraft {
  return {
    id: line.id,
    lineGroup: line.lineGroup,
    costHeadId: line.costHeadId,
    containerSizeId: line.containerSizeId ?? '',
    costUnitId: line.costUnitId ?? '',
    quantity: line.quantity,
    sellingPrice: line.sellingPrice,
    currencyId: line.currencyId,
    source: line.source,
  };
}

/** "1450.5" -> "1,450.50" (§12: a column of prices has to line up). */
function money(value: string | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** What the grid shows while a line is being edited, before the server re-adds. */
function preview(line: LineDraft): { total: string } {
  const qty = Number(line.quantity);
  const price = Number(line.sellingPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return { total: '—' };
  return { total: money(String(qty * price)) };
}

/** A line's own total, as a number, for the conversion below the grid. */
function lineTotal(line: LineDraft): number {
  return Number(line.quantity) * Number(line.sellingPrice);
}

export function QuotationForm({
  quotation,
  options,
  onSaved,
}: {
  quotation: QuotationDto;
  options: QuotationOptions;
  onSaved: (next: QuotationDto) => void;
}) {
  const { authorizedRequest, authorizedObjectUrl, can } = useSession();

  const editable = quotationIsEditable(quotation.status) && can('CUSTOMER_SERVICE.QUOTATION.EDIT');
  const [lines, setLines] = useState<LineDraft[]>(quotation.lines.map(toDraft));
  const [validityDate, setValidityDate] = useState(quotation.validityDate ?? '');
  const [transitType, setTransitType] = useState(quotation.transitType ?? '');
  const [firstVesselId, setFirstVesselId] = useState(quotation.firstVesselId ?? '');
  const [etd, setEtd] = useState(quotation.etd ?? '');
  const [eta, setEta] = useState(quotation.eta ?? '');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /*
    Which currency the total is being viewed in. Starts on the workspace base,
    so the figure in the user's own money is the one already on screen — that
    was the point of asking for it. '' is none.
  */
  const [checkIn, setCheckIn] = useState(options.baseCurrencyId ?? '');

  /*
   * The quotation seen in one currency, at today's rates.
   *
   * Summed line by line rather than from the stored total, because the charges
   * on one quotation need not share a currency — freight in USD and a local
   * charge in BDT is ordinary. Each line is carried to the target through the
   * workspace base, which is the unit every rate here is quoted in: a rate is
   * "how much base one of these is worth", so multiplying by the line's rate
   * and dividing by the target's is the whole conversion.
   *
   * It reads the grid rather than the saved rows, so it answers while a price
   * is being typed. Waiting for a save would make it useless for the one thing
   * it is for — deciding whether a price is right before committing to it.
   *
   * Today's rates deliberately. The question is "what is this worth to me
   * now", not "what did we freeze" — and this figure is never sent, so it
   * carries none of §2.2's obligations.
   */
  const checked = useMemo(() => {
    if (checkIn === '') return null;
    const target = options.currencies.find((c) => c.id === checkIn);
    if (target === undefined) return null;
    const toRate = Number(target.conversion);
    if (!(toRate > 0)) return null;

    let inBase = 0;
    for (const line of lines) {
      const amount = lineTotal(line);
      // A half-typed row is not an error — it is simply not part of the sum yet.
      if (!Number.isFinite(amount)) continue;
      const from = options.currencies.find((c) => c.id === line.currencyId);
      const rate = Number(from?.conversion ?? '0');
      // A line in a currency this workspace has no usable rate for cannot be
      // carried across. Saying so beats quietly dropping it from the sum.
      if (!(rate > 0)) {
        return { code: target.label, amount: null, blockedBy: from?.label ?? 'that currency' };
      }
      inBase += amount * rate;
    }

    return {
      code: target.label,
      blockedBy: null,
      amount: (inBase / toRate).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    };
  }, [checkIn, options.currencies, lines]);
  const [emails, setEmails] = useState(quotation.recipients.map((r) => r.email).join(', '));

  /** §6.6's document, opened in a tab. */
  async function openPdf(): Promise<void> {
    try {
      const url = await authorizedObjectUrl(`/api/tenant/cs/quotations/${quotation.id}/pdf`);
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not open the quotation.',
      );
    }
  }

  const standard = lines.filter((l) => l.lineGroup === 'STANDARD');
  const additional = lines.filter((l) => l.lineGroup === 'ADDITIONAL');

  function patchLine(target: LineDraft, patch: Partial<LineDraft>): void {
    setLines((current) => current.map((l) => (l === target ? { ...l, ...patch } : l)));
  }

  /*
   * What a new charge is priced in.
   *
   * It used to be `options.currencies[0]` — the head of a list sorted by name —
   * so on a quotation with no lines yet every hand-typed charge came out in AED,
   * because "AED — UAE Dirham" sorts first. Nobody chose that.
   *
   * The order that makes sense: follow the lines already on the grid, since a
   * Seal Charge belongs in the same money as the freight above it; then §5.4's
   * "Freight in USD"; then the quotation's own billing currency. The list's
   * first row is the last resort, not the first.
   */
  function defaultCurrencyId(current: LineDraft[]): string {
    const onGrid = current.find((l) => l.currencyId !== '')?.currencyId;
    if (onGrid !== undefined) return onGrid;
    const usd = options.currencies.find((c) => isoCurrency(c.label) === 'USD');
    if (usd !== undefined) return usd.id;
    const local = options.currencies.find((c) => c.id === quotation.localCurrencyId);
    return local?.id ?? options.currencies[0]?.id ?? '';
  }

  function addLine(group: QuotationLineGroup): void {
    setLines((current) => [
      ...current,
      {
        lineGroup: group,
        costHeadId: '',
        containerSizeId: '',
        costUnitId: '',
        quantity: '1',
        sellingPrice: '',
        currencyId: defaultCurrencyId(current),
        source: 'MANUAL',
      },
    ]);
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const next = await authorizedRequest<QuotationDto>(
        `/api/tenant/cs/quotations/${quotation.id}`,
        {
          method: 'PATCH',
          body: {
            validityDate: validityDate === '' ? null : validityDate,
            transitType: transitType === '' ? null : transitType,
            firstVesselId: firstVesselId === '' ? null : firstVesselId,
            etd: etd === '' ? null : etd,
            eta: eta === '' ? null : eta,
            lines: lines
              .filter((l) => l.costHeadId !== '' && l.sellingPrice !== '')
              .map((l) => ({
                ...(l.id === undefined ? {} : { id: l.id }),
                lineGroup: l.lineGroup,
                costHeadId: l.costHeadId,
                containerSizeId: l.containerSizeId === '' ? null : l.containerSizeId,
                costUnitId: l.costUnitId === '' ? null : l.costUnitId,
                quantity: l.quantity,
                sellingPrice: l.sellingPrice,
                currencyId: l.currencyId,
                source: l.source,
              })),
          },
        },
      );
      // A revision is a different row, so the caller has to follow it.
      toast.success(
        next.revisionNo > quotation.revisionNo
          ? `Saved as revision ${next.revisionNo}`
          : 'Quotation saved',
      );
      setLines(next.lines.map(toDraft));
      onSaved(next);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save the quotation.');
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    const list = emails
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '');
    if (list.length === 0) {
      toast.error('Add at least one address to send it to.');
      return;
    }
    setSending(true);
    try {
      const next = await authorizedRequest<QuotationDto>(
        `/api/tenant/cs/quotations/${quotation.id}/send`,
        { method: 'POST', body: { recipients: list.map((email) => ({ email, kind: 'TO' })) } },
      );
      toast.success('Quotation sent');
      onSaved(next);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not send the quotation.');
    } finally {
      setSending(false);
    }
  }

  const facts: [string, string | null][] = [
    ['Inquiry No', quotation.inquiryCode],
    ['Shipment Type', quotation.shipmentType],
    ['Customer', quotation.customerName],
    ['Type of Movement', quotation.movementType],
    ['POL', quotation.polName ?? quotation.polCode],
    ['POD', quotation.podName ?? quotation.podCode],
    ['Goods Type', quotation.goodsTypeName],
    ['Commodity', quotation.commodities.map((c) => c.commodityName).join(', ') || null],
    ['Place of Receipt', quotation.placeOfReceipt],
    ['HS Code', quotation.commodities.map((c) => c.hsCode).filter(Boolean).join(', ') || null],
    [
      'Loading Type',
      loadingTypeLabel(quotation.loadingType),
    ],
    ['TOS', quotation.tosName],
    ['Mode', quotation.modeName],
    // Local currency is no longer one of the quotation's own facts — it is
    // whatever the workspace books in, and the conversion view below says so
    // far more usefully than a code in a summary grid.
    ['Carrier', quotation.carrierName],
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* ------------------------------------------------- the header block */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h2 className="font-mono text-page-title tabular-nums text-hull">{quotation.code}</h2>
            {quotation.revisionNo > 1 && (
              <span className="text-cell text-steel">revision {quotation.revisionNo}</span>
            )}
            <Status
              tone={
                quotation.status === 'ACCEPTED'
                  ? 'active'
                  : quotation.status === 'REJECTED'
                    ? 'overdue'
                    : quotation.status === 'DRAFT' || quotation.status === 'SENT'
                      ? 'pending'
                      : 'inactive'
              }
            >
              {QUOTATION_STATUS_LABEL[quotation.status]}
            </Status>
          </div>
          <Link href={{ pathname: '/cs/quotation' }} className="text-cell text-harbour hover:underline">
            ← Back to list
          </Link>
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd className="text-body text-hull">{value ?? '—'}</dd>
            </div>
          ))}
        </dl>

        {/* The fields the quotation adds on top of the inquiry it copied. */}
        <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="quotationDate" label="Quotation Date">
            <Input id="quotationDate" value={quotation.quotationDate} readOnly />
          </Field>
          <Field id="validityDate" label="Validity Date">
            <Input
              id="validityDate"
              type="date"
              value={validityDate}
              disabled={!editable}
              onChange={(event) => setValidityDate(event.target.value)}
            />
          </Field>
          <Field id="firstVesselId" label="First Vessel">
            <Select
              id="firstVesselId"
              value={firstVesselId}
              disabled={!editable}
              onChange={(event) => setFirstVesselId(event.target.value)}
            >
              <option value="">—</option>
              {options.vessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="transitType" label="Transit Type">
            <Select
              id="transitType"
              value={transitType}
              disabled={!editable}
              onChange={(event) => setTransitType(event.target.value)}
            >
              <option value="">—</option>
              {TRANSIT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value.charAt(0) + value.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="etd" label="Departure (ETD)">
            <Input
              id="etd"
              type="date"
              value={etd}
              disabled={!editable}
              onChange={(event) => setEtd(event.target.value)}
            />
          </Field>
          <Field id="eta" label="Arrival (ETA)">
            <Input
              id="eta"
              type="date"
              value={eta}
              disabled={!editable}
              onChange={(event) => setEta(event.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* --------------------------------------------------- the line grids */}
      <LineGrid
        title="Charges"
        description="Pulled from the price list on POL, POD, goods type and carrier."
        lines={standard}
        options={options}
        editable={editable}
        onPatch={patchLine}
        onRemove={(line) => setLines((c) => c.filter((l) => l !== line))}
        onAdd={editable && options.canAddCharge ? () => addLine('STANDARD') : null}
      />

      <LineGrid
        title="Additional Charge"
        description="Anything the price list does not carry. Added by hand, and marked as such."
        lines={additional}
        options={options}
        editable={editable}
        onPatch={patchLine}
        onRemove={(line) => setLines((c) => c.filter((l) => l !== line))}
        onAdd={editable && options.canAddCharge ? () => addLine('ADDITIONAL') : null}
      />

      {/* ------------------------------------------------------- the totals */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <span className="label-manifest">Total ($)</span>
            <p className="font-mono text-page-title tabular-nums text-hull">
              {money(quotation.totalAmountUsd)}
            </p>
          </div>
        </div>
        {/*
          The conversion view — client request, 2026-09-11.

          It replaces the old "Bill Amount", which printed a second currency on
          the customer's page. A quotation now goes out in the money it was
          priced in and nothing else; this is the staff-side answer to "what is
          that in ours", starting on the workspace base.

          It is never sent and never printed. That is worth saying on the
          screen, because a second number beside a price is otherwise
          indistinguishable from the price.
        */}
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="label-manifest">Conversion currency</span>
              <Select
                aria-label="See this quotation converted into another currency"
                className="w-40"
                value={checkIn}
                onChange={(event) => setCheckIn(event.target.value)}
              >
                <option value="">—</option>
                {options.currencies
                  .filter((c) => Number(c.conversion) > 0)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.id === options.baseCurrencyId ? ' (base)' : ''}
                    </option>
                  ))}
              </Select>
            </div>
            {checked !== null && checked.amount !== null && (
              <p className="pb-1.5">
                <span className="font-mono text-page-title tabular-nums text-hull">
                  {checked.amount} {checked.code}
                </span>
              </p>
            )}
            {checked !== null && checked.amount === null && (
              <p className="pb-2 text-cell text-alert">
                No rate on file for {checked.blockedBy}, so this cannot be converted. Set one
                on Settings → Currency.
              </p>
            )}
          </div>
          <p className="mt-2 text-cell text-steel">
            For checking only, at today&apos;s rate. It is not printed on the quotation and
            not sent to the customer — they receive the totals above, in the currency each
            charge was priced in.
          </p>
        </div>

        {quotation.amountInWords !== null && (
          <p className="mt-3 border-t border-line pt-3 text-cell text-steel">
            <span className="label-manifest mr-2">In word</span>
            {quotation.amountInWords}
          </p>
        )}
        <p className="mt-2 text-cell text-steel">
          Totals are the figures the database computed, not a second sum taken here — the
          quotation and the record cannot disagree.
        </p>
      </section>

      {/* --------------------------------------------------- send / actions */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <Field
          id="emails"
          label="Insert Email ID"
          hint="Prefilled from the customer's contacts. Separate more with commas."
        >
          <Input
            id="emails"
            value={emails}
            disabled={quotation.status !== 'DRAFT'}
            onChange={(event) => setEmails(event.target.value)}
          />
        </Field>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {editable && (
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          )}
          {options.canSend && quotation.status === 'DRAFT' && (
            <Button variant="primary" onClick={() => void send()} disabled={sending}>
              {sending ? 'Sending…' : 'Save & Send'}
            </Button>
          )}
          {/*
            §6.6's document. Offered on a draft too — reading the page before it
            goes to a customer is the point of having one.
          */}
          {options.canExportPdf && (
            <Button variant="secondary" onClick={() => void openPdf()}>
              Print quotation
            </Button>
          )}
          {quotation.status === 'SENT' && (
            <p className="text-cell text-steel">
              Sent {quotation.sentAt?.slice(0, 10)}. Editing it now issues revision{' '}
              {quotation.revisionNo + 1} and keeps this one on the record.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function LineGrid({
  title,
  description,
  lines,
  options,
  editable,
  onPatch,
  onRemove,
  onAdd,
}: {
  title: string;
  description: string;
  lines: LineDraft[];
  options: QuotationOptions;
  editable: boolean;
  onPatch: (line: LineDraft, patch: Partial<LineDraft>) => void;
  onRemove: (line: LineDraft) => void;
  onAdd: (() => void) | null;
}) {
  return (
    <section className="rounded-manifest border border-line bg-surface shadow-manifest">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-section text-hull">{title}</h3>
          <p className="text-cell text-steel">{description}</p>
        </div>
        {onAdd !== null && (
          <Button variant="text" size="inline" onClick={onAdd}>
            + Add a charge
          </Button>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="px-4 py-6 text-cell text-steel">
          Nothing here yet.
          {onAdd === null
            ? ' The price list held no charges for this lane.'
            : ' Add a charge, or check the price list covers this lane.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-250 border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Cost Head</th>
                <th className="label-manifest px-3 py-2 text-left">Container Size</th>
                <th className="label-manifest px-3 py-2 text-left">Unit</th>
                <th className="label-manifest px-3 py-2 text-right">Qty</th>
                <th className="label-manifest px-3 py-2 text-right">Selling Price</th>
                <th className="label-manifest px-3 py-2 text-left">Currency</th>
                <th className="label-manifest px-3 py-2 text-right">Total Amount ($)</th>
                {editable && <th className="label-manifest px-3 py-2 text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const shown = preview(line);
                return (
                  <tr key={line.id ?? `new-${index}`} className="border-b border-line last:border-0">
                    <td className="px-3 py-1.5">
                      {editable ? (
                        <Select
                          value={line.costHeadId}
                          aria-label="Cost head"
                          onChange={(event) =>
                            onPatch(line, { costHeadId: event.target.value })
                          }
                          className="min-w-44"
                        >
                          <option value="">Choose</option>
                          {options.costHeads.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-cell text-hull">
                          {options.costHeads.find((h) => h.id === line.costHeadId)?.label ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable ? (
                        <Select
                          value={line.containerSizeId}
                          aria-label="Container size"
                          onChange={(event) =>
                            onPatch(line, { containerSizeId: event.target.value })
                          }
                          className="min-w-28"
                        >
                          {/* The client's own wording for a charge billed per
                              document rather than per box. */}
                          <option value="">No size</option>
                          {options.containerSizes.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-cell text-steel">
                          {options.containerSizes.find((s) => s.id === line.containerSizeId)
                            ?.label ?? 'No size'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-cell text-steel">
                      {options.costUnits.find((u) => u.id === line.costUnitId)?.label ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {editable ? (
                        <Input
                          value={line.quantity}
                          aria-label="Quantity"
                          inputMode="decimal"
                          onChange={(event) => onPatch(line, { quantity: event.target.value })}
                          className="w-20 text-right font-mono tabular-nums"
                        />
                      ) : (
                        <span className="font-mono text-cell tabular-nums">{line.quantity}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {editable && options.canTypePrice ? (
                        <Input
                          value={line.sellingPrice}
                          aria-label="Selling price"
                          inputMode="decimal"
                          onChange={(event) =>
                            // Changing a pulled price makes it a typed one, and
                            // §6.5 marks it from that moment on.
                            onPatch(line, {
                              sellingPrice: event.target.value,
                              source: 'MANUAL',
                            })
                          }
                          className="w-28 text-right font-mono tabular-nums"
                        />
                      ) : (
                        <span className="font-mono text-cell tabular-nums">
                          {money(line.sellingPrice, 2)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable ? (
                        <Select
                          value={line.currencyId}
                          aria-label="Currency"
                          onChange={(event) => onPatch(line, { currencyId: event.target.value })}
                          className="min-w-24"
                        >
                          {options.currencies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-cell text-steel">
                          {options.currencies.find((c) => c.id === line.currencyId)?.label ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                      {shown.total}
                    </td>
                    {editable && (
                      <td className="px-3 py-1.5 text-right">
                        <span className="inline-flex items-center gap-2">
                          {/* §6.5: where the number came from, at a glance. */}
                          <span
                            className={
                              line.source === 'AUTO'
                                ? 'text-cell text-steel'
                                : 'text-cell text-signal'
                            }
                            title={
                              line.source === 'AUTO'
                                ? 'Pulled from the price list'
                                : 'Typed by hand — no price list covers this'
                            }
                          >
                            {line.source === 'AUTO' ? 'from price list' : 'typed'}
                          </span>
                          <Button
                            variant="destructive"
                            size="inline"
                            onClick={() => onRemove(line)}
                          >
                            Delete
                          </Button>
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
