'use client';

import { SCHEDULE_STATUS_LABEL, type ShipmentScheduleDto } from '@ff/shared';

import { Status } from '@/components/ui/status';

/**
 * A proposed schedule, in full.
 *
 * The Vessel Schedule tab and the Approval tab both showed a version number, a
 * carrier and a list of port pairs — which says a sailing exists without saying
 * which sailing. The details that decide whether to approve it are the vessel,
 * the voyage and the dates, and those were only ever visible to whoever was
 * typing them (client, 2026-09-13).
 *
 * One component so the two screens cannot drift: an approver and the person who
 * proposed it must be looking at the same page.
 */

/** "2026-09-14 08:30" — an instant, in the workspace's own reading order. */
function moment(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** Dates without a time of day — cut-off, VGM, SI. */
function day(iso: string | null): string {
  return iso === null ? '—' : iso.slice(0, 10);
}

export function ScheduleStatusDot({ status }: { status: ShipmentScheduleDto['status'] }) {
  return (
    <Status
      tone={
        status === 'REJECTED'
          ? 'overdue'
          : status === 'APPROVED'
            ? 'active'
            : status === 'PROPOSED'
              ? 'pending'
              : 'inactive'
      }
    >
      {SCHEDULE_STATUS_LABEL[status]}
    </Status>
  );
}

export function ScheduleDetail({
  schedule,
  isAir,
}: {
  schedule: ShipmentScheduleDto;
  /** Air legs carry a flight number and time where sea carries vessel and voyage. */
  isAir: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        {[
          [isAir ? 'Airline' : 'Carrier', schedule.carrierName],
          ['Transit', schedule.transitType === 'INDIRECT' ? 'Indirect' : 'Direct'],
          ['Cut-off', day(schedule.cutOffDate)],
          // §9 Q4: VGM and SI are sea-only, so on air they are not shown as
          // blank — they are not part of the document at all.
          ...(isAir
            ? []
            : ([
                ['VGM', day(schedule.vgmDate)],
                ['SI', day(schedule.siDate)],
              ] as [string, string][])),
          ['Proposed', moment(schedule.proposedAt)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="label-manifest">{label}</dt>
            <dd className="font-mono text-body tabular-nums text-hull">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto rounded-manifest border border-line">
        <table className="w-full min-w-[720px] border-collapse text-cell">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest px-3 py-2 text-left">Leg</th>
              <th className="label-manifest px-3 py-2 text-left">{isAir ? 'Flight' : 'Vessel'}</th>
              <th className="label-manifest px-3 py-2 text-left">
                {isAir ? 'Flight time' : 'Voyage'}
              </th>
              <th className="label-manifest px-3 py-2 text-left">From</th>
              <th className="label-manifest px-3 py-2 text-left">To</th>
              <th className="label-manifest px-3 py-2 text-left">ETD</th>
              <th className="label-manifest px-3 py-2 text-left">ETA</th>
            </tr>
          </thead>
          <tbody>
            {schedule.legs.map((leg) => (
              <tr key={leg.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2 font-mono tabular-nums text-steel">{leg.legNo}</td>
                <td className="px-3 py-2 text-hull">
                  {(isAir ? leg.flightNo : leg.vesselName) ?? (
                    <span className="text-steel">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-hull">
                  {(isAir ? leg.flightTime : leg.voyageNo) ?? (
                    <span className="text-steel">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-hull">{leg.originPortName}</td>
                <td className="px-3 py-2 text-hull">{leg.destinationPortName}</td>
                <td className="px-3 py-2 font-mono tabular-nums text-hull">{moment(leg.etd)}</td>
                <td className="px-3 py-2 font-mono tabular-nums text-hull">{moment(leg.eta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* §4.2: the customer must be able to see what they turned down AND why. */}
      {schedule.rejectionComments !== null && (
        <p className="text-body text-alert">
          <span className="label-manifest mr-2">Rejected</span>“{schedule.rejectionComments}”
        </p>
      )}
    </div>
  );
}
