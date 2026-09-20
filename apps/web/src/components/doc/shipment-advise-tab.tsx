'use client';

import {
  ADVISE_STATUS_LABEL,
  type ShipmentAdviseDto,
  type ShipmentAdvisePrefillDto,
  type ShipmentDto,
  TRANSIT_TYPES,
} from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Shipment Advise — docs/MODULE_DOCUMENTATION.md §2.1 and §2.2, on the
 * shipment file.
 *
 * The PO grid is never edited here. It is pulled from the finalised CLP (sea)
 * or the confirmed receipts (air) and shown as it came — §3.2 makes the advise
 * a snapshot, and a grid a user could type into would be a document that says
 * whatever the last person to open it decided.
 *
 * What is editable is the header the client marked editable: "If required then
 * change the approved vsl schedule" (M15).
 */

type Header = {
  carrierId: string;
  transitType: string;
  firstVesselId: string;
  voyageNo: string;
  firstFlightNo: string;
  polId: string;
  podId: string;
  etd: string;
  eta: string;
  stuffingDate: string;
  mblNo: string;
};

const EMPTY_HEADER: Header = {
  carrierId: '',
  transitType: 'DIRECT',
  firstVesselId: '',
  voyageNo: '',
  firstFlightNo: '',
  polId: '',
  podId: '',
  etd: '',
  eta: '',
  stuffingDate: '',
  mblNo: '',
};

/** `2026-09-20T08:00:00.000Z` -> `2026-09-20T08:00`, for datetime-local. */
function toLocalInput(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (value.trim() === '') return null;
  return new Date(value).toISOString();
}

function headerFrom(source: ShipmentAdviseDto | ShipmentAdvisePrefillDto): Header {
  return {
    carrierId: source.carrierId,
    transitType: source.transitType,
    firstVesselId: source.firstVesselId ?? '',
    voyageNo: source.voyageNo ?? '',
    firstFlightNo: source.firstFlightNo ?? '',
    polId: source.polId,
    podId: source.podId,
    etd: toLocalInput(source.etd),
    eta: toLocalInput(source.eta),
    stuffingDate: source.stuffingDate ?? '',
    mblNo: source.mblNo ?? '',
  };
}

export function ShipmentAdviseTab({
  booking,
  onChanged,
}: {
  booking: ShipmentDto;
  onChanged: () => void;
}) {
  const { authorizedRequest, authorizedObjectUrl, can } = useSession();
  const isAir = booking.shipmentType === 'AIR';

  const [advise, setAdvise] = useState<ShipmentAdviseDto | null>(null);
  const [prefill, setPrefill] = useState<ShipmentAdvisePrefillDto | null>(null);
  const [header, setHeader] = useState<Header>(EMPTY_HEADER);
  const [loaded, setLoaded] = useState(false);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [note, setNote] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const load = useCallback(async () => {
    setLoaded(false);
    try {
      const row = await authorizedRequest<ShipmentAdviseDto | null>(
        `/api/tenant/documentation/bookings/${booking.id}/advise`,
      );
      setAdvise(row);
      if (row !== null) {
        setHeader(headerFrom(row));
        setSendTo(row.recipients.map((r) => r.email).join(', '));
        setPrefill(null);
      } else if (can('DOCUMENTATION.SHIPMENT_ADVISE.CREATE')) {
        const draft = await authorizedRequest<ShipmentAdvisePrefillDto>(
          `/api/tenant/documentation/bookings/${booking.id}/advise/prefill`,
        );
        setPrefill(draft);
        setHeader(headerFrom(draft));
        setSendTo(draft.recipients.map((r) => r.email).join(', '));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the shipment advise.');
    } finally {
      setLoaded(true);
    }
  }, [authorizedRequest, booking.id, can]);

  useEffect(() => {
    void load();
  }, [load]);

  function headerBody(): Record<string, unknown> {
    return {
      carrierId: header.carrierId,
      transitType: header.transitType,
      firstVesselId: header.firstVesselId === '' ? null : header.firstVesselId,
      voyageNo: header.voyageNo === '' ? null : header.voyageNo,
      firstFlightNo: header.firstFlightNo === '' ? null : header.firstFlightNo,
      polId: header.polId,
      podId: header.podId,
      etd: fromLocalInput(header.etd),
      eta: fromLocalInput(header.eta),
      stuffingDate: header.stuffingDate === '' ? null : header.stuffingDate,
      mblNo: header.mblNo === '' ? null : header.mblNo,
    };
  }

  async function run(fn: () => Promise<void>, done: string): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await fn();
      toast.success(done);
      setSendOpen(false);
      setCancelOpen(false);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setPending(false);
    }
  }

  const source = advise ?? prefill;
  const lines = source?.lines ?? [];
  const totals = source?.totals;

  if (!loaded) return <p className="text-body text-steel">Loading…</p>;

  if (advise === null && prefill === null) {
    return (
      <EmptyState
        title="No shipment advise yet"
        description="You do not have permission to create one on this booking."
      />
    );
  }

  if (advise === null && prefill?.blockedReason != null) {
    return (
      <EmptyState title="Not ready to advise" description={prefill.blockedReason} />
    );
  }

  const editable = advise === null || advise.status === 'DRAFT';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-section text-hull">
            {advise === null ? 'New shipment advise' : advise.code}
          </h2>
          {advise !== null && (
            <Status tone={advise.status === 'SENT' ? 'active' : 'pending'}>
              {ADVISE_STATUS_LABEL[advise.status]}
            </Status>
          )}
        </div>
        {advise !== null && (
          <p className="font-mono text-cell tabular-nums text-steel">
            {isAir ? 'HAWB' : 'House BL'} {advise.houseBlNo}
          </p>
        )}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      {/* B12–B14: the header, prefilled from the approved schedule. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field id="adviseCarrier" label={isAir ? 'Airline' : 'Carrier'}>
          <Input id="adviseCarrier" value={source?.carrierName ?? ''} readOnly disabled />
        </Field>
        <Field id="adviseTransitType" label="Transit type">
          <Select
            id="adviseTransitType"
            value={header.transitType}
            disabled={!editable}
            onChange={(e) => setHeader({ ...header, transitType: e.target.value })}
          >
            {TRANSIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'DIRECT' ? 'Direct' : 'Indirect'}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="adviseLeg" label={isAir ? '1st leg flight' : '1st leg vessel'}>
          <Input
            value={isAir ? header.firstFlightNo : (source?.firstVesselName ?? '')}
            readOnly={!isAir || !editable}
            disabled={!isAir && !editable}
            onChange={(e) => setHeader({ ...header, firstFlightNo: e.target.value })}
          />
        </Field>
        {!isAir && (
          <Field id="adviseVoyageNo" label="Voyage no">
            <Input
              value={header.voyageNo}
              disabled={!editable}
              onChange={(e) => setHeader({ ...header, voyageNo: e.target.value })}
            />
          </Field>
        )}
        <Field id="advisePol" label={isAir ? 'AOL' : 'POL'}>
          <Input id="advisePol" value={source?.polName ?? ''} readOnly disabled />
        </Field>
        <Field id="advisePod" label={isAir ? 'AOD' : 'POD'}>
          <Input id="advisePod" value={source?.podName ?? ''} readOnly disabled />
        </Field>
        <Field id="adviseEtd" label={isAir ? 'Departure date & time' : 'ETD'}>
          <Input
            type="datetime-local"
            value={header.etd}
            disabled={!editable}
            onChange={(e) => setHeader({ ...header, etd: e.target.value })}
          />
        </Field>
        <Field id="adviseEta" label={isAir ? 'Arrival date & time' : 'ETA'}>
          <Input
            type="datetime-local"
            value={header.eta}
            disabled={!editable}
            onChange={(e) => setHeader({ ...header, eta: e.target.value })}
          />
        </Field>
        {isAir && (
          <Field
            id="adviseStuffingDate"
            label="Stuffing date"
            hint="Air has no container load plan to read this from — open question 2."
          >
            <Input
              type="date"
              value={header.stuffingDate}
              disabled={!editable}
              onChange={(e) => setHeader({ ...header, stuffingDate: e.target.value })}
            />
          </Field>
        )}
        <Field
          id="adviseMblNo"
          label={isAir ? 'MAWB no' : 'MBL no'}
          hint="Typed — it comes from the carrier."
        >
          <Input
            value={header.mblNo}
            disabled={advise?.status === 'CANCELLED'}
            onChange={(e) => setHeader({ ...header, mblNo: e.target.value })}
          />
        </Field>
      </div>

      {/* Row 17's grid, pulled and shown as it came. */}
      <div className="overflow-x-auto rounded-manifest border border-line">
        <table className="w-full border-collapse text-cell">
          <thead>
            <tr className="bg-paper text-left label-manifest">
              <th className="px-3 py-2">PO</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2 text-right">CTN</th>
              <th className="px-3 py-2 text-right">PCS</th>
              <th className="px-3 py-2 text-right">N.WT</th>
              <th className="px-3 py-2 text-right">G.WT</th>
              <th className="px-3 py-2 text-right">CBM</th>
              {isAir && <th className="px-3 py-2 text-right">Chargeable</th>}
              <th className="px-3 py-2">Cargo rcvd</th>
              <th className="px-3 py-2">Stuffed</th>
              <th className="px-3 py-2">EFR</th>
              {!isAir && <th className="px-3 py-2">Container</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-line">
                <td className="px-3 py-2 font-mono tabular-nums">{line.poNo}</td>
                <td className="px-3 py-2">{line.itemCode}</td>
                <td className="px-3 py-2">{line.sku ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{line.ctnQty}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {line.pcsQty ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {line.netWeightKg ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {line.grossWeightKg ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {line.volumeCbm ?? '—'}
                </td>
                {isAir && (
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {line.chargeableWtKg ?? '—'}
                  </td>
                )}
                <td className="px-3 py-2 font-mono tabular-nums">
                  {line.cargoReceiptDate ?? '—'}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">{line.stuffingDate ?? '—'}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{line.efrNo ?? '—'}</td>
                {!isAir && (
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {line.containerNo ?? line.clpCode ?? '—'}
                  </td>
                )}
              </tr>
            ))}
            {/* Row 21 — the totals line, as the client drew it. */}
            {totals !== undefined && (
              <tr className="border-t-2 border-line bg-paper font-semibold">
                <td className="px-3 py-2">{totals.poCount} PO</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right font-mono tabular-nums">{totals.ctnQty}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {totals.pcsQty ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {totals.netWeightKg ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {totals.grossWeightKg ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {totals.volumeCbm ?? '—'}
                </td>
                {isAir && (
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {totals.chargeableWtKg ?? '—'}
                  </td>
                )}
                <td className="px-3 py-2" colSpan={isAir ? 3 : 4} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        {advise === null && can('DOCUMENTATION.SHIPMENT_ADVISE.CREATE') && (
          <Button
            disabled={isPending}
            onClick={() => {
              void run(
                () =>
                  authorizedRequest(
                    `/api/tenant/documentation/bookings/${booking.id}/advise`,
                    { method: 'POST', body: headerBody() },
                  ),
                'Shipment advise saved',
              );
            }}
          >
            Save
          </Button>
        )}
        {advise !== null && editable && can('DOCUMENTATION.SHIPMENT_ADVISE.EDIT') && (
          <Button
            disabled={isPending}
            onClick={() => {
              void run(
                () =>
                  authorizedRequest(`/api/tenant/documentation/shipment-advise/${advise.id}`, {
                    method: 'PATCH',
                    body: headerBody(),
                  }),
                'Saved',
              );
            }}
          >
            Save changes
          </Button>
        )}
        {advise !== null && editable && can('DOCUMENTATION.SHIPMENT_ADVISE.BUILD') && (
          <Button
            variant="secondary"
            disabled={isPending}
            onClick={() => {
              void run(
                () =>
                  authorizedRequest(
                    `/api/tenant/documentation/shipment-advise/${advise.id}/build`,
                    { method: 'POST', body: {} },
                  ),
                'PO grid rebuilt from the load plan',
              );
            }}
          >
            Re-pull PO grid
          </Button>
        )}
        {advise !== null && editable && can('DOCUMENTATION.SHIPMENT_ADVISE.SEND') && (
          <Button variant="secondary" disabled={isPending} onClick={() => setSendOpen(true)}>
            Save &amp; Send
          </Button>
        )}
        {/*
          B26's third button. Behind the same auth as everything else, so it
          cannot be a bare href — the token has to travel with the request, and
          the blob it hands back is what the new tab opens.
        */}
        {advise !== null && can('DOCUMENTATION.SHIPMENT_ADVISE.EXPORT_PDF') && (
          <Button
            variant="secondary"
            disabled={isPending}
            onClick={() => {
              void (async () => {
                try {
                  const url = await authorizedObjectUrl(
                    `/api/tenant/documentation/shipment-advise/${advise.id}/pdf`,
                  );
                  window.open(url, '_blank', 'noopener');
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : 'Could not open the advise.');
                }
              })();
            }}
          >
            Download &amp; Print
          </Button>
        )}
        {advise !== null &&
          advise.status !== 'CANCELLED' &&
          can('DOCUMENTATION.SHIPMENT_ADVISE.CANCEL') && (
            <Button variant="destructive" disabled={isPending} onClick={() => setCancelOpen(true)}>
              Cancel advise
            </Button>
          )}
      </div>

      {advise?.status === 'SENT' && (
        <p className="text-cell text-steel">
          Sent {advise.sentAt?.slice(0, 10)} by {advise.sentByName ?? 'the system'}. A sent advise
          cannot be edited — cancel it and issue another.
        </p>
      )}

      <Modal open={sendOpen} onOpenChange={setSendOpen} title="Send the shipment advise">
        <div className="flex flex-col gap-4">
          <Field id="sendTo" label="To" hint="The customer's contacts, comma separated." required>
            <Input id="sendTo" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
          </Field>
          <Field id="sendNote" label="Note" hint="Added to the letter. Optional.">
            <Input id="sendNote" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <p className="text-cell text-steel">
            Subject: Shipment Advise of Booking no : {booking.code}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSendOpen(false)}>
              Back
            </Button>
            <Button
              disabled={isPending || sendTo.trim() === '' || advise === null}
              onClick={() => {
                if (advise === null) return;
                void run(
                  () =>
                    authorizedRequest(
                      `/api/tenant/documentation/shipment-advise/${advise.id}/send`,
                      {
                        method: 'POST',
                        body: {
                          to: sendTo
                            .split(',')
                            .map((e) => e.trim())
                            .filter((e) => e !== '')
                            .map((email) => ({ email })),
                          note: note === '' ? null : note,
                        },
                      },
                    ),
                  'Shipment advise sent',
                );
              }}
            >
              {isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel this shipment advise?">
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            The House BL number stays on the cancelled advise forever. A number the customer has
            already seen is never given to another shipment.
          </p>
          <Field id="adviseCancelReason" label="Reason" required>
            <Input
              id="adviseCancelReason"
              autoFocus
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Wrong vessel on the advise"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={isPending || cancelReason.trim() === '' || advise === null}
              onClick={() => {
                if (advise === null) return;
                void run(
                  () =>
                    authorizedRequest(
                      `/api/tenant/documentation/shipment-advise/${advise.id}/cancel`,
                      { method: 'POST', body: { reason: cancelReason.trim() } },
                    ),
                  'Advise cancelled',
                );
              }}
            >
              {isPending ? 'Cancelling…' : 'Cancel it'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
