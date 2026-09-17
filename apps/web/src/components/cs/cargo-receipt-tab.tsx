'use client';

import {
  describeBalance,
  type CargoReceiptBoard,
  type CargoReceiptDto,
  type ReceiptGridRow,
  type ShipmentDto,
} from '@ff/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Cargo Receipt — §6.7, on the shipment file.
 *
 * §5.5 rule 1 is the reason the grid is shaped this way: "Show booked, S/O and
 * received side by side, with the variance highlighted — a receiver who cannot
 * see the gap cannot flag it." So every booked line is drawn whether or not
 * anything has arrived against it, and a short line is marked rather than left
 * for someone to notice.
 *
 * §2.4: nothing here writes back to the booked figures. They are the customer's
 * instruction; this is what turned up.
 */

interface Draft {
  receivedCtnQty: string;
  receivedPcsQty: string;
  receivedNetWeightKg: string;
  receivedGrossWeightKg: string;
  cartonLengthCm: string;
  cartonWidthCm: string;
  cartonHeightCm: string;
  lineStatus: 'ACCEPTED' | 'DECLINED';
  declineReason: string;
  remarks: string;
  /** Not on this screen; carried so saving a line again does not drop it. */
  overReceiptReason: string;
  /** G.WT still tracks the received cartons, because nobody has typed over it. */
  grossFollowsQty: boolean;
}

const emptyDraft = (): Draft => ({
  receivedCtnQty: '',
  receivedPcsQty: '',
  receivedNetWeightKg: '',
  receivedGrossWeightKg: '',
  cartonLengthCm: '',
  cartonWidthCm: '',
  cartonHeightCm: '',
  lineStatus: 'ACCEPTED',
  declineReason: '',
  remarks: '',
  overReceiptReason: '',
  grossFollowsQty: false,
});

/** The booked gross weight for `ctn` cartons of this line; '' when the booking has none. */
function bookedGrossFor(row: ReceiptGridRow, ctn: string): string {
  const qty = Number(ctn);
  if (ctn.trim() === '' || !Number.isInteger(qty) || qty < 0) return '';
  // The whole booked quantity takes the booked total as typed, not a
  // per-carton figure multiplied back up with its rounding.
  if (qty === row.bookedCtnQty && row.bookedGrossWeightKg !== null) return row.bookedGrossWeightKg;
  if (row.bookedGrossWeightPerCartonKg === null) return '';
  return (Number(row.bookedGrossWeightPerCartonKg) * qty).toFixed(3);
}

/**
 * A new receipt starts from the booking: the balance still owed, at the booked
 * carton size and weight. The receiver corrects what arrived differently
 * instead of retyping what the booking already knows. A line with nothing owed
 * stays blank, so it is not recorded as a zero receipt.
 */
const fromBooking = (row: ReceiptGridRow): Draft => {
  if (row.balanceCtnQty <= 0) return emptyDraft();
  const qty = String(row.balanceCtnQty);
  return {
    ...emptyDraft(),
    receivedCtnQty: qty,
    receivedGrossWeightKg: bookedGrossFor(row, qty),
    cartonLengthCm: row.bookedCartonLengthCm ?? '',
    cartonWidthCm: row.bookedCartonWidthCm ?? '',
    cartonHeightCm: row.bookedCartonHeightCm ?? '',
    grossFollowsQty: true,
  };
};

const fromRow = (row: ReceiptGridRow): Draft => ({
  receivedCtnQty: row.receivedCtnQty === null ? '' : String(row.receivedCtnQty),
  receivedPcsQty: row.receivedPcsQty === null ? '' : String(row.receivedPcsQty),
  receivedNetWeightKg: row.receivedNetWeightKg ?? '',
  receivedGrossWeightKg: row.receivedGrossWeightKg ?? '',
  cartonLengthCm: row.cartonLengthCm ?? '',
  cartonWidthCm: row.cartonWidthCm ?? '',
  cartonHeightCm: row.cartonHeightCm ?? '',
  lineStatus: row.lineStatus ?? 'ACCEPTED',
  declineReason: row.declineReason ?? '',
  remarks: row.remarks ?? '',
  overReceiptReason: row.overReceiptReason ?? '',
  grossFollowsQty: false,
});

const today = (): string => new Date().toISOString().slice(0, 10);

/** Stored UTC, read in Dhaka (CLAUDE.md §9). */
const inDhaka = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

function Fig({ value, dp = 0 }: { value: number | string | null; dp?: number }) {
  if (value === null || value === '') return <span className="text-steel">—</span>;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return <span className="text-steel">—</span>;
  return <span className="font-mono tabular-nums">{n.toFixed(dp)}</span>;
}

/**
 * What one confirmed receipt recorded. The grid below only carries the open
 * receipt's figures, so without this a confirmed receipt's weights and carton
 * sizes were on the record and nowhere on screen.
 */
function ReceiptLines({ rows }: { rows: readonly ReceiptGridRow[] }) {
  const lines = rows.filter((row) => row.receiptLineId !== null);
  if (lines.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-cell">
        <thead>
          <tr className="border-y border-line bg-paper">
            <th className="label-manifest px-2 py-2 text-left">PO</th>
            <th className="label-manifest px-2 py-2 text-left">Item</th>
            <th className="label-manifest px-2 py-2 text-left">SKU</th>
            <th className="label-manifest px-2 py-2 text-right">Received</th>
            <th className="label-manifest px-2 py-2 text-right">G.WT</th>
            <th className="label-manifest px-2 py-2 text-right" colSpan={3}>
              Carton (cm)
            </th>
            <th className="label-manifest px-2 py-2 text-left">Line</th>
            <th className="label-manifest px-2 py-2 text-left">Reason / remarks</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((row) => {
            const notes = [row.declineReason, row.overReceiptReason, row.remarks]
              .filter((v): v is string => v !== null && v.trim() !== '')
              .join(' · ');
            return (
              <tr key={row.cargoLineId} className="border-b border-line/60 last:border-b-0">
                <td className="px-2 py-1.5 font-mono tabular-nums text-hull">{row.poNo}</td>
                <td className="px-2 py-1.5">{row.itemCode}</td>
                <td className="px-2 py-1.5">{row.sku ?? '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  <Fig value={row.receivedCtnQty} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Fig value={row.receivedGrossWeightKg} dp={3} />
                </td>
                <td className="px-1 py-1.5 text-right">
                  <Fig value={row.cartonLengthCm} dp={3} />
                </td>
                <td className="px-1 py-1.5 text-right">
                  <Fig value={row.cartonWidthCm} dp={3} />
                </td>
                <td className="px-1 py-1.5 text-right">
                  <Fig value={row.cartonHeightCm} dp={3} />
                </td>
                <td className="px-2 py-1.5">
                  <Status tone={row.lineStatus === 'DECLINED' ? 'overdue' : 'active'}>
                    {row.lineStatus === 'DECLINED' ? 'Declined' : 'Accepted'}
                  </Status>
                </td>
                <td className="px-2 py-1.5 text-steel">{notes === '' ? '—' : notes}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CargoReceiptTab({
  booking,
  onChanged,
}: {
  booking: ShipmentDto;
  onChanged: () => void;
}) {
  const { authorizedRequest, can } = useSession();

  const [receipts, setReceipts] = useState<CargoReceiptDto[]>([]);
  const [grid, setGrid] = useState<ReceiptGridRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [receiveDate, setReceiveDate] = useState(today());
  const [unloadLocation, setUnloadLocation] = useState('');
  const [efrNo, setEfrNo] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // §5.5 rule 5. The reason is the whole point of the record, so the dialog
  // collects one rather than only asking twice.
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  // Why confirmed receipts are locked (on a CLP, short closed), or null.
  const [editLock, setEditLock] = useState<string | null>(null);
  // The confirmed receipt open in the form instead of the new one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState('');
  const formRef = useRef<HTMLElement>(null);

  /** Puts the form on the new receipt, or on the open draft when there is one. */
  const fillEntry = useCallback((all: CargoReceiptDto[], rows: ReceiptGridRow[]) => {
    const open = all.find((r) => r.status === 'DRAFT') ?? null;
    setReceiveDate(open?.receiveDate ?? today());
    setUnloadLocation(open?.unloadLocation ?? '');
    setEfrNo(open?.efrNo ?? '');
    // A saved draft shows what was saved, blanks included: a line the receiver
    // cleared means nothing arrived, and refilling it would put it back on the
    // receipt at the next save.
    setDrafts(
      Object.fromEntries(
        rows.map((row) => [
          row.cargoLineId,
          row.receiptLineId !== null
            ? fromRow(row)
            : open === null
              ? fromBooking(row)
              : emptyDraft(),
        ]),
      ),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await authorizedRequest<CargoReceiptBoard>(
        `/api/tenant/ops/bookings/${booking.id}/cargo-receipts`,
      );
      setReceipts(data.receipts);
      setGrid(data.grid);
      setEditLock(data.editLock);
      fillEntry(data.receipts, data.grid);
    } catch {
      setGrid([]);
    } finally {
      setLoaded(true);
    }
  }, [authorizedRequest, booking.id, fillEntry]);

  useEffect(() => {
    void load();
  }, [load]);

  const openReceipt = receipts.find((r) => r.status === 'DRAFT') ?? null;
  const confirmed = receipts.filter((r) => r.status === 'CONFIRMED');
  const editing = confirmed.find((r) => r.id === editingId) ?? null;
  const receivable = ['SO_ISSUED', 'SO_SKIPPED', 'PART_RECEIVED'].includes(booking.status);
  const mayRecord = can('OPERATION.CARGO_RECEIPT.CREATE');
  const mayDecline = can('OPERATION.CARGO_RECEIPT.DECLINE_LINE');
  const mayEdit = can('OPERATION.CARGO_RECEIPT.EDIT');
  const editable = editing !== null || (receivable && mayRecord);
  // With nothing to type and no draft to show, those columns are only dashes;
  // what confirmed receipts recorded is listed under "Receipts so far".
  const showEntry = editable || openReceipt !== null;
  // An edit is measured against what the OTHER receipts left owed, which is
  // how the API sends that receipt's rows.
  const rows = editing?.rows ?? grid;

  useEffect(() => {
    if (editingId !== null) formRef.current?.scrollIntoView({ block: 'start' });
  }, [editingId]);

  /** Rows the receiver has actually put a figure against. */
  const touched = useMemo(
    () =>
      rows.filter((row) => {
        const d = drafts[row.cargoLineId];
        return d !== undefined && d.receivedCtnQty.trim() !== '';
      }),
    [drafts, rows],
  );

  function edit(id: string, patch: Partial<Draft>): void {
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));
  }

  function startEdit(receipt: CargoReceiptDto): void {
    setError(null);
    setEditReason('');
    setEditingId(receipt.id);
    setReceiveDate(receipt.receiveDate);
    setUnloadLocation(receipt.unloadLocation ?? '');
    setEfrNo(receipt.efrNo ?? '');
    setDrafts(
      Object.fromEntries(
        receipt.rows.map((row) => [
          row.cargoLineId,
          row.receiptLineId === null ? emptyDraft() : fromRow(row),
        ]),
      ),
    );
  }

  function cancelEdit(): void {
    setError(null);
    setEditingId(null);
    fillEntry(receipts, grid);
  }

  /** The receipt as the form holds it: header, and every line with a figure. */
  function receiptBody() {
    const opt = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());
    return {
      receiveDate,
      unloadLocation: unloadLocation.trim() === '' ? null : unloadLocation.trim(),
      efrNo: efrNo.trim() === '' ? null : efrNo.trim(),
      lines: touched.map((row) => {
        const d = drafts[row.cargoLineId]!;
        return {
          cargoLineId: row.cargoLineId,
          receivedCtnQty: Number(d.receivedCtnQty),
          receivedPcsQty: d.receivedPcsQty.trim() === '' ? undefined : Number(d.receivedPcsQty),
          receivedNetWeightKg: opt(d.receivedNetWeightKg),
          receivedGrossWeightKg: opt(d.receivedGrossWeightKg),
          cartonLengthCm: opt(d.cartonLengthCm),
          cartonWidthCm: opt(d.cartonWidthCm),
          cartonHeightCm: opt(d.cartonHeightCm),
          lineStatus: d.lineStatus,
          declineReason: opt(d.declineReason),
          remarks: opt(d.remarks),
          overReceiptReason: opt(d.overReceiptReason),
        };
      }),
    };
  }

  async function saveEdit(): Promise<void> {
    if (editing === null || editReason.trim() === '') return;
    setError(null);
    setPending(true);
    try {
      const saved = await authorizedRequest<CargoReceiptDto>(
        `/api/tenant/ops/bookings/${booking.id}/cargo-receipts/${editing.id}`,
        { method: 'PUT', body: { ...receiptBody(), reason: editReason.trim() } },
      );
      toast.success(`${saved.code} saved`);
      setEditingId(null);
      await load();
      // The booking may have moved between Part received and Cargo received.
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the changes to this receipt.');
    } finally {
      setPending(false);
    }
  }

  async function save(thenConfirm: boolean): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const saved = await authorizedRequest<CargoReceiptDto>(
        `/api/tenant/ops/bookings/${booking.id}/cargo-receipts`,
        { method: 'POST', body: receiptBody() },
      );

      if (!thenConfirm) {
        toast.success('Receipt saved');
        await load();
        return;
      }

      const done = await authorizedRequest<CargoReceiptDto>(
        `/api/tenant/ops/bookings/${booking.id}/cargo-receipts/${saved.id}/confirm`,
        { method: 'POST' },
      );
      toast.success(`${done.code} confirmed`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this receipt.');
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  async function shortClose(): Promise<void> {
    if (closeReason.trim() === '') return;
    setPending(true);
    try {
      const result = await authorizedRequest<{ summary: string }>(
        `/api/tenant/ops/bookings/${booking.id}/short-close`,
        { method: 'POST', body: { reason: closeReason.trim() } },
      );
      toast.success(result.summary);
      setClosing(false);
      setCloseReason('');
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not close the balance.');
      setClosing(false);
    } finally {
      setPending(false);
    }
  }

  if (!loaded) return <p className="text-body text-steel">Loading…</p>;

  if (!receivable && confirmed.length === 0) {
    return (
      <EmptyState
        title="Nothing received yet"
        description="Cargo receipts are recorded once a shipping order has been issued, or skipped on an inbound shipment."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --------------------------------------------- receipts already closed */}
      {confirmed.length > 0 && (
        <section className="rounded-manifest border border-line bg-surface shadow-manifest">
          <h2 className="border-b border-line px-4 py-3 text-section text-hull">Receipts so far</h2>
          {/* Only to someone who could otherwise edit: the lock is their next step. */}
          {mayEdit && editLock !== null && (
            <p className="border-b border-line bg-paper px-4 py-2 text-body text-steel">{editLock}</p>
          )}
          {confirmed.map((r) => (
            <div key={r.id} className="border-b border-line last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-3 px-4 py-3 text-body">
                <span className="font-mono tabular-nums text-hull">{r.code}</span>
                {r.id === editingId ? (
                  <Status tone="pending">Editing</Status>
                ) : (
                  <Status tone="active">Confirmed</Status>
                )}
                <span className="text-steel">
                  #{r.receiptSeq} · {r.receiveDate}
                  {r.unloadLocation === null ? '' : ` · ${r.unloadLocation}`}
                  {r.efrNo === null ? '' : ` · EFR ${r.efrNo}`}
                  {r.receivedByName === null ? '' : ` · ${r.receivedByName}`}
                </span>
                {mayEdit && editLock === null && editingId === null && (
                  <Button
                    variant="text"
                    size="inline"
                    className="ml-auto"
                    aria-label={`Edit ${r.code}`}
                    onClick={() => startEdit(r)}
                  >
                    Edit
                  </Button>
                )}
              </div>
              {r.correctionReason !== null && (
                <p className="-mt-1 px-4 pb-3 text-body text-steel">
                  Edited
                  {r.correctedAt === null ? '' : ` ${inDhaka(r.correctedAt)}`}
                  {r.correctedByName === null ? '' : ` by ${r.correctedByName}`}:{' '}
                  <span className="text-hull">{r.correctionReason}</span>
                </p>
              )}
              <ReceiptLines rows={r.rows} />
            </div>
          ))}
        </section>
      )}

      {/* ---------------------------------------------------- the header (§6.7) */}
      {editable && (
        <section
          ref={formRef}
          className="rounded-manifest border border-line bg-surface p-4 shadow-manifest"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-section text-hull">
              {editing !== null
                ? `Edit receipt ${editing.code}`
                : openReceipt === null
                  ? 'New receipt'
                  : `Receipt ${openReceipt.code}`}
            </h2>
            {editing !== null ? (
              <Status tone="pending">Editing</Status>
            ) : (
              openReceipt !== null && <Status tone="pending">Draft</Status>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Field id="receiveDate" label="Receive Date" required>
              <Input
                id="receiveDate"
                type="date"
                value={receiveDate}
                onChange={(e) => setReceiveDate(e.target.value)}
              />
            </Field>
            <Field id="unloadLocation" label="Unload Location">
              <Input
                id="unloadLocation"
                value={unloadLocation}
                onChange={(e) => setUnloadLocation(e.target.value)}
                placeholder="Warehouse or CFS"
              />
            </Field>
            <Field id="efrNo" label="EFR No">
              <Input id="efrNo" value={efrNo} onChange={(e) => setEfrNo(e.target.value)} />
            </Field>
          </div>
          {editing !== null && (
            <div className="mt-4">
              <Field id="editReason" label="Reason for the change" required>
                <Input
                  id="editReason"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="Gross weight was entered for the wrong PO"
                />
              </Field>
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------- booked · S/O · received (§5.5 r1) */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <h2 className="border-b border-line px-4 py-3 text-section text-hull">Cargo</h2>
        <div className="overflow-x-auto">
          <table
            className={`w-full ${showEntry ? 'min-w-[1400px]' : 'min-w-[700px]'} border-collapse text-cell`}
          >
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-2 py-2 text-left">PO</th>
                <th className="label-manifest px-2 py-2 text-left">Item</th>
                <th className="label-manifest px-2 py-2 text-left">SKU</th>
                <th className="label-manifest px-2 py-2 text-right">Booked</th>
                <th className="label-manifest px-2 py-2 text-right">S/O</th>
                <th className="label-manifest px-2 py-2 text-right">Already in</th>
                <th className="label-manifest px-2 py-2 text-right">Balance</th>
                {showEntry && (
                  <>
                    <th className="label-manifest px-2 py-2 text-right">Received</th>
                    <th className="label-manifest px-2 py-2 text-right">G.WT</th>
                    <th className="label-manifest px-2 py-2 text-right" colSpan={3}>
                      Carton (cm)
                    </th>
                    <th className="label-manifest px-2 py-2 text-left">Accept</th>
                    <th className="label-manifest px-2 py-2 text-left">Reason / remarks</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const d = drafts[row.cargoLineId] ?? emptyDraft();
                const typed = d.receivedCtnQty.trim() === '' ? null : Number(d.receivedCtnQty);
                // §5.5 rule 1: the variance, marked. Short is the ordinary case
                // and over is the one that needs a supervisor (rule 6).
                const short = typed !== null && d.lineStatus === 'ACCEPTED' && typed < row.balanceCtnQty;
                const over = typed !== null && d.lineStatus === 'ACCEPTED' && typed > row.balanceCtnQty;
                return (
                  <tr
                    key={row.cargoLineId}
                    className={
                      over ? 'bg-alert/5' : short ? 'bg-signal/5' : 'border-b border-line/60'
                    }
                  >
                    <td className="px-2 py-1 font-mono tabular-nums text-hull">{row.poNo}</td>
                    <td className="px-2 py-1">{row.itemCode}</td>
                    <td className="px-2 py-1">{row.sku ?? '—'}</td>
                    <td className="px-2 py-1 text-right">
                      <Fig value={row.bookedCtnQty} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Fig value={row.soCtnQty} />
                    </td>
                    <td className="px-2 py-1 text-right text-steel">
                      <Fig value={row.previouslyReceivedCtnQty} />
                    </td>
                    <td className="px-2 py-1 text-right font-medium">
                      <Fig value={row.balanceCtnQty} />
                    </td>
                    {showEntry && (
                      <>
                        <td className="px-2 py-1 text-right">
                          {editable ? (
                            <Input
                              aria-label={`Received cartons for ${row.poNo} ${row.itemCode}`}
                              numeric
                              value={d.receivedCtnQty}
                              onChange={(e) =>
                                edit(row.cargoLineId, {
                                  receivedCtnQty: e.target.value,
                                  ...(d.grossFollowsQty
                                    ? { receivedGrossWeightKg: bookedGrossFor(row, e.target.value) }
                                    : {}),
                                })
                              }
                              className="w-20"
                            />
                          ) : (
                            <Fig value={row.receivedCtnQty} />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {editable ? (
                            <Input
                              aria-label={`Received gross weight for ${row.poNo} ${row.itemCode}`}
                              numeric
                              value={d.receivedGrossWeightKg}
                              onChange={(e) =>
                                edit(row.cargoLineId, {
                                  receivedGrossWeightKg: e.target.value,
                                  grossFollowsQty: false,
                                })
                              }
                              className="w-24"
                            />
                          ) : (
                            <Fig value={row.receivedGrossWeightKg} dp={3} />
                          )}
                        </td>
                        {(['cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm'] as const).map(
                          (key, i) => (
                            <td key={key} className="px-1 py-1 text-right">
                              {editable ? (
                                <Input
                                  aria-label={`${['Length', 'Width', 'Height'][i]} for ${row.poNo} ${row.itemCode}`}
                                  numeric
                                  placeholder={['L', 'W', 'H'][i]}
                                  value={d[key]}
                                  onChange={(e) => edit(row.cargoLineId, { [key]: e.target.value })}
                                  className="w-16"
                                />
                              ) : (
                                <Fig value={row[key]} dp={3} />
                              )}
                            </td>
                          ),
                        )}
                        <td className="px-2 py-1">
                          {editable && mayDecline ? (
                            <label className="flex items-center gap-1.5 text-body">
                              <input
                                type="checkbox"
                                aria-label={`Decline ${row.poNo} ${row.itemCode}`}
                                checked={d.lineStatus === 'DECLINED'}
                                onChange={(e) =>
                                  edit(row.cargoLineId, {
                                    lineStatus: e.target.checked ? 'DECLINED' : 'ACCEPTED',
                                  })
                                }
                                className="size-4 accent-alert"
                              />
                              Decline
                            </label>
                          ) : (
                            <Status
                              tone={row.lineStatus === 'DECLINED' ? 'overdue' : 'active'}
                            >
                              {row.lineStatus ?? '—'}
                            </Status>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          {editable ? (
                            <Input
                              aria-label={`Reason for ${row.poNo} ${row.itemCode}`}
                              placeholder={
                                d.lineStatus === 'DECLINED' ? 'Why is it declined?' : 'Remarks'
                              }
                              value={d.lineStatus === 'DECLINED' ? d.declineReason : d.remarks}
                              onChange={(e) =>
                                edit(
                                  row.cargoLineId,
                                  d.lineStatus === 'DECLINED'
                                    ? { declineReason: e.target.value }
                                    : { remarks: e.target.value },
                                )
                              }
                              className="w-56"
                            />
                          ) : (
                            <span className="text-steel">
                              {row.declineReason ?? row.remarks ?? '—'}
                            </span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* §6.7's balance strip, and §5.5 rule 5's way out of it. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-4 py-3">
          <p className="text-body text-hull">
            {booking.status === 'SHORT_CLOSED' ? (
              <>
                <span className="font-medium">Short closed.</span> {booking.shortCloseReason}
                {' — '}
                {describeBalance(grid)}
              </>
            ) : (
              describeBalance(grid)
            )}
          </p>
          {/*
            §5.5 rule 5: a privileged user, and only while something is still
            owed. §7 keeps SHORT_CLOSE away from the warehouse clerk.
          */}
          {booking.status === 'PART_RECEIVED' &&
            editing === null &&
            grid.some((r) => r.balanceCtnQty > 0) &&
            can('OPERATION.CARGO_RECEIPT.SHORT_CLOSE') && (
              <Button
                variant="destructive"
                size="inline"
                onClick={() => {
                  setCloseReason('');
                  setError(null);
                  setClosing(true);
                }}
              >
                Short close
              </Button>
            )}
        </div>
      </section>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {editing !== null && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" disabled={isPending} onClick={cancelEdit}>
            Cancel
          </Button>
          <Button
            disabled={isPending || touched.length === 0 || editReason.trim() === ''}
            onClick={() => void saveEdit()}
          >
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}

      {editable && editing === null && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            disabled={isPending || touched.length === 0}
            onClick={() => void save(false)}
          >
            {isPending ? 'Saving…' : 'Save draft'}
          </Button>
          {can('OPERATION.CARGO_RECEIPT.CONFIRM') && (
            <Button disabled={isPending || touched.length === 0} onClick={() => setConfirming(true)}>
              Confirm receipt
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Confirm this receipt?"
        message={
          `${touched.length} line(s) will be recorded as received. ` +
          'The booking stays open while anything is still outstanding, and closes when nothing is.'
        }
        confirmLabel="Confirm receipt"
        isPending={isPending}
        onConfirm={() => void save(true)}
      />

      <Modal open={closing} onOpenChange={setClosing} title="Close the outstanding balance?">
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            {describeBalance(grid)} It stays on the record — nothing is deleted — but this
            booking stops waiting for it. Say why: this is what accounts and the customer will
            read later.
          </p>
          <Field id="closeReason" label="Reason" required>
            <Input
              id="closeReason"
              autoFocus
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="Exporter could not fill the container"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setClosing(false)}>
              Keep waiting
            </Button>
            <Button
              variant="destructive"
              disabled={isPending || closeReason.trim() === ''}
              onClick={() => void shortClose()}
            >
              {isPending ? 'Closing…' : 'Short close'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
