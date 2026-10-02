'use client';

import {
  ADVISE_GROUP_MATCH_LABEL,
  type AdviseGroupBookingDto,
  type AdviseGroupDto,
  type AdviseGroupMatch,
} from '@ff/shared';

import { Button } from '@/components/ui/button';
import { Status, type StatusTone } from '@/components/ui/status';

/**
 * CR-005 — the bookings that share this advise's EFR.
 *
 * The client's rule: bookings of one quotation received under the same EFR No
 * get one Shipment Advise and one BL. This panel is where the operator sees
 * that rule applied, so nothing is merged behind their back:
 *
 *   - a booking that fully matches is on the advise, and cannot be taken off;
 *   - a booking whose shipper or consignee differs is offered, unticked, with
 *     the difference spelled out — often one company typed twice;
 *   - a booking on another sailing, or received under two EFRs, is listed as
 *     kept apart, with why;
 *   - a booking not ready yet says what it is waiting for.
 */

/** Where the advise is in its life — what the panel may offer. */
export type AdvisePanelMode = 'new' | 'draft' | 'sent' | 'cancelled';

const TONE: Record<AdviseGroupMatch, StatusTone> = {
  LEAD: 'active',
  FULL: 'active',
  WARN: 'pending',
  REFUSED: 'inactive',
};

/** Free to join now: ready, and on no other advise. */
export function isFree(b: AdviseGroupBookingDto): boolean {
  return b.blockedReason === null && b.adviseId === null;
}

/**
 * Bookings of the EFR the advise does not hold yet but could — what `Save &
 * Send` warns about, because after sending they can only be added by cancelling
 * and reissuing the advise.
 */
export function pendingBookings(group: AdviseGroupDto): AdviseGroupBookingDto[] {
  return group.bookings.filter(
    (b) => !b.included && (b.match === 'FULL' || b.match === 'WARN') && b.adviseId === null,
  );
}

function detail(b: AdviseGroupBookingDto, mode: AdvisePanelMode): string {
  if (b.included) {
    const on = mode === 'new' ? 'Goes on the new advise.' : 'On this advise.';
    return b.match === 'WARN' && b.reason !== null ? `${on} ${b.reason}` : on;
  }
  if (b.adviseCode !== null) return `On ${b.adviseCode}.`;
  if (b.match === 'REFUSED') return b.reason ?? 'Kept apart.';
  if (b.blockedReason !== null) return `Waiting — ${b.blockedReason}`;
  const why = b.reason === null ? '' : `${b.reason} `;
  if (mode === 'new') return `${why}Check the parties, then tick it to put it on this advise.`.trim();
  if (mode === 'sent') {
    return `${why}Not on this advise. Adding it means cancelling and reissuing the advise, with a new House BL number.`.trim();
  }
  return `${why}Not on this advise yet.`.trim();
}

export function AdviseGroupPanel({
  group,
  mode,
  ticked,
  onToggle,
  canAdd,
  onAdd,
  pending,
}: {
  group: AdviseGroupDto;
  mode: AdvisePanelMode;
  /** The warned bookings ticked in, on a new advise. */
  ticked: string[];
  onToggle: (shipmentId: string) => void;
  canAdd: boolean;
  onAdd: (shipmentId: string) => void;
  pending: boolean;
}) {
  if (group.bookings.length <= 1) {
    return group.note === null ? null : <p className="text-cell text-steel">{group.note}</p>;
  }

  return (
    <section aria-labelledby="adviseGroupTitle" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="adviseGroupTitle" className="text-section text-hull">
          Bookings on this advise
        </h3>
        {group.efrNo !== null && (
          <p className="text-cell text-steel">
            Same quotation, received under{' '}
            <span className="font-mono tabular-nums text-hull">{group.efrNo}</span> — one advise
            and one BL for all of them.
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-manifest border border-line">
        <table className="w-full border-collapse text-cell">
          <thead>
            <tr className="bg-paper text-left label-manifest">
              {mode === 'new' && (
                <th className="w-10 px-3 py-2">
                  <span className="sr-only">On the advise</span>
                </th>
              )}
              <th className="px-3 py-2">Booking</th>
              <th className="px-3 py-2">EFR</th>
              <th className="px-3 py-2">Match</th>
              <th className="px-3 py-2">Detail</th>
              {mode === 'draft' && canAdd && (
                <th className="px-3 py-2">
                  <span className="sr-only">Action</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {group.bookings.map((b) => {
              const toggleable = mode === 'new' && b.match === 'WARN' && isFree(b);
              const locked = mode === 'new' && b.included && !toggleable;
              const addable =
                mode === 'draft' &&
                canAdd &&
                !b.included &&
                (b.match === 'FULL' || b.match === 'WARN') &&
                isFree(b);
              return (
                <tr key={b.shipmentId} className="border-t border-line align-top">
                  {mode === 'new' && (
                    <td className="px-3 py-2">
                      {(toggleable || locked) && (
                        <input
                          type="checkbox"
                          aria-label={`Put ${b.bookingNo} on this advise`}
                          title={
                            locked
                              ? 'Same EFR, sailing, shipper and consignee — always on the advise.'
                              : undefined
                          }
                          checked={locked || ticked.includes(b.shipmentId)}
                          disabled={locked || pending}
                          onChange={() => onToggle(b.shipmentId)}
                          className="mt-0.5 size-4 accent-[var(--color-harbour)]"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono tabular-nums text-hull">{b.bookingNo}</td>
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {b.efrNos.length === 0 ? '—' : b.efrNos.join(', ')}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Status tone={TONE[b.match]}>
                      {/* Opened from another booking, "this booking" would point at the wrong one. */}
                      {b.match === 'LEAD' && mode !== 'new' ? 'Made from' : ADVISE_GROUP_MATCH_LABEL[b.match]}
                    </Status>
                  </td>
                  <td className="px-3 py-2 text-steel">{detail(b, mode)}</td>
                  {mode === 'draft' && canAdd && (
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {addable && (
                        <Button
                          variant="text"
                          size="inline"
                          disabled={pending}
                          onClick={() => onAdd(b.shipmentId)}
                        >
                          Add to this advise
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
