'use client';

import {
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_TABS,
  type ShipmentActivityDto,
  type ShipmentDto,
  type ShipmentScheduleDto,
  type ShipmentStatus,
  type ShipmentTabId,
  SCHEDULE_STATUS_LABEL,
  isShipmentTab,
  sumCargoTotals,
} from '@ff/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ApprovalTab } from '@/components/cs/approval-tab';
import { CargoReceiptTab } from '@/components/cs/cargo-receipt-tab';
import { ScheduleScreen } from '@/components/cs/schedule-screen';
import { ShippingOrderTab } from '@/components/cs/shipping-order-tab';
import { ShipmentBookingScreen } from '@/components/cs/shipment-booking-screen';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The shipment file — §6.3.
 *
 * §2.1 calls this the spine of the system: eleven later modules hang off the
 * booking, and this is where the operations team will meet all of them. So the
 * tabs that do not exist yet are rendered disabled rather than hidden — §6.3 is
 * explicit about it: "do not hide them; the operations team needs to see the
 * shape of the file."
 *
 * The tab lives in the URL so a colleague can be sent to one, and so the back
 * button behaves the way anyone would expect on a record this large.
 */

const TONE: Record<ShipmentStatus, 'active' | 'pending' | 'inactive' | 'overdue'> = {
  BOOKING_RECEIVED: 'pending',
  VESSEL_PROPOSED: 'pending',
  APPROVED_FOR_SHIPMENT: 'active',
  REJECTED: 'overdue',
  SO_ISSUED: 'active',
  SO_SKIPPED: 'active',
  PART_RECEIVED: 'pending',
  CARGO_RECEIVED: 'active',
  SHORT_CLOSED: 'inactive',
  CANCELLED: 'overdue',
};

function Cell({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="label-manifest">{label}</dt>
      <dd className="text-body text-hull">{value === null || value === '' ? '—' : value}</dd>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="label-manifest">{label}</dt>
      <dd className="font-mono tabular-nums text-body text-hull">{value}</dd>
    </div>
  );
}

export function ShipmentFileScreen({ shipmentId }: { shipmentId: string }) {
  const { authorizedRequest } = useSession();
  const router = useRouter();
  const params = useSearchParams();

  const raw = params.get('tab') ?? 'overview';
  const tab: ShipmentTabId = isShipmentTab(raw) ? raw : 'overview';

  const [booking, setBooking] = useState<ShipmentDto | null>(null);
  const [schedules, setSchedules] = useState<ShipmentScheduleDto[]>([]);
  const [activities, setActivities] = useState<ShipmentActivityDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [row, versions] = await Promise.all([
        authorizedRequest<ShipmentDto>(`/api/tenant/cs/bookings/${shipmentId}`),
        authorizedRequest<ShipmentScheduleDto[]>(
          `/api/tenant/cs/bookings/${shipmentId}/schedules`,
        ),
      ]);
      setBooking(row);
      setSchedules(versions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this booking.');
    }
  }, [authorizedRequest, shipmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The trail is only fetched when somebody opens it — it is the longest
  // response on the file and nobody reads it by accident.
  useEffect(() => {
    if (tab !== 'activities') return;
    void authorizedRequest<ShipmentActivityDto[]>(
      `/api/tenant/cs/bookings/${shipmentId}/activities`,
    )
      .then(setActivities)
      .catch(() => setActivities([]));
  }, [authorizedRequest, shipmentId, tab]);

  function go(next: ShipmentTabId): void {
    router.replace(`/cs/shipment-booking/${shipmentId}?tab=${next}`, { scroll: false });
  }

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Shipment file" description="" />
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
        <Link href="/cs/shipment-booking-sea" className="text-body text-harbour hover:underline">
          ← Back to the booking list
        </Link>
      </div>
    );
  }
  if (booking === null) return <p className="text-body text-steel">Loading…</p>;

  const isAir = booking.shipmentType === 'AIR';
  const live = schedules.find((s) => s.status === 'PROPOSED' || s.status === 'APPROVED') ?? null;
  const totals = sumCargoTotals(
    booking.cargoLines.map((l) => ({
      ctnQty: l.ctnQty,
      pcsQty: l.pcsQty,
      netWeightKg: l.netWeightKg === null ? null : Number(l.netWeightKg),
      grossWeightKg: l.grossWeightKg === null ? null : Number(l.grossWeightKg),
      cartonLengthCm: l.cartonLengthCm === null ? null : Number(l.cartonLengthCm),
      cartonWidthCm: l.cartonWidthCm === null ? null : Number(l.cartonWidthCm),
      cartonHeightCm: l.cartonHeightCm === null ? null : Number(l.cartonHeightCm),
    })),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={`Booking ${booking.code}`}
          description={`${isAir ? 'Air' : 'Sea'} · ${booking.customerName} · against quotation ${booking.quotationCode}`}
        />
        <Status tone={TONE[booking.status]}>{SHIPMENT_STATUS_LABEL[booking.status]}</Status>
      </div>

      {/* ------------------------------------------------------------- tabs */}
      <nav aria-label="Shipment file" className="border-b border-line">
        <ul className="flex flex-wrap gap-1">
          {SHIPMENT_TABS.map((entry) => {
            const active = entry.id === tab;
            if (!entry.live) {
              return (
                <li key={entry.id}>
                  {/*
                    §6.3: shown, not hidden. A disabled tab tells the operations
                    team what the file will hold; an absent one tells them
                    nothing and gets asked about instead.
                  */}
                  <span
                    aria-disabled="true"
                    title="Coming soon"
                    className="inline-block cursor-default border-b-2 border-transparent px-3 py-2 text-body text-steel/50"
                  >
                    {entry.label}
                  </span>
                </li>
              );
            }
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => go(entry.id)}
                  className={
                    active
                      ? 'border-b-2 border-harbour px-3 py-2 text-body font-medium text-hull'
                      : 'border-b-2 border-transparent px-3 py-2 text-body text-steel hover:text-hull'
                  }
                >
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ---------------------------------------------------------- overview */}
      {tab === 'overview' && (
        <div className="flex flex-col gap-4">
          <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
            <h2 className="mb-3 text-section text-hull">The shipment</h2>
            <dl className="grid gap-4 md:grid-cols-4">
              <Cell label="Quotation No" value={booking.quotationCode} />
              <Cell label="Customer" value={booking.customerName} />
              <Cell label="Exporter" value={booking.exporterName} />
              <Cell label="Importer" value={booking.importerName} />
              <Cell label={isAir ? 'Airlines' : 'Carrier'} value={booking.carrierName} />
              <Cell label={isAir ? 'AOL' : 'POL'} value={booking.polName} />
              <Cell label={isAir ? 'AOD' : 'POD'} value={booking.podName} />
              <Cell label="Transit Type" value={booking.transitType} />
              <Cell label="ETD" value={booking.etd} />
              <Cell label="ETA" value={booking.eta} />
              <Cell label="Goods hand over" value={booking.goodsHandoverDate} />
              <Cell
                label="Commodity"
                value={booking.commodities.map((c) => c.commodityName).join(', ')}
              />
            </dl>
          </section>

          <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
            <h2 className="mb-3 text-section text-hull">Cargo</h2>
            <dl className="grid gap-4 md:grid-cols-5">
              <Figure label="POs" value={booking.pos.length} />
              <Figure label="Lines" value={booking.cargoLines.length} />
              <Figure label="Total CTN" value={totals.ctnQty} />
              <Figure label="Total G.WT" value={`${totals.grossWeightKg} kg`} />
              {isAir ? (
                <Figure label="Chargeable WT" value={`${totals.chargeableWtKg} kg`} />
              ) : (
                <Figure label="Total CBM" value={totals.volumeCbm} />
              )}
            </dl>
          </section>

          {booking.status === 'CANCELLED' && (
            <p className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-hull">
              <span className="font-medium">Cancelled.</span> {booking.cancelReason}
            </p>
          )}
        </div>
      )}

      {/* ----------------------------------------------- the existing screens */}
      {tab === 'booking' && <ShipmentBookingScreen shipmentId={shipmentId} embedded />}
      {tab === 'schedule' && <ScheduleScreen shipmentId={shipmentId} embedded />}

      {/* ---------------------------------------------------------- approval */}
      {tab === 'approval' && (
        <ApprovalTab booking={booking} schedule={live} onDecided={() => void load()} />
      )}

      {/* ---------------------------------------------------- shipping order */}
      {tab === 'shipping-order' && (
        <ShippingOrderTab booking={booking} onChanged={() => void load()} />
      )}

      {/* ------------------------------------------------------ cargo receipt */}
      {tab === 'cargo-receipt' && (
        <CargoReceiptTab booking={booking} onChanged={() => void load()} />
      )}

      {/* -------------------------------------------------------- activities */}
      {tab === 'activities' && (
        <section className="rounded-manifest border border-line bg-surface shadow-manifest">
          <h2 className="border-b border-line px-4 py-3 text-section text-hull">
            Everything that has happened to this file
          </h2>
          {activities.length === 0 ? (
            <p className="px-4 py-6 text-body text-steel">Loading the trail…</p>
          ) : (
            <ol className="divide-y divide-line/60">
              {activities.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                  <span className="w-40 shrink-0 font-mono tabular-nums text-cell text-steel">
                    {new Date(event.at).toLocaleString()}
                  </span>
                  <span className="text-body text-hull">{event.summary}</span>
                  {event.detail !== null && (
                    <span className="font-mono text-cell text-steel">{event.detail}</span>
                  )}
                  <span className="ml-auto text-cell text-steel">
                    {event.actorName ?? 'system'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* The live schedule, summarised under whichever tab is showing it. */}
      {tab === 'overview' && live !== null && (
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <h2 className="mb-3 text-section text-hull">Current schedule</h2>
          <div className="flex flex-wrap items-baseline gap-3 text-body">
            <span className="font-mono tabular-nums text-hull">v{live.versionNo}</span>
            <Status tone={live.status === 'APPROVED' ? 'active' : 'pending'}>
              {SCHEDULE_STATUS_LABEL[live.status]}
            </Status>
            <span className="text-steel">
              {live.legs.map((l) => `${l.originPortName} → ${l.destinationPortName}`).join(', then ')}
            </span>
          </div>
        </section>
      )}

      <Link
        href={isAir ? '/cs/shipment-booking-air' : '/cs/shipment-booking-sea'}
        className="text-body text-harbour hover:underline"
      >
        ← Back to the booking list
      </Link>
    </div>
  );
}
