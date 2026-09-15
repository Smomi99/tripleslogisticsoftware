'use client';

import type { ClpBillingCbm, ClpCard, ClpPlan } from '@ff/shared';

import { Status } from '@/components/ui/status';

/**
 * The one thing to read before finalising — CR-002 §11 stage H.
 *
 * Everything above this on the page is a working surface: the pool, the
 * container, the CBM table, the cost split. Each is right for the job it does
 * and wrong for this one, because finalising has no edit path and the question
 * at that moment is not "is this field correct" but "is this whole container
 * correct". Making an operator assemble that answer from four adjacent panels
 * is how a wrong box gets signed for.
 *
 * So this repeats rather than links. Nothing here is calculated: every figure
 * is one the server already returned, shown once more in one place.
 */

const num = (v: string | number | null | undefined, dp = 2): string =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label-manifest">{label}</dt>
      <dd className="font-mono text-cell tabular-nums text-hull">{children}</dd>
    </div>
  );
}

export function ClpFinalReview({
  clp,
  plan,
  billing,
}: {
  clp: ClpCard;
  plan: ClpPlan;
  billing: ClpBillingCbm[] | null;
}) {
  const booking = plan.booking;

  const allocated = clp.bookings.reduce((s, b) => s + Number(b.allocatedCostAmount ?? 0), 0);
  const cost = clp.actualContainerCost === null ? null : Number(clp.actualContainerCost);
  /*
    The same comparison the server makes, at the same scale (money is
    NUMERIC(18,4)). Shown, never relied upon: PATCH and PUT both check it
    again, and a finalise with a broken split is refused there.
  */
  const reconciles = cost !== null && Math.abs(allocated - cost) < 0.00005;
  const overridden = clp.bookings.filter((b) => b.costOverriddenBy !== null);

  const billingFor = (shipmentId: string) =>
    (billing ?? []).find((b) => b.shipmentId === shipmentId) ?? null;

  /* Warnings, never mixed with the things that stop a finalisation. */
  const warnings: string[] = [];
  if (clp.capacityOverrideReason !== null) {
    warnings.push(
      `Loaded over capacity — ${clp.capacityOverrideReason}${
        clp.capacityOverrideBy === null ? '' : ` (allowed by ${clp.capacityOverrideBy})`
      }`,
    );
  }
  for (const b of billing ?? []) {
    if (b.basis === 'MIXED') {
      warnings.push(
        `${b.bookingCode}: ${b.measuredLines} of ${b.totalLines} receipts were re-measured, so part of this charge rests on a measurement and part does not.`,
      );
    }
  }
  if (clp.finalCfsLocation === null && clp.bookings.length > 1) {
    warnings.push('No CFS was chosen for this container.');
  }

  return (
    <section className="mt-4 rounded-manifest border-2 border-hull bg-surface p-4">
      <h3 className="text-section text-hull">
        {clp.status === 'FINAL' ? 'What was finalised' : 'Before you finalise'}
      </h3>
      <p className="mt-1 text-cell text-steel">
        {clp.status === 'FINAL'
          ? 'This plan is closed. These are the figures it was signed off on.'
          : 'A finalised plan cannot be edited. This is everything on it, in one place.'}
      </p>

      {/* ------------------------------------------------------------ the CLP */}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-3 sm:grid-cols-4">
        <Line label="CLP">
          {clp.code}
          {clp.clpSeq === null ? '' : ` · ${clp.clpSeq}`}
        </Line>
        <Line label="Status">
          <Status
            tone={clp.status === 'FINAL' ? 'active' : clp.status === 'CANCELLED' ? 'inactive' : 'pending'}
          >
            {clp.status === 'FINAL' ? 'Final' : clp.status === 'CANCELLED' ? 'Cancelled' : 'Draft'}
          </Status>
        </Line>
        <Line label="Type">
          {clp.consolidationType === 'SINGLE'
            ? 'One booking'
            : clp.consolidationType === 'LCL_CONSOLIDATION'
              ? 'LCL consolidation'
              : 'FCL / consol box'}
        </Line>
        <Line label="Container">
          {clp.containerSizeCode}
          {clp.containerNo === null ? '' : ` · ${clp.containerNo}`}
        </Line>

        <Line label="Sailing">
          {/* vessel + voyage, the identity §2 corrected the CR on */}
          {booking.vesselName === null && booking.voyageNo === null
            ? '—'
            : `${booking.vesselName ?? ''} ${booking.voyageNo ?? ''}`.trim()}
        </Line>
        <Line label="POD">{booking.podName}</Line>
        <Line label="Carrier">{booking.carrierName ?? '—'}</Line>
        <Line label="Stuffed at">{clp.finalCfsLocation ?? '—'}</Line>
      </dl>

      {/* -------------------------------------------------------- the bookings */}
      <div className="mt-4 overflow-x-auto rounded-manifest border border-line">
        <table className="w-full min-w-[900px] border-collapse text-cell">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest px-3 py-2 text-left">Booking</th>
              <th className="label-manifest px-3 py-2 text-left">Customer</th>
              <th className="label-manifest px-3 py-2 text-right">CTN</th>
              <th className="label-manifest px-3 py-2 text-right">CBM in this box</th>
              <th className="label-manifest px-3 py-2 text-right">Weight</th>
              <th className="label-manifest px-3 py-2 text-right">Billing CBM</th>
              <th className="label-manifest px-3 py-2 text-left">Basis</th>
              <th className="label-manifest px-3 py-2 text-right">Allocation</th>
            </tr>
          </thead>
          <tbody>
            {clp.bookings.map((b) => {
              // What THIS booking has in THIS container — not the container's
              // totals, which would read the same for every participant.
              const mine = clp.lines.filter((l) => l.shipmentId === b.shipmentId);
              const ctn = mine.reduce((s, l) => s + l.ctnQty, 0);
              const cbm = mine.reduce((s, l) => s + Number(l.volumeCbm ?? 0), 0);
              const kg = mine.reduce((s, l) => s + Number(l.grossWeightKg ?? 0), 0);
              const bill = billingFor(b.shipmentId);
              const overrode = b.costOverriddenBy !== null;
              return (
                <tr key={b.shipmentId} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono tabular-nums text-hull">{b.bookingCode}</td>
                  <td className="px-3 py-2 text-steel">{b.customerName}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {ctn}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {num(cbm, 4)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                    {num(kg, 0)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {num(bill?.billingCbm, 4)}
                  </td>
                  <td className="px-3 py-2 text-steel">
                    {bill === null || bill.basis === null
                      ? '—'
                      : bill.basis === 'ACTUAL'
                        ? 'Measured'
                        : bill.basis === 'BOOKED'
                          ? 'Booked'
                          : 'Part measured'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {num(b.allocatedCostAmount)}
                    {overrode && <span className="ml-2 text-signal">changed</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------------------- the cost */}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Line label="Actual container cost">
          {num(clp.actualContainerCost)} {clp.costCurrencyCode ?? ''}
        </Line>
        <Line label="Split by">{clp.costAllocationBasis ?? '—'}</Line>
        <Line label="Allocated to bookings">
          {num(allocated)} {clp.costCurrencyCode ?? ''}
        </Line>
        <Line label="Changed by hand">
          {overridden.length === 0 ? 'No' : (overridden[0]!.costOverriddenBy ?? 'Yes')}
        </Line>
      </dl>

      {/* --------------------------------------------------- the reconciliation */}
      <div
        className={
          cost === null
            ? 'mt-3 rounded-manifest border border-line bg-paper px-3 py-2'
            : reconciles
              ? 'mt-3 rounded-manifest border border-verified/40 bg-verified/5 px-3 py-2'
              : 'mt-3 rounded-manifest border border-alert/40 bg-alert/5 px-3 py-2'
        }
      >
        {cost === null ? (
          <p className="text-body text-steel">
            No container cost recorded. The plan can still be finalised; the cost can be entered
            on a later plan, but not on this one once it is final.
          </p>
        ) : reconciles ? (
          <p className="text-body text-hull">
            <span className="label-manifest text-verified">Reconciled</span>{' '}
            <span className="font-mono tabular-nums">{num(allocated)}</span> allocated ={' '}
            <span className="font-mono tabular-nums">{num(cost)}</span> container cost.
          </p>
        ) : (
          <p className="text-body text-hull">
            <span className="label-manifest text-alert">Does not reconcile</span>{' '}
            <span className="font-mono tabular-nums">{num(allocated)}</span> allocated against{' '}
            <span className="font-mono tabular-nums">{num(cost)}</span> — out by{' '}
            <span className="font-mono tabular-nums">{num(Math.abs(allocated - cost))}</span>. Fix
            the split before finalising.
          </p>
        )}
      </div>

      {/*
        Warnings, kept plainly apart from the reconciliation above. A cut-off
        that disagrees is not the same kind of thing as money that does not add
        up, and drawing them alike teaches an operator to ignore both.
      */}
      {warnings.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 rounded-manifest border border-signal/40 bg-signal/5 p-3">
          {warnings.map((w) => (
            <li key={w} className="text-body text-hull">
              <span className="label-manifest text-signal">Worth knowing</span> {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
