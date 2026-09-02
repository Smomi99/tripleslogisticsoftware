'use client';

import {
  computeCargoMeasures,
  LOADING_TYPES,
  type ShipmentCargoLineInput,
  type ShipmentDto,
  type ShipmentPrefillDto,
  SHIPMENT_EDITABLE,
  SHIPMENT_STATUS_LABEL,
  sumCargoTotals,
  TRANSIT_TYPES,
} from '@ff/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Shipment Booking — §6.1, one screen for both modes.
 *
 * §3 is explicit that sea and air are the same screen with mode-conditional
 * fields, and forking it "will drift within a month". So the mode changes four
 * things and nothing else: the labels on carrier and the two ports, and whether
 * the Chargeable Weight column is drawn.
 *
 * The grid is §2.2's PO -> Item -> SKU hierarchy rendered flat, as the client
 * draws it: the PO repeats down the rows, each PO gets a subtotal strip, and
 * the Grand Total sits at the foot.
 *
 * CBM and chargeable weight are computed here only to PREVIEW them while
 * somebody types (§6.1 asks for that explicitly). The figures that count are
 * the generated columns Postgres stores, and after every save this screen shows
 * those — `computeCargoMeasures` is the same formula, kept in @ff/shared for
 * §2.3's reason, but the database is the one that is right.
 */

interface Options {
  carriers: { id: string; name: string }[];
  ports: { id: string; name: string; portCode: string }[];
  goodsTypes: { id: string; name: string }[];
  tos: { id: string; name: string }[];
  modes: { id: string; name: string }[];
}

/** A grid row while it is being edited: everything is text, as typed. */
interface DraftLine {
  key: string;
  id?: string;
  poNo: string;
  itemCode: string;
  sku: string;
  ctnQty: string;
  pcsQty: string;
  netWeightKg: string;
  grossWeightKg: string;
  cartonLengthCm: string;
  cartonWidthCm: string;
  cartonHeightCm: string;
  dc: string;
}

const EMPTY_LINE: Omit<DraftLine, 'key'> = {
  poNo: '',
  itemCode: '',
  sku: '',
  ctnQty: '',
  pcsQty: '',
  netWeightKg: '',
  grossWeightKg: '',
  cartonLengthCm: '',
  cartonWidthCm: '',
  cartonHeightCm: '',
  dc: '',
};

let keySeed = 0;
const nextKey = (): string => `draft-${(keySeed += 1)}`;

const num = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Mono, tabular, right-aligned — §12's rule for every figure. */
function Figure({ value, decimals }: { value: number | string | null; decimals: number }) {
  if (value === null || value === '') return <span className="text-steel">—</span>;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return <span className="text-steel">—</span>;
  return <span className="font-mono tabular-nums">{n.toFixed(decimals)}</span>;
}

export function ShipmentBookingScreen({
  shipmentId,
  quotationId,
  embedded = false,
}: {
  /** Editing an existing booking. */
  shipmentId?: string;
  /** Creating one against this quotation (§6.1's entry from the quotation list). */
  quotationId?: string;
  /**
   * Rendered inside §6.3's file, which already carries the booking number, the
   * status and the way back. Drops them here so the page has one of each.
   */
  embedded?: boolean;
}) {
  const { authorizedRequest, can } = useSession();
  const router = useRouter();

  const [booking, setBooking] = useState<ShipmentDto | null>(null);
  const [prefill, setPrefill] = useState<ShipmentPrefillDto | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setPending] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  // §5.1's cancellation. The reason is not a formality — it is the only record
  // of why work somebody paid for was stopped, so the dialog will not close
  // without one.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  // Header, all editable per §5.2 rule 2.
  const [exporterName, setExporterName] = useState('');
  const [exporterAddress, setExporterAddress] = useState('');
  const [importerName, setImporterName] = useState('');
  const [importerAddress, setImporterAddress] = useState('');
  const [goodsTypeId, setGoodsTypeId] = useState('');
  const [placeOfReceipt, setPlaceOfReceipt] = useState('');
  const [loadingType, setLoadingType] = useState('');
  const [tosId, setTosId] = useState('');
  const [modeId, setModeId] = useState('');
  const [carrierId, setCarrierId] = useState('');
  const [polId, setPolId] = useState('');
  const [podId, setPodId] = useState('');
  const [etd, setEtd] = useState('');
  const [eta, setEta] = useState('');
  const [goodsHandoverDate, setGoodsHandoverDate] = useState('');
  const [transitType, setTransitType] = useState('');
  const [warehouseCfs, setWarehouseCfs] = useState('');

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [newLine, setNewLine] = useState<DraftLine>({ key: nextKey(), ...EMPTY_LINE });

  const shipmentType = booking?.shipmentType ?? prefill?.shipmentType ?? 'SEA';
  const isAir = shipmentType === 'AIR';
  const status = booking?.status ?? null;
  const editable = status === null || SHIPMENT_EDITABLE.includes(status);
  const canEdit =
    editable &&
    can(booking === null ? 'CUSTOMER_SERVICE.CARGO_BOOKING.CREATE' : 'CUSTOMER_SERVICE.CARGO_BOOKING.EDIT');

  const applyHeader = useCallback((source: ShipmentDto | ShipmentPrefillDto) => {
    setGoodsTypeId(source.goodsTypeId ?? '');
    setPlaceOfReceipt(source.placeOfReceipt ?? '');
    setLoadingType(source.loadingType ?? '');
    setTosId(source.tosId ?? '');
    setModeId(source.modeId ?? '');
    setCarrierId(source.carrierId);
    setPolId(source.polId);
    setPodId(source.podId);
    setEtd(source.etd ?? '');
    setEta(source.eta ?? '');
    setTransitType(source.transitType ?? '');
    if ('exporterName' in source) {
      setExporterName(source.exporterName ?? '');
      setExporterAddress(source.exporterAddress ?? '');
      setImporterName(source.importerName ?? '');
      setImporterAddress(source.importerAddress ?? '');
      setGoodsHandoverDate(source.goodsHandoverDate ?? '');
      setWarehouseCfs(source.warehouseCfs ?? '');
      setLines(
        source.cargoLines.map((l) => ({
          key: nextKey(),
          id: l.id,
          poNo: l.poNo,
          itemCode: l.itemCode,
          sku: l.sku ?? '',
          ctnQty: String(l.ctnQty),
          pcsQty: l.pcsQty === null ? '' : String(l.pcsQty),
          netWeightKg: l.netWeightKg ?? '',
          grossWeightKg: l.grossWeightKg ?? '',
          cartonLengthCm: l.cartonLengthCm ?? '',
          cartonWidthCm: l.cartonWidthCm ?? '',
          cartonHeightCm: l.cartonHeightCm ?? '',
          dc: l.dc ?? '',
        })),
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const opts = await authorizedRequest<Options>('/api/tenant/cs/booking-options');
        if (cancelled) return;
        setOptions(opts);

        if (shipmentId !== undefined) {
          const row = await authorizedRequest<ShipmentDto>(
            `/api/tenant/cs/bookings/${shipmentId}`,
          );
          if (cancelled) return;
          setBooking(row);
          applyHeader(row);
        } else if (quotationId !== undefined) {
          const row = await authorizedRequest<ShipmentPrefillDto>(
            `/api/tenant/cs/bookings/prefill/${quotationId}`,
          );
          if (cancelled) return;
          setPrefill(row);
          applyHeader(row);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof ApiError ? error.message : 'Could not load this booking.',
          );
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [applyHeader, authorizedRequest, quotationId, shipmentId]);

  /** The grid, grouped by PO in the order the POs first appear. */
  const groups = useMemo(() => {
    const byPo = new Map<string, DraftLine[]>();
    for (const line of lines) {
      const key = line.poNo.trim() === '' ? '—' : line.poNo.trim();
      const bucket = byPo.get(key);
      if (bucket === undefined) byPo.set(key, [line]);
      else bucket.push(line);
    }
    return [...byPo.entries()];
  }, [lines]);

  const measuresOf = (line: DraftLine) =>
    computeCargoMeasures({
      ctnQty: num(line.ctnQty),
      grossWeightKg: num(line.grossWeightKg),
      cartonLengthCm: num(line.cartonLengthCm),
      cartonWidthCm: num(line.cartonWidthCm),
      cartonHeightCm: num(line.cartonHeightCm),
    });

  const totalsOf = (rows: DraftLine[]) =>
    sumCargoTotals(
      rows.map((l) => ({
        ctnQty: num(l.ctnQty),
        pcsQty: num(l.pcsQty),
        netWeightKg: num(l.netWeightKg),
        grossWeightKg: num(l.grossWeightKg),
        cartonLengthCm: num(l.cartonLengthCm),
        cartonWidthCm: num(l.cartonWidthCm),
        cartonHeightCm: num(l.cartonHeightCm),
      })),
    );

  const grandTotal = totalsOf(lines);

  function addLine(): void {
    const draft = newLine;
    if (draft.poNo.trim() === '' || draft.itemCode.trim() === '' || num(draft.ctnQty) === null) {
      setFormError('A cargo line needs a PO number, an item and a carton quantity.');
      return;
    }
    setFormError(null);
    setLines((current) => [...current, { ...draft, key: nextKey() }]);
    setNewLine({ key: nextKey(), ...EMPTY_LINE });
  }

  function removeLine(key: string): void {
    setLines((current) => current.filter((l) => l.key !== key));
  }

  function editLine(key: string, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function toInput(line: DraftLine): ShipmentCargoLineInput {
    const optional = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());
    return {
      ...(line.id === undefined ? {} : { id: line.id }),
      poNo: line.poNo.trim(),
      itemCode: line.itemCode.trim(),
      sku: optional(line.sku),
      ctnQty: Number(line.ctnQty),
      pcsQty: line.pcsQty.trim() === '' ? undefined : Number(line.pcsQty),
      netWeightKg: optional(line.netWeightKg),
      grossWeightKg: optional(line.grossWeightKg),
      cartonLengthCm: optional(line.cartonLengthCm),
      cartonWidthCm: optional(line.cartonWidthCm),
      cartonHeightCm: optional(line.cartonHeightCm),
      dc: optional(line.dc),
    };
  }

  function headerBody(): Record<string, unknown> {
    const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());
    return {
      exporterName: orNull(exporterName),
      exporterAddress: orNull(exporterAddress),
      importerName: orNull(importerName),
      importerAddress: orNull(importerAddress),
      goodsTypeId: goodsTypeId === '' ? null : goodsTypeId,
      placeOfReceipt: orNull(placeOfReceipt),
      loadingType: loadingType === '' ? null : loadingType,
      tosId: tosId === '' ? null : tosId,
      modeId: modeId === '' ? null : modeId,
      carrierId,
      polId,
      podId,
      etd: etd === '' ? null : etd,
      eta: eta === '' ? null : eta,
      goodsHandoverDate: goodsHandoverDate === '' ? null : goodsHandoverDate,
      transitType: transitType === '' ? null : transitType,
      warehouseCfs: orNull(warehouseCfs),
      cargoLines: lines.map(toInput),
    };
  }

  async function save(): Promise<ShipmentDto | null> {
    setFormError(null);
    setPending(true);
    try {
      const saved =
        booking === null
          ? await authorizedRequest<ShipmentDto>('/api/tenant/cs/bookings', {
              method: 'POST',
              body: { quotationId: prefill?.quotationId ?? quotationId, ...headerBody() },
            })
          : await authorizedRequest<ShipmentDto>(`/api/tenant/cs/bookings/${booking.id}`, {
              method: 'PATCH',
              body: headerBody(),
            });
      setBooking(saved);
      applyHeader(saved);
      return saved;
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not save this booking.',
      );
      return null;
    } finally {
      setPending(false);
    }
  }

  async function onSave(): Promise<void> {
    const saved = await save();
    if (saved === null) return;
    toast.success(booking === null ? `Booking ${saved.code} created` : 'Saved');
    if (booking === null) router.replace(`/cs/shipment-booking/${saved.id}`);
  }

  async function onSubmit(): Promise<void> {
    setConfirmSubmit(false);
    const saved = await save();
    if (saved === null) return;
    setPending(true);
    try {
      const submitted = await authorizedRequest<ShipmentDto>(
        `/api/tenant/cs/bookings/${saved.id}/submit`,
        { method: 'POST' },
      );
      setBooking(submitted);
      toast.success(`Booking ${submitted.code} submitted`);
      if (booking === null) router.replace(`/cs/shipment-booking/${submitted.id}`);
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Could not submit this booking.');
    } finally {
      setPending(false);
    }
  }

  async function onCancel(): Promise<void> {
    if (booking === null) return;
    if (cancelReason.trim() === '') {
      setFormError('Say why this booking is being cancelled.');
      return;
    }
    setPending(true);
    try {
      const cancelled = await authorizedRequest<ShipmentDto>(
        `/api/tenant/cs/bookings/${booking.id}/cancel`,
        { method: 'POST', body: { reason: cancelReason.trim() } },
      );
      setBooking(cancelled);
      setCancelOpen(false);
      setCancelReason('');
      setFormError(null);
      toast.success(`Booking ${cancelled.code} cancelled`);
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not cancel this booking.',
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Shipment Booking" description="" />
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
        <Link href="/cs/quotation" className="text-body text-harbour hover:underline">
          ← Back to quotation list
        </Link>
      </div>
    );
  }

  if (options === null || (booking === null && prefill === null)) {
    return <p className="text-body text-steel">Loading…</p>;
  }

  const quotationCode = booking?.quotationCode ?? prefill?.quotationCode ?? '—';
  const customerName = booking?.customerName ?? prefill?.customerName ?? '—';
  const commodities = booking?.commodities ?? prefill?.commodities ?? [];
  // §3's mode-conditional labels. The only thing sea and air disagree about.
  const carrierLabel = isAir ? 'Airlines' : 'Carrier';
  const polLabel = isAir ? 'AOL' : 'POL';
  const podLabel = isAir ? 'AOD' : 'POD';
  const columnCount = isAir ? 13 : 12;

  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Shipment Booking"
          description={`${isAir ? 'Air' : 'Sea'} · against quotation ${quotationCode}`}
        />
        <div className="flex items-center gap-3">
          {booking !== null && (
            <Status
              tone={
                booking.status === 'CANCELLED' || booking.status === 'REJECTED'
                  ? 'overdue'
                  : booking.status === 'BOOKING_RECEIVED'
                    ? 'pending'
                    : 'active'
              }
            >
              {SHIPMENT_STATUS_LABEL[booking.status]}
            </Status>
          )}
          {booking !== null && (
            <span className="font-mono tabular-nums text-body text-hull">{booking.code}</span>
          )}
        </div>
      </div>
      )}

      {booking?.status === 'CANCELLED' ? (
        <p className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-hull">
          <span className="font-medium">Cancelled.</span> {booking.cancelReason}
        </p>
      ) : (
        !editable && (
          <p className="rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2 text-body text-hull">
            This booking has moved on and can no longer be edited. Its schedule or shipping order
            depends on these figures.
          </p>
        )
      )}

      {/* ------------------------------------------------------------ header */}
      <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <h2 className="mb-3 text-section text-hull">Booking</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="customer" label="Customer">
            <Input id="customer" value={customerName} readOnly disabled />
          </Field>
          <Field id="commodity" label="Commodity">
            <Input
              id="commodity"
              value={commodities.map((c) => c.commodityName).join(', ') || '—'}
              readOnly
              disabled
            />
          </Field>
          <Field id="hsCode" label="HS Code">
            <Input
              id="hsCode"
              value={commodities.map((c) => c.hsCode).filter(Boolean).join(', ') || '—'}
              readOnly
              disabled
            />
          </Field>

          <Field id="exporterName" label="Exporter">
            <Input
              id="exporterName"
              value={exporterName}
              disabled={!canEdit}
              onChange={(e) => setExporterName(e.target.value)}
            />
          </Field>
          <Field id="exporterAddress" label="Exporter address" wide>
            <Input
              id="exporterAddress"
              value={exporterAddress}
              disabled={!canEdit}
              onChange={(e) => setExporterAddress(e.target.value)}
            />
          </Field>
          <Field id="importerName" label="Importer">
            <Input
              id="importerName"
              value={importerName}
              disabled={!canEdit}
              onChange={(e) => setImporterName(e.target.value)}
            />
          </Field>
          <Field id="importerAddress" label="Importer address" wide>
            <Input
              id="importerAddress"
              value={importerAddress}
              disabled={!canEdit}
              onChange={(e) => setImporterAddress(e.target.value)}
            />
          </Field>

          <Field id="goodsTypeId" label="Goods Type">
            <Select
              id="goodsTypeId"
              value={goodsTypeId}
              disabled={!canEdit}
              onChange={(e) => setGoodsTypeId(e.target.value)}
            >
              <option value="">—</option>
              {options.goodsTypes.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="placeOfReceipt" label="Place of Receipt">
            <Input
              id="placeOfReceipt"
              value={placeOfReceipt}
              disabled={!canEdit}
              onChange={(e) => setPlaceOfReceipt(e.target.value)}
            />
          </Field>
          <Field id="loadingType" label="Loading Type">
            <Select
              id="loadingType"
              value={loadingType}
              disabled={!canEdit}
              onChange={(e) => setLoadingType(e.target.value)}
            >
              <option value="">—</option>
              {LOADING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="tosId" label="TOS">
            <Select id="tosId" value={tosId} disabled={!canEdit} onChange={(e) => setTosId(e.target.value)}>
              <option value="">—</option>
              {options.tos.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="modeId" label="Mode">
            <Select id="modeId" value={modeId} disabled={!canEdit} onChange={(e) => setModeId(e.target.value)}>
              <option value="">—</option>
              {options.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="carrierId" label={carrierLabel} required>
            <Select
              id="carrierId"
              value={carrierId}
              disabled={!canEdit}
              onChange={(e) => setCarrierId(e.target.value)}
            >
              {options.carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="polId" label={polLabel} required>
            <Select id="polId" value={polId} disabled={!canEdit} onChange={(e) => setPolId(e.target.value)}>
              {options.ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} - {p.portCode}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="podId" label={podLabel} required>
            <Select id="podId" value={podId} disabled={!canEdit} onChange={(e) => setPodId(e.target.value)}>
              {options.ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} - {p.portCode}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="etd" label="ETD">
            <Input id="etd" type="date" value={etd} disabled={!canEdit} onChange={(e) => setEtd(e.target.value)} />
          </Field>
          <Field id="eta" label="ETA">
            <Input id="eta" type="date" value={eta} disabled={!canEdit} onChange={(e) => setEta(e.target.value)} />
          </Field>
          <Field id="goodsHandoverDate" label="Goods hand over date">
            <Input
              id="goodsHandoverDate"
              type="date"
              value={goodsHandoverDate}
              disabled={!canEdit}
              onChange={(e) => setGoodsHandoverDate(e.target.value)}
            />
          </Field>
          <Field id="transitType" label="Transit Type">
            <Select
              id="transitType"
              value={transitType}
              disabled={!canEdit}
              onChange={(e) => setTransitType(e.target.value)}
            >
              <option value="">—</option>
              {TRANSIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      {/* -------------------------------------------------------------- grid */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <h2 className="border-b border-line px-4 py-3 text-section text-hull">Cargo</h2>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-2 py-2 text-left">PO</th>
                <th className="label-manifest px-2 py-2 text-left">Item</th>
                <th className="label-manifest px-2 py-2 text-left">SKU</th>
                <th className="label-manifest px-2 py-2 text-right">CTN Qty</th>
                <th className="label-manifest px-2 py-2 text-right">PCS Qty</th>
                <th className="label-manifest px-2 py-2 text-right">Total N.WT</th>
                <th className="label-manifest px-2 py-2 text-right">Total G.WT</th>
                <th className="label-manifest px-2 py-2 text-right" colSpan={3}>
                  Carton size (cm)
                </th>
                <th className="label-manifest px-2 py-2 text-right">Total CBM</th>
                {isAir && (
                  <th className="label-manifest px-2 py-2 text-right">Total Chargeable WT</th>
                )}
                <th className="label-manifest px-2 py-2 text-left">DC</th>
                <th className="label-manifest px-2 py-2 text-right">Action</th>
              </tr>
            </thead>

            {/* §6.1: add row on top, list below. */}
            {canEdit && (
              <tbody className="border-b-2 border-line">
                <tr className="bg-paper/40">
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line PO"
                      value={newLine.poNo}
                      onChange={(e) => setNewLine({ ...newLine, poNo: e.target.value })}
                      className="w-28"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line item"
                      value={newLine.itemCode}
                      onChange={(e) => setNewLine({ ...newLine, itemCode: e.target.value })}
                      className="w-28"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line SKU"
                      value={newLine.sku}
                      onChange={(e) => setNewLine({ ...newLine, sku: e.target.value })}
                      className="w-24"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line carton quantity"
                      numeric
                      value={newLine.ctnQty}
                      onChange={(e) => setNewLine({ ...newLine, ctnQty: e.target.value })}
                      className="w-20"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line piece quantity"
                      numeric
                      value={newLine.pcsQty}
                      onChange={(e) => setNewLine({ ...newLine, pcsQty: e.target.value })}
                      className="w-20"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line net weight"
                      numeric
                      value={newLine.netWeightKg}
                      onChange={(e) => setNewLine({ ...newLine, netWeightKg: e.target.value })}
                      className="w-24"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line gross weight"
                      numeric
                      value={newLine.grossWeightKg}
                      onChange={(e) => setNewLine({ ...newLine, grossWeightKg: e.target.value })}
                      className="w-24"
                    />
                  </td>
                  <td className="px-1 py-2">
                    <Input
                      aria-label="New line carton length"
                      numeric
                      placeholder="L"
                      value={newLine.cartonLengthCm}
                      onChange={(e) => setNewLine({ ...newLine, cartonLengthCm: e.target.value })}
                      className="w-16"
                    />
                  </td>
                  <td className="px-1 py-2">
                    <Input
                      aria-label="New line carton width"
                      numeric
                      placeholder="W"
                      value={newLine.cartonWidthCm}
                      onChange={(e) => setNewLine({ ...newLine, cartonWidthCm: e.target.value })}
                      className="w-16"
                    />
                  </td>
                  <td className="px-1 py-2">
                    <Input
                      aria-label="New line carton height"
                      numeric
                      placeholder="H"
                      value={newLine.cartonHeightCm}
                      onChange={(e) => setNewLine({ ...newLine, cartonHeightCm: e.target.value })}
                      className="w-16"
                    />
                  </td>
                  {/* Read-only computed cells, live as L/W/H/qty are typed (§6.1). */}
                  <td className="px-2 py-2 text-right">
                    <Figure value={measuresOf(newLine).volumeCbm} decimals={4} />
                  </td>
                  {isAir && (
                    <td className="px-2 py-2 text-right">
                      <Figure value={measuresOf(newLine).chargeableWtKg} decimals={3} />
                    </td>
                  )}
                  <td className="px-2 py-2">
                    <Input
                      aria-label="New line DC"
                      value={newLine.dc}
                      onChange={(e) => setNewLine({ ...newLine, dc: e.target.value })}
                      className="w-24"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Button size="inline" onClick={addLine}>
                      ADD
                    </Button>
                  </td>
                </tr>
              </tbody>
            )}

            {/* §2.2 rendered flat: PO repeats, each group gets a subtotal. */}
            {groups.map(([poNo, rows]) => {
              const subtotal = totalsOf(rows);
              return (
                <tbody key={poNo} className="border-b border-line">
                  {rows.map((line) => {
                    const m = measuresOf(line);
                    return (
                      <tr key={line.key} className="border-b border-line/60 hover:bg-[#F0F4F4]">
                        <td className="px-2 py-1 font-mono tabular-nums text-hull">{poNo}</td>
                        <td className="px-2 py-1">
                          {canEdit ? (
                            <Input
                              aria-label="Item"
                              value={line.itemCode}
                              onChange={(e) => editLine(line.key, { itemCode: e.target.value })}
                              className="w-28"
                            />
                          ) : (
                            line.itemCode
                          )}
                        </td>
                        <td className="px-2 py-1">
                          {canEdit ? (
                            <Input
                              aria-label="SKU"
                              value={line.sku}
                              onChange={(e) => editLine(line.key, { sku: e.target.value })}
                              className="w-24"
                            />
                          ) : (
                            line.sku || '—'
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Carton quantity"
                              numeric
                              value={line.ctnQty}
                              onChange={(e) => editLine(line.key, { ctnQty: e.target.value })}
                              className="w-20"
                            />
                          ) : (
                            <Figure value={line.ctnQty} decimals={0} />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Piece quantity"
                              numeric
                              value={line.pcsQty}
                              onChange={(e) => editLine(line.key, { pcsQty: e.target.value })}
                              className="w-20"
                            />
                          ) : (
                            <Figure value={line.pcsQty} decimals={0} />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Net weight"
                              numeric
                              value={line.netWeightKg}
                              onChange={(e) => editLine(line.key, { netWeightKg: e.target.value })}
                              className="w-24"
                            />
                          ) : (
                            <Figure value={line.netWeightKg} decimals={3} />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Gross weight"
                              numeric
                              value={line.grossWeightKg}
                              onChange={(e) => editLine(line.key, { grossWeightKg: e.target.value })}
                              className="w-24"
                            />
                          ) : (
                            <Figure value={line.grossWeightKg} decimals={3} />
                          )}
                        </td>
                        <td className="px-1 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Carton length"
                              numeric
                              value={line.cartonLengthCm}
                              onChange={(e) => editLine(line.key, { cartonLengthCm: e.target.value })}
                              className="w-16"
                            />
                          ) : (
                            <Figure value={line.cartonLengthCm} decimals={3} />
                          )}
                        </td>
                        <td className="px-1 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Carton width"
                              numeric
                              value={line.cartonWidthCm}
                              onChange={(e) => editLine(line.key, { cartonWidthCm: e.target.value })}
                              className="w-16"
                            />
                          ) : (
                            <Figure value={line.cartonWidthCm} decimals={3} />
                          )}
                        </td>
                        <td className="px-1 py-1 text-right">
                          {canEdit ? (
                            <Input
                              aria-label="Carton height"
                              numeric
                              value={line.cartonHeightCm}
                              onChange={(e) => editLine(line.key, { cartonHeightCm: e.target.value })}
                              className="w-16"
                            />
                          ) : (
                            <Figure value={line.cartonHeightCm} decimals={3} />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <Figure value={m.volumeCbm} decimals={4} />
                        </td>
                        {isAir && (
                          <td className="px-2 py-1 text-right">
                            <Figure value={m.chargeableWtKg} decimals={3} />
                          </td>
                        )}
                        <td className="px-2 py-1">
                          {canEdit ? (
                            <Input
                              aria-label="DC"
                              value={line.dc}
                              onChange={(e) => editLine(line.key, { dc: e.target.value })}
                              className="w-24"
                            />
                          ) : (
                            line.dc || '—'
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {canEdit && (
                            <Button
                              variant="destructive"
                              size="inline"
                              onClick={() => removeLine(line.key)}
                            >
                              Delete
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-paper/60">
                    <td className="px-2 py-1 text-right font-medium text-steel" colSpan={3}>
                      {poNo} total
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Figure value={subtotal.ctnQty} decimals={0} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Figure value={subtotal.pcsQty} decimals={0} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Figure value={subtotal.netWeightKg} decimals={3} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Figure value={subtotal.grossWeightKg} decimals={3} />
                    </td>
                    <td colSpan={3} />
                    <td className="px-2 py-1 text-right">
                      <Figure value={subtotal.volumeCbm} decimals={4} />
                    </td>
                    {isAir && (
                      <td className="px-2 py-1 text-right">
                        <Figure value={subtotal.chargeableWtKg} decimals={3} />
                      </td>
                    )}
                    <td colSpan={2} />
                  </tr>
                </tbody>
              );
            })}

            {lines.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={columnCount + 2} className="px-4 py-8 text-center text-steel">
                    No cargo on this booking yet. Add a PO line above to start.
                  </td>
                </tr>
              </tbody>
            )}

            <tfoot>
              <tr className="border-t-2 border-hull/20 bg-paper font-medium">
                <td className="px-2 py-2 text-right text-hull" colSpan={3}>
                  Grand Total
                </td>
                <td className="px-2 py-2 text-right text-hull">
                  <Figure value={grandTotal.ctnQty} decimals={0} />
                </td>
                <td className="px-2 py-2 text-right text-hull">
                  <Figure value={grandTotal.pcsQty} decimals={0} />
                </td>
                <td className="px-2 py-2 text-right text-hull">
                  <Figure value={grandTotal.netWeightKg} decimals={3} />
                </td>
                <td className="px-2 py-2 text-right text-hull">
                  <Figure value={grandTotal.grossWeightKg} decimals={3} />
                </td>
                <td colSpan={3} />
                <td className="px-2 py-2 text-right text-hull">
                  <Figure value={grandTotal.volumeCbm} decimals={4} />
                </td>
                {isAir && (
                  <td className="px-2 py-2 text-right text-hull">
                    <Figure value={grandTotal.chargeableWtKg} decimals={3} />
                  </td>
                )}
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {formError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {embedded ? (
          <span />
        ) : (
          <Link href="/cs/quotation" className="text-body text-harbour hover:underline">
            ← Back to quotation list
          </Link>
        )}
        <div className="flex items-center gap-2">
          {booking !== null &&
            booking.status !== 'CANCELLED' &&
            can('CUSTOMER_SERVICE.CARGO_BOOKING.CANCEL') && (
              <Button
                variant="destructive"
                disabled={isPending}
                onClick={() => {
                  setCancelReason('');
                  setFormError(null);
                  setCancelOpen(true);
                }}
              >
                Cancel booking
              </Button>
            )}
          {canEdit && (
            <Button variant="secondary" disabled={isPending} onClick={() => void onSave()}>
              {isPending ? 'Saving…' : 'Save booking'}
            </Button>
          )}
          {canEdit && can('CUSTOMER_SERVICE.CARGO_BOOKING.SUBMIT') && (
            <Button disabled={isPending} onClick={() => setConfirmSubmit(true)}>
              Submit
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title="Submit this booking?"
        message={`${grandTotal.ctnQty} cartons across ${groups.length} PO(s) will be handed to operations. The booking stops being editable once a vessel is proposed against it.`}
        confirmLabel="Submit"
        isPending={isPending}
        onConfirm={() => void onSubmit()}
      />

      {/*
        A confirmation would not do here: §5.1 makes the reason mandatory, so
        the dialog has to collect something rather than only ask twice.
      */}
      <Modal
        open={cancelOpen}
        onOpenChange={(open) => {
          setCancelOpen(open);
          if (!open) setCancelReason('');
        }}
        title="Cancel this booking?"
      >
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            {booking?.code} stops here and nothing further can be done with it. Say why — this is
            the only record of it, and it is what accounts and the customer will read later.
          </p>
          <Field id="cancelReason" label="Reason" required>
            <Input
              id="cancelReason"
              autoFocus
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Customer withdrew the order"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={isPending || cancelReason.trim() === ''}
              onClick={() => void onCancel()}
            >
              {isPending ? 'Cancelling…' : 'Cancel booking'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
