'use client';

import {
  describeBalance,
  type CargoReceiptDto,
  type ReceiptGridRow,
  type ShipmentDto,
} from '@ff/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
});

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
});

const today = (): string => new Date().toISOString().slice(0, 10);

function Fig({ value, dp = 0 }: { value: number | string | null; dp?: number }) {
  if (value === null || value === '') return <span className="text-steel">—</span>;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return <span className="text-steel">—</span>;
  return <span className="font-mono tabular-nums">{n.toFixed(dp)}</span>;
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

  const load = useCallback(async () => {
    try {
      const data = await authorizedRequest<{
        receipts: CargoReceiptDto[];
        grid: ReceiptGridRow[];
      }>(`/api/tenant/ops/bookings/${booking.id}/cargo-receipts`);
      setReceipts(data.receipts);
      setGrid(data.grid);

      const open = data.receipts.find((r) => r.status === 'DRAFT') ?? null;
      if (open !== null) {
        setReceiveDate(open.receiveDate);
        setUnloadLocation(open.unloadLocation ?? '');
        setEfrNo(open.efrNo ?? '');
      }
      setDrafts(
        Object.fromEntries(
          data.grid.map((row) => [
            row.cargoLineId,
            row.receiptLineId === null ? emptyDraft() : fromRow(row),
          ]),
        ),
      );
    } catch {
      setGrid([]);
    } finally {
      setLoaded(true);
    }
  }, [authorizedRequest, booking.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openReceipt = receipts.find((r) => r.status === 'DRAFT') ?? null;
  const confirmed = receipts.filter((r) => r.status === 'CONFIRMED');
  const receivable = ['SO_ISSUED', 'SO_SKIPPED', 'PART_RECEIVED'].includes(booking.status);
  const mayRecord = can('OPERATION.CARGO_RECEIPT.CREATE');
  const mayDecline = can('OPERATION.CARGO_RECEIPT.DECLINE_LINE');
  const editable = receivable && mayRecord;

  /** Rows the receiver has actually put a figure against. */
  const touched = useMemo(
    () =>
      grid.filter((row) => {
        const d = drafts[row.cargoLineId];
        return d !== undefined && d.receivedCtnQty.trim() !== '';
      }),
    [drafts, grid],
  );

  function edit(id: string, patch: Partial<Draft>): void {
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));
  }

  async function save(thenConfirm: boolean): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const saved = await authorizedRequest<CargoReceiptDto>(
        `/api/tenant/ops/bookings/${booking.id}/cargo-receipts`,
        {
          method: 'POST',
          body: {
            receiveDate,
            unloadLocation: unloadLocation.trim() === '' ? null : unloadLocation.trim(),
            efrNo: efrNo.trim() === '' ? null : efrNo.trim(),
            lines: touched.map((row) => {
              const d = drafts[row.cargoLineId]!;
              const opt = (v: string): string | undefined =>
                v.trim() === '' ? undefined : v.trim();
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
              };
            }),
          },
        },
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
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <h2 className="mb-3 text-section text-hull">Receipts so far</h2>
          <ul className="flex flex-col gap-2">
            {confirmed.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-3 text-body">
                <span className="font-mono tabular-nums text-hull">{r.code}</span>
                <Status tone="active">Confirmed</Status>
                <span className="text-steel">
                  #{r.receiptSeq} · {r.receiveDate}
                  {r.unloadLocation === null ? '' : ` · ${r.unloadLocation}`}
                  {r.receivedByName === null ? '' : ` · ${r.receivedByName}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------------------------------------------- the header (§6.7) */}
      {editable && (
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-section text-hull">
              {openReceipt === null ? 'New receipt' : `Receipt ${openReceipt.code}`}
            </h2>
            {openReceipt !== null && <Status tone="pending">Draft</Status>}
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
        </section>
      )}

      {/* ------------------------------------- booked · S/O · received (§5.5 r1) */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <h2 className="border-b border-line px-4 py-3 text-section text-hull">Cargo</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1400px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-2 py-2 text-left">PO</th>
                <th className="label-manifest px-2 py-2 text-left">Item</th>
                <th className="label-manifest px-2 py-2 text-left">SKU</th>
                <th className="label-manifest px-2 py-2 text-right">Booked</th>
                <th className="label-manifest px-2 py-2 text-right">S/O</th>
                <th className="label-manifest px-2 py-2 text-right">Already in</th>
                <th className="label-manifest px-2 py-2 text-right">Balance</th>
                <th className="label-manifest px-2 py-2 text-right">Received</th>
                <th className="label-manifest px-2 py-2 text-right">G.WT</th>
                <th className="label-manifest px-2 py-2 text-right" colSpan={3}>
                  Carton (cm)
                </th>
                <th className="label-manifest px-2 py-2 text-left">Accept</th>
                <th className="label-manifest px-2 py-2 text-left">Reason / remarks</th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => {
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
                    <td className="px-2 py-1 text-right">
                      {editable ? (
                        <Input
                          aria-label={`Received cartons for ${row.poNo} ${row.itemCode}`}
                          numeric
                          value={d.receivedCtnQty}
                          onChange={(e) => edit(row.cargoLineId, { receivedCtnQty: e.target.value })}
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
                            edit(row.cargoLineId, { receivedGrossWeightKg: e.target.value })
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

      {editable && (
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
