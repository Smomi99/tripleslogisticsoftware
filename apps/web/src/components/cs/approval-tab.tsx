'use client';

import {
  describeApproval,
  PO_APPROVAL_STATUS_LABEL,
  type PoApprovalStatus,
  type ShipmentDto,
  type ShipmentScheduleDto,
} from '@ff/shared';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Shipment Approval — §6.5, per PO (§5.3).
 *
 * §5.3 is the whole shape of this screen: "Single PO can be approved / Multiple
 * can be approved." So the grid ticks POs rather than offering one button for
 * the booking, a rejection carries a comment back to the C/S team, and the
 * summary says what will actually ship — "3 of 5 POs approved. 2 will not ship
 * on this vessel" — because that is the number the approver is deciding, not
 * whether they clicked approve.
 *
 * §9 Q6, answered 2026-09-02: a customer approves their own and C/S may record
 * one that arrived by phone. Both are offered here; the record says which.
 */

type Choice = 'APPROVED' | 'REJECTED' | null;

const TONE: Record<PoApprovalStatus, 'active' | 'pending' | 'overdue'> = {
  APPROVED: 'active',
  REJECTED: 'overdue',
  PENDING: 'pending',
};

export function ApprovalTab({
  booking,
  schedule,
  onDecided,
}: {
  booking: ShipmentDto;
  /** The proposal being decided on, or null when there is none waiting. */
  schedule: ShipmentScheduleDto | null;
  onDecided: () => void;
}) {
  const { authorizedRequest, can } = useSession();

  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [onBehalf, setOnBehalf] = useState(false);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mayApprove = can('CUSTOMER_SERVICE.SHIPMENT_APPROVAL.APPROVE');
  const mayReject = can('CUSTOMER_SERVICE.SHIPMENT_APPROVAL.REJECT');
  const awaitingDecision = schedule !== null && schedule.status === 'PROPOSED';
  const open = awaitingDecision && mayApprove;

  /** What the booking would look like if this were submitted now (§5.3). */
  const preview = useMemo(() => {
    let approved = 0;
    for (const po of booking.pos) {
      const choice = choices[po.id];
      if (choice === 'APPROVED') approved += 1;
      else if (choice === undefined && po.approvalStatus === 'APPROVED') approved += 1;
    }
    return describeApproval(approved, booking.pos.length);
  }, [booking.pos, choices]);

  const decided = Object.entries(choices).filter(([, c]) => c !== null && c !== undefined);
  const missingComment = decided.some(
    ([id, c]) => c === 'REJECTED' && (comments[id] ?? '').trim() === '',
  );

  async function submit(): Promise<void> {
    setError(null);
    if (decided.length === 0) {
      setError('Tick at least one PO before recording a decision.');
      return;
    }
    if (missingComment) {
      // §5.3, and the server refuses it too — this is only so the operator
      // hears it before the round trip.
      setError('A rejected PO needs a reason. The C/S team acts on it.');
      return;
    }

    setPending(true);
    try {
      const result = await authorizedRequest<{ summary: string }>(
        `/api/tenant/cs/bookings/${booking.id}/approval`,
        {
          method: 'POST',
          body: {
            onBehalfOfCustomer: onBehalf,
            decisions: decided.map(([poId, decision]) => ({
              poId,
              decision,
              comments: decision === 'REJECTED' ? comments[poId] : undefined,
            })),
          },
        },
      );
      toast.success(result.summary);
      setChoices({});
      setComments({});
      onDecided();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record that decision.');
    } finally {
      setPending(false);
    }
  }

  if (booking.pos.length === 0) {
    return (
      <EmptyState
        title="No POs on this booking"
        description="POs come from the cargo grid on the Booking tab."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --------------------------------- the proposal, read-only (§6.5) */}
      <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <h2 className="mb-3 text-section text-hull">Proposed schedule</h2>
        {schedule === null ? (
          <p className="text-body text-steel">
            Nothing has been proposed yet. A schedule is put to the customer from the Vessel
            Schedule tab.
          </p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-3 text-body">
            <span className="font-mono tabular-nums text-hull">v{schedule.versionNo}</span>
            <span className="text-hull">{schedule.carrierName}</span>
            <span className="text-steel">
              {schedule.legs
                .map((l) => `${l.originPortName} → ${l.destinationPortName}`)
                .join(', then ')}
            </span>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- the POs */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <h2 className="border-b border-line px-4 py-3 text-section text-hull">Purchase orders</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">PO</th>
                <th className="label-manifest px-3 py-2 text-left">Current</th>
                {open && <th className="label-manifest px-3 py-2 text-left">Decision</th>}
                <th className="label-manifest px-3 py-2 text-left">Comments</th>
                <th className="label-manifest px-3 py-2 text-left">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {booking.pos.map((po) => {
                const choice = choices[po.id] ?? null;
                return (
                  <tr key={po.id} className="border-b border-line/60">
                    <td className="px-3 py-2 font-mono tabular-nums text-hull">{po.poNo}</td>
                    <td className="px-3 py-2">
                      <Status tone={TONE[po.approvalStatus]}>
                        {PO_APPROVAL_STATUS_LABEL[po.approvalStatus]}
                      </Status>
                    </td>
                    {open && (
                      <td className="px-3 py-2">
                        <div className="flex gap-3">
                          <label className="flex items-center gap-1.5 text-body">
                            <input
                              type="radio"
                              name={`po-${po.id}`}
                              aria-label={`Approve ${po.poNo}`}
                              checked={choice === 'APPROVED'}
                              onChange={() => setChoices({ ...choices, [po.id]: 'APPROVED' })}
                              className="size-4 accent-verified"
                            />
                            Approve
                          </label>
                          {mayReject && (
                            <label className="flex items-center gap-1.5 text-body">
                              <input
                                type="radio"
                                name={`po-${po.id}`}
                                aria-label={`Reject ${po.poNo}`}
                                checked={choice === 'REJECTED'}
                                onChange={() => setChoices({ ...choices, [po.id]: 'REJECTED' })}
                                className="size-4 accent-alert"
                              />
                              Reject
                            </label>
                          )}
                        </div>
                      </td>
                    )}
                    <td className="px-3 py-2">
                      {open && choice === 'REJECTED' ? (
                        <Input
                          aria-label={`Reason for rejecting ${po.poNo}`}
                          placeholder="Why is this PO not shipping?"
                          value={comments[po.id] ?? ''}
                          onChange={(e) => setComments({ ...comments, [po.id]: e.target.value })}
                          className="w-72"
                        />
                      ) : (
                        <span className="text-steel">{po.rejectionComments ?? '—'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-steel">
                      {po.approvedByName === null
                        ? '—'
                        : po.approvedOnBehalf
                          ? `${po.approvedByName} (for the customer)`
                          : po.approvedByName}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* §5.3: "Show the approver a clear summary." */}
        <p className="border-t border-line bg-paper px-4 py-3 text-body text-hull">{preview}</p>
      </section>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/*
            §9 Q6: C/S recording a decision that arrived by phone. Ticked here
            rather than inferred from who is signed in, because a C/S user can
            legitimately be doing either.
          */}
          <label className="flex items-center gap-2 text-body text-steel">
            <input
              type="checkbox"
              checked={onBehalf}
              onChange={(e) => setOnBehalf(e.target.checked)}
              className="size-4 accent-harbour"
            />
            I am recording this on the customer&apos;s behalf
          </label>
          <Button disabled={isPending || decided.length === 0} onClick={() => void submit()}>
            {isPending ? 'Recording…' : 'Record decision'}
          </Button>
        </div>
      ) : (
        <p className="text-body text-steel">
          {schedule === null || schedule.status !== 'PROPOSED'
            ? 'There is no schedule waiting for a decision.'
            : 'You do not have permission to decide on this booking.'}
        </p>
      )}
    </div>
  );
}
