'use client';

import {
  checkLegContinuity,
  LEGS_ALLOWED,
  SCHEDULE_STATUS_LABEL,
  type ScheduleLegInput,
  type ShipmentScheduleDto,
  TRANSIT_TYPES,
} from '@ff/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Vessel / Flight Booking — §6.4, one screen for both modes.
 *
 * The wireframe draws two forms, one per transit type. §6.4 says not to build
 * them that way: "drive it from `transit_type` rather than showing two separate
 * forms as the wireframe draws them". So Direct is the same grid holding one
 * leg, and switching to Indirect adds a second.
 *
 * The continuity rules are the point of the screen. A schedule where leg 2
 * starts somewhere leg 1 did not end, or departs before leg 1 lands, cannot
 * physically happen — and §6.4 says it should not reach the customer. They are
 * checked live from the same function the API refuses with, so the screen and
 * the server never disagree about what is valid.
 */

interface Options {
  carriers: { id: string; name: string }[];
  ports: { id: string; name: string; portCode: string }[];
  vessels: { id: string; name: string }[];
}

interface Context {
  id: string;
  code: string;
  status: string;
  shipmentType: 'SEA' | 'AIR';
  transitType: 'DIRECT' | 'INDIRECT' | null;
  carrierId: string;
  carrierName: string;
  polId: string;
  podId: string;
  customerName: string;
  quotationCode: string;
  polName: string;
  podName: string;
  cargo: {
    lines: number;
    ctnQty: string;
    grossWeightKg: string;
    volumeCbm: string;
    chargeableWtKg: string;
  };
}

interface DraftLeg {
  key: string;
  vesselId: string;
  voyageNo: string;
  flightNo: string;
  flightTime: string;
  originPortId: string;
  destinationPortId: string;
  etd: string;
  eta: string;
}

let legSeed = 0;
const newLeg = (originPortId = '', destinationPortId = ''): DraftLeg => ({
  key: `leg-${(legSeed += 1)}`,
  vesselId: '',
  voyageNo: '',
  flightNo: '',
  flightTime: '',
  originPortId,
  destinationPortId,
  etd: '',
  eta: '',
});

/** `datetime-local` gives "2026-09-02T14:30"; the API wants a real instant. */
const toIso = (v: string): string | undefined =>
  v.trim() === '' ? undefined : new Date(v).toISOString();

export function ScheduleScreen({
  shipmentId,
  embedded = false,
}: {
  shipmentId: string;
  /** Inside §6.3's file, which already names the booking and shows the way back. */
  embedded?: boolean;
}) {
  const { authorizedRequest, can } = useSession();
  const router = useRouter();

  const [context, setContext] = useState<Context | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [history, setHistory] = useState<ShipmentScheduleDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setPending] = useState(false);

  const [carrierId, setCarrierId] = useState('');
  const [transitType, setTransitType] = useState<'DIRECT' | 'INDIRECT'>('DIRECT');
  const [cutOffDate, setCutOffDate] = useState('');
  const [vgmDate, setVgmDate] = useState('');
  const [siDate, setSiDate] = useState('');
  const [legs, setLegs] = useState<DraftLeg[]>([newLeg()]);

  const load = useCallback(async () => {
    try {
      const [ctx, opts, versions] = await Promise.all([
        authorizedRequest<Context>(`/api/tenant/cs/bookings/${shipmentId}/schedule-context`),
        authorizedRequest<Options>('/api/tenant/cs/booking-options'),
        authorizedRequest<ShipmentScheduleDto[]>(
          `/api/tenant/cs/bookings/${shipmentId}/schedules`,
        ),
      ]);
      setContext(ctx);
      setOptions(opts);
      setHistory(versions);
      setCarrierId(ctx.carrierId);
      setTransitType(ctx.transitType ?? 'DIRECT');
      // The booking's own ports seed the first leg — a direct sailing is
      // exactly POL to POD, and typing it again is a chance to get it wrong.
      setLegs([newLeg(ctx.polId, ctx.podId)]);
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'Could not load this booking.');
    }
  }, [authorizedRequest, shipmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const asInput = useCallback(
    (): ScheduleLegInput[] =>
      legs.map((leg, index) => ({
        legNo: index + 1,
        vesselId: leg.vesselId === '' ? undefined : leg.vesselId,
        voyageNo: leg.voyageNo.trim() === '' ? undefined : leg.voyageNo.trim(),
        flightNo: leg.flightNo.trim() === '' ? undefined : leg.flightNo.trim(),
        flightTime: leg.flightTime.trim() === '' ? undefined : leg.flightTime.trim(),
        originPortId: leg.originPortId,
        destinationPortId: leg.destinationPortId,
        etd: toIso(leg.etd),
        eta: toIso(leg.eta),
      })),
    [legs],
  );

  /** Live, from the same function the API refuses with (§6.4). */
  const problems = useMemo(() => {
    const ready = legs.every((l) => l.originPortId !== '' && l.destinationPortId !== '');
    if (!ready) return [];
    return checkLegContinuity(transitType, asInput());
  }, [asInput, legs, transitType]);

  const isAir = context?.shipmentType === 'AIR';
  const allowed = LEGS_ALLOWED[transitType];
  const maxLegs = Math.max(...allowed);

  function setTransit(next: 'DIRECT' | 'INDIRECT'): void {
    setTransitType(next);
    setLegs((current) => {
      if (next === 'DIRECT') return current.slice(0, 1);
      if (current.length >= 2) return current;
      // A second leg starts where the first one ends. §6.4's continuity rule,
      // applied as a default rather than left for the operator to discover.
      const first = current[0]!;
      return [...current, newLeg(first.destinationPortId, context?.podId ?? '')];
    });
  }

  function addLeg(): void {
    setLegs((current) => {
      if (current.length >= maxLegs) return current;
      const last = current[current.length - 1]!;
      return [...current, newLeg(last.destinationPortId, context?.podId ?? '')];
    });
  }

  function editLeg(key: string, patch: Partial<DraftLeg>): void {
    setLegs((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function save(): Promise<void> {
    setFormError(null);
    const found = checkLegContinuity(transitType, asInput());
    if (found.length > 0) {
      setFormError(found[0]!.message);
      return;
    }

    setPending(true);
    try {
      await authorizedRequest<ShipmentScheduleDto>(
        `/api/tenant/cs/bookings/${shipmentId}/schedules`,
        {
          method: 'POST',
          body: {
            carrierId,
            transitType,
            cutOffDate: toIso(cutOffDate) ?? null,
            // Never sent on air: the API refuses them there, so a value left
            // in state from a sea booking must not travel.
            vgmDate: isAir || vgmDate === '' ? null : vgmDate,
            siDate: isAir || siDate === '' ? null : siDate,
            legs: asInput(),
          },
        },
      );
      toast.success('Schedule proposed. The customer has been notified.');
      // Back to the file's Overview, where the new schedule is summarised.
      router.push(`/cs/shipment-booking/${shipmentId}?tab=overview`);
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not save this schedule.',
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Vessel / Flight Booking" description="" />
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (context === null || options === null) {
    return <p className="text-body text-steel">Loading…</p>;
  }

  const canPropose = can('CUSTOMER_SERVICE.SCHEDULE.CREATE');

  /*
   * The booking's own carrier, even when this workspace has switched that
   * shared row off since (§7A rule 7). Without it the select would not contain
   * the value it was handed, fall back to the first option, and change the
   * carrier the moment somebody saved.
   */
  const carrierOptions =
    options.carriers.some((c) => c.id === context.carrierId)
      ? options.carriers
      : [{ id: context.carrierId, name: `${context.carrierName} (no longer offered)` }, ...options.carriers];
  const portLabel = (which: 'from' | 'to'): string =>
    isAir ? (which === 'from' ? 'AOL' : 'AOD') : which === 'from' ? 'POL' : 'POD';

  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={isAir ? 'Flight Booking' : 'Vessel Booking'}
            description={`Booking ${context.code} · ${context.customerName}`}
          />
          <span className="font-mono tabular-nums text-body text-hull">{context.code}</span>
        </div>
      )}

      {/* ---------------------------------------- the booking, read-only (§6.4) */}
      <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <h2 className="mb-3 text-section text-hull">Booking</h2>
        <dl className="grid gap-4 md:grid-cols-4">
          {[
            ['Quotation No', context.quotationCode],
            ['Customer', context.customerName],
            [portLabel('from'), context.polName],
            [portLabel('to'), context.podName],
            ['Cargo lines', context.cargo.lines.toString()],
            ['Total CTN', context.cargo.ctnQty],
            ['Total G.WT', `${context.cargo.grossWeightKg} kg`],
            [isAir ? 'Chargeable WT' : 'Total CBM', isAir ? `${context.cargo.chargeableWtKg} kg` : context.cargo.volumeCbm],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd className="font-mono tabular-nums text-body text-hull">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ------------------------------------------------- what came before it */}
      {history.length > 0 && (
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <h2 className="mb-3 text-section text-hull">Earlier proposals</h2>
          <ul className="flex flex-col gap-2">
            {history.map((version) => (
              <li key={version.id} className="flex flex-wrap items-baseline gap-3 text-body">
                <span className="font-mono tabular-nums text-hull">v{version.versionNo}</span>
                <Status
                  tone={
                    version.status === 'REJECTED'
                      ? 'overdue'
                      : version.status === 'APPROVED'
                        ? 'active'
                        : version.status === 'PROPOSED'
                          ? 'pending'
                          : 'inactive'
                  }
                >
                  {SCHEDULE_STATUS_LABEL[version.status]}
                </Status>
                <span className="text-steel">
                  {version.legs.map((l) => `${l.originPortName} → ${l.destinationPortName}`).join(', then ')}
                </span>
                {/* §4.2: the customer must be able to see what they turned down
                    AND why, so the comment travels with the version. */}
                {version.rejectionComments !== null && (
                  <span className="text-alert">“{version.rejectionComments}”</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ----------------------------------------------------------- the form */}
      <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <h2 className="mb-3 text-section text-hull">
          {isAir ? 'Flight schedule' : 'Vessel schedule'}
        </h2>
        <div className="grid gap-4 md:grid-cols-4">
          <Field id="carrierId" label={isAir ? 'Airlines' : 'Carrier'} required>
            <Select
              id="carrierId"
              value={carrierId}
              disabled={!canPropose}
              onChange={(e) => setCarrierId(e.target.value)}
            >
              {carrierOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="transitType" label="Transit Type" required>
            <Select
              id="transitType"
              value={transitType}
              disabled={!canPropose}
              onChange={(e) => setTransit(e.target.value === 'INDIRECT' ? 'INDIRECT' : 'DIRECT')}
            >
              {TRANSIT_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {tt === 'DIRECT' ? 'Direct (one leg)' : 'Indirect (two or three legs)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="cutOffDate" label="Cut off">
            <Input
              id="cutOffDate"
              type="datetime-local"
              value={cutOffDate}
              disabled={!canPropose}
              onChange={(e) => setCutOffDate(e.target.value)}
            />
          </Field>
          {/*
            §9 Q4, answered 2026-09-03: both are sea only.

            VGM is SOLAS verified gross mass, a container weight declaration,
            and SI is the shipping instruction behind a bill of lading. The
            client drew both on the Flight Booking wireframe and has confirmed
            that was a slip. The columns stay — an air schedule leaves them
            null — and the API refuses them on an air booking.
          */}
          {!isAir && (
            <>
              <Field id="siDate" label="SI Date">
                <Input
                  id="siDate"
                  type="date"
                  value={siDate}
                  disabled={!canPropose}
                  onChange={(e) => setSiDate(e.target.value)}
                />
              </Field>
              <Field id="vgmDate" label="VGM Date">
                <Input
                  id="vgmDate"
                  type="date"
                  value={vgmDate}
                  disabled={!canPropose}
                  onChange={(e) => setVgmDate(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- legs */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-section text-hull">Legs</h2>
          {canPropose && transitType === 'INDIRECT' && legs.length < maxLegs && (
            <Button size="inline" onClick={addLeg}>
              Add leg
            </Button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-2 py-2 text-left">Leg</th>
                <th className="label-manifest px-2 py-2 text-left">
                  {isAir ? 'Airlines' : 'Vessel Name'}
                </th>
                <th className="label-manifest px-2 py-2 text-left">
                  {isAir ? 'Flight No' : 'Voyage'}
                </th>
                {isAir && <th className="label-manifest px-2 py-2 text-left">Flight Time</th>}
                <th className="label-manifest px-2 py-2 text-left">{portLabel('from')}</th>
                <th className="label-manifest px-2 py-2 text-left">{portLabel('to')}</th>
                <th className="label-manifest px-2 py-2 text-left">
                  {isAir ? 'Departure' : 'ETD'}
                </th>
                <th className="label-manifest px-2 py-2 text-left">
                  {isAir ? 'Arrival' : 'ETA'}
                </th>
                <th className="label-manifest px-2 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, index) => {
                const legNo = index + 1;
                const legProblems = problems.filter((p) => p.legNo === legNo);
                return (
                  <tr
                    key={leg.key}
                    className={legProblems.length > 0 ? 'bg-alert/5' : undefined}
                  >
                    <td className="px-2 py-2 font-mono tabular-nums text-hull">{legNo}</td>
                    <td className="px-2 py-2">
                      {isAir ? (
                        /*
                         * §4.2 gives a leg no airline of its own — the schedule
                         * carries the carrier, and that is the airline. Shown
                         * here because §6.4 draws the column, read-only because
                         * there is nothing per-leg to change.
                         */
                        <span className="text-steel">
                          {options.carriers.find((c) => c.id === carrierId)?.name ??
                            context.carrierName}
                        </span>
                      ) : (
                        <Select
                          aria-label={`Leg ${legNo} vessel`}
                          value={leg.vesselId}
                          disabled={!canPropose}
                          onChange={(e) => editLeg(leg.key, { vesselId: e.target.value })}
                          className="w-40"
                        >
                          <option value="">—</option>
                          {options.vessels.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Leg ${legNo} ${isAir ? 'flight number' : 'voyage'}`}
                        value={isAir ? leg.flightNo : leg.voyageNo}
                        disabled={!canPropose}
                        onChange={(e) =>
                          editLeg(leg.key, isAir ? { flightNo: e.target.value } : { voyageNo: e.target.value })
                        }
                        className="w-28"
                      />
                    </td>
                    {isAir && (
                      <td className="px-2 py-2">
                        <Input
                          aria-label={`Leg ${legNo} flight time`}
                          value={leg.flightTime}
                          disabled={!canPropose}
                          onChange={(e) => editLeg(leg.key, { flightTime: e.target.value })}
                          className="w-24"
                        />
                      </td>
                    )}
                    <td className="px-2 py-2">
                      <Select
                        aria-label={`Leg ${legNo} origin`}
                        value={leg.originPortId}
                        disabled={!canPropose}
                        onChange={(e) => editLeg(leg.key, { originPortId: e.target.value })}
                        className="w-44"
                      >
                        <option value="">—</option>
                        {options.ports.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} - {p.portCode}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-2">
                      <Select
                        aria-label={`Leg ${legNo} destination`}
                        value={leg.destinationPortId}
                        disabled={!canPropose}
                        onChange={(e) => editLeg(leg.key, { destinationPortId: e.target.value })}
                        className="w-44"
                      >
                        <option value="">—</option>
                        {options.ports.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} - {p.portCode}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Leg ${legNo} departure`}
                        type="datetime-local"
                        value={leg.etd}
                        disabled={!canPropose}
                        onChange={(e) => editLeg(leg.key, { etd: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Leg ${legNo} arrival`}
                        type="datetime-local"
                        value={leg.eta}
                        disabled={!canPropose}
                        onChange={(e) => editLeg(leg.key, { eta: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canPropose && legs.length > Math.min(...allowed) && (
                        <Button
                          variant="destructive"
                          size="inline"
                          onClick={() => setLegs((c) => c.filter((l) => l.key !== leg.key))}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* The problems, named against the leg they belong to (§6.4). */}
        {problems.length > 0 && (
          <ul
            role="alert"
            className="flex flex-col gap-1 border-t border-line bg-alert/5 px-4 py-3 text-body text-alert"
          >
            {problems.map((problem, i) => (
              <li key={`${problem.legNo}-${i}`}>
                {problem.legNo > 0 && <strong>Leg {problem.legNo}: </strong>}
                {problem.message}
              </li>
            ))}
          </ul>
        )}
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
          <Link
            href={`/cs/shipment-booking/${shipmentId}`}
            className="text-body text-harbour hover:underline"
          >
            ← Back to the booking
          </Link>
        )}
        {canPropose && (
          <Button disabled={isPending || problems.length > 0} onClick={() => void save()}>
            {isPending ? 'Saving…' : 'Propose to customer'}
          </Button>
        )}
      </div>
    </div>
  );
}
