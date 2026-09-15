'use client';

import type { ClpBillingCbm, ClpCard, ClpCostPreview, ClpPlan } from '@ff/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * What the box cost, and whose cargo carries it — CR-002 §7 and §9.
 *
 * Four things, in the order somebody works through them: what each booking is
 * billed on, what the container actually cost, how that splits, and — for
 * whoever holds OVERRIDE_COST — a way to change the split by hand.
 *
 * Nothing here calculates an authoritative figure. The default split comes
 * from the server, the preview comes from the server, and the reconciliation
 * shown before saving is the server's own arithmetic echoed back. A second
 * implementation in React would be a second answer, and the wrong one would be
 * the one a planner is looking at.
 */

const num = (v: string | number | null | undefined, dp = 2): string =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** The three bases a booking's CBM can rest on, said plainly. */
function BasisTag({ basis }: { basis: ClpBillingCbm['basis'] }) {
  if (basis === null) return <span className="text-steel">—</span>;
  if (basis === 'ACTUAL') return <Status tone="active">Measured</Status>;
  if (basis === 'BOOKED') return <Status tone="inactive">Booked</Status>;
  // MIXED is worth seeing: part of this charge rests on a measurement and
  // part does not.
  return <Status tone="pending">Part measured</Status>;
}

export function ClpCostPanel({
  clp,
  plan,
  busy,
  onChanged,
  onBilling,
}: {
  clp: ClpCard;
  plan: ClpPlan;
  busy: boolean;
  onChanged: (next: ClpPlan) => void;
  /** Published upward so the final review shows the same figures, not a second fetch. */
  onBilling?: (rows: ClpBillingCbm[]) => void;
}) {
  const { authorizedRequest, can } = useSession();
  const [billing, setBilling] = useState<ClpBillingCbm[] | null>(null);
  const [cost, setCost] = useState(clp.actualContainerCost ?? '');
  const [currencyId, setCurrencyId] = useState('');
  const [basis, setBasis] = useState<'CBM' | 'WEIGHT'>(
    clp.costAllocationBasis === 'WEIGHT' ? 'WEIGHT' : 'CBM',
  );
  const [preview, setPreview] = useState<ClpCostPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [overriding, setOverriding] = useState(false);

  const mayOverrideCost = can('OPERATION.CONTAINER_LOAD_PLAN.OVERRIDE_COST');
  const mayEdit = can('OPERATION.CONTAINER_LOAD_PLAN.EDIT');
  const editable = clp.status === 'DRAFT';

  useEffect(() => {
    const base = plan.currencies.find((c) => c.isBase);
    setCurrencyId((current) => current || base?.id || plan.currencies[0]?.id || '');
  }, [plan.currencies]);

  const loadBilling = useCallback(async () => {
    try {
      const rows = await authorizedRequest<ClpBillingCbm[]>(
        `/api/tenant/ops/clps/${clp.id}/billing`,
      );
      setBilling(rows);
      onBilling?.(rows);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load the CBM figures.');
    }
  }, [authorizedRequest, clp.id, onBilling]);

  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  /*
    The preview is the server's arithmetic, not ours. It runs as the figure
    changes so a planner sees the split before committing to it, and it writes
    nothing.
  */
  useEffect(() => {
    if (cost.trim() === '' || currencyId === '' || !editable) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await authorizedRequest<ClpCostPreview>(
            `/api/tenant/ops/clps/${clp.id}/cost/preview`,
            { method: 'POST', body: { actualContainerCost: cost.trim(), costCurrencyId: currencyId, basis } },
          );
          if (!cancelled) setPreview(result);
        } catch {
          // A refusal here is usually "nothing loaded yet to split by"; the
          // save path reports it properly rather than nagging on every
          // keystroke.
          if (!cancelled) setPreview(null);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authorizedRequest, clp.id, cost, currencyId, basis, editable]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      onChanged(
        await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${clp.id}/cost`, {
          method: 'PATCH',
          body: { actualContainerCost: cost.trim(), costCurrencyId: currencyId, basis },
        }),
      );
      toast.success('Container cost saved, and split across the bookings');
      await loadBilling();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save that cost.');
    } finally {
      setSaving(false);
    }
  }

  const allocated = clp.bookings.reduce((sum, b) => sum + Number(b.allocatedCostAmount ?? 0), 0);
  const target = Number(clp.actualContainerCost ?? 0);
  const reconciles =
    clp.actualContainerCost !== null && Math.abs(allocated - target) < 0.00005;
  const overridden = clp.bookings.some((b) => b.costOverriddenBy !== null);

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="label-manifest mb-2">Cargo measured, and what the box cost</p>

      {/* ------------------------------------------- Stage D: booked vs actual */}
      <div className="overflow-x-auto rounded-manifest border border-line">
        <table className="w-full min-w-[720px] border-collapse text-cell">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest px-3 py-2 text-left">Booking</th>
              <th className="label-manifest px-3 py-2 text-right">Booked CBM</th>
              <th className="label-manifest px-3 py-2 text-right">Measured CBM</th>
              <th className="label-manifest px-3 py-2 text-right">Billing CBM</th>
              <th className="label-manifest px-3 py-2 text-left">Basis</th>
              <th className="label-manifest px-3 py-2 text-right">Receipts</th>
            </tr>
          </thead>
          <tbody>
            {(billing ?? []).map((b) => (
              <tr key={b.shipmentId} className="border-b border-line last:border-0">
                <td className="px-3 py-2 font-mono tabular-nums text-hull">{b.bookingCode}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                  {num(b.bookedCbm, 4)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                  {b.measuredLines === 0 ? (
                    <span className="text-steel">not measured</span>
                  ) : (
                    num(b.actualCbm, 4)
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                  {num(b.billingCbm, 4)}
                </td>
                <td className="px-3 py-2">
                  <BasisTag basis={b.basis} />
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                  {/* Where a booking-level answer came from, per §7. */}
                  {b.measuredLines} of {b.totalLines}
                </td>
              </tr>
            ))}
            {billing !== null && billing.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-cell text-steel">
                  No bookings on this container yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------- Stage E: what it cost */}
      {editable && mayEdit && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field
            id={`cost-${clp.id}`}
            label="Actual container cost"
            hint="What the carrier charged for this box — not the quoted price."
          >
            <Input
              id={`cost-${clp.id}`}
              numeric
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              placeholder="2000.00"
              className="w-40"
            />
          </Field>

          <Field id={`ccy-${clp.id}`} label="Currency">
            <Select
              id={`ccy-${clp.id}`}
              value={currencyId}
              onChange={(event) => setCurrencyId(event.target.value)}
              className="w-40"
            >
              {plan.currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                  {c.isBase ? ' (base)' : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field id={`basis-${clp.id}`} label="Split by">
            <Select
              id={`basis-${clp.id}`}
              value={basis}
              onChange={(event) => setBasis(event.target.value as 'CBM' | 'WEIGHT')}
              className="w-36"
            >
              <option value="CBM">CBM</option>
              <option value="WEIGHT">Weight</option>
            </Select>
          </Field>

          <Button
            variant="secondary"
            size="inline"
            disabled={busy || saving || cost.trim() === '' || currencyId === ''}
            onClick={() => void save()}
          >
            Save cost
          </Button>
        </div>
      )}

      {/* Stage F preview — the server's split, before anything is written. */}
      {preview !== null && clp.actualContainerCost === null && (
        <div className="mt-3 rounded-manifest border border-line bg-paper p-3">
          <p className="label-manifest">If you save this</p>
          <ul className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
            {preview.shares.map((s) => (
              <li key={s.shipmentId} className="text-cell text-hull">
                <span className="font-mono tabular-nums">{s.bookingCode}</span>{' '}
                <span className="font-mono tabular-nums text-steel">
                  {num(s.amount)} {preview.currencyCode ?? ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ------------------------------ Stage F: the split, as it now stands */}
      {clp.actualContainerCost !== null && (
        <div className="mt-3 overflow-x-auto rounded-manifest border border-line">
          <table className="w-full min-w-[720px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Booking</th>
                <th className="label-manifest px-3 py-2 text-right">Default</th>
                <th className="label-manifest px-3 py-2 text-right">Allocated</th>
                <th className="label-manifest px-3 py-2 text-right">Difference</th>
                <th className="label-manifest px-3 py-2 text-left">Changed by</th>
              </tr>
            </thead>
            <tbody>
              {clp.bookings.map((b) => {
                const diff =
                  Number(b.allocatedCostAmount ?? 0) - Number(b.defaultCostAmount ?? 0);
                return (
                  <tr key={b.shipmentId} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 font-mono tabular-nums text-hull">{b.bookingCode}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                      {num(b.defaultCostAmount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {num(b.allocatedCostAmount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Math.abs(diff) < 0.00005 ? (
                        <span className="text-steel">—</span>
                      ) : (
                        <span className="text-signal">
                          {diff > 0 ? '+' : ''}
                          {num(diff)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-steel">{b.costOverriddenBy ?? '—'}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-line bg-paper">
                <td className="px-3 py-2 label-manifest">
                  Total · split by {clp.costAllocationBasis ?? '—'}
                </td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                  {num(allocated)} {clp.costCurrencyCode ?? ''}
                </td>
                <td colSpan={2} className="px-3 py-2">
                  {/* The reconciliation §9 asks to be shown before finalising. */}
                  {reconciles ? (
                    <Status tone="active">
                      Matches the container cost of {num(clp.actualContainerCost)}
                    </Status>
                  ) : (
                    <Status tone="inactive">
                      Does not match {num(clp.actualContainerCost)} — the server will refuse this
                    </Status>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------- Stage G: the hand split */}
      {clp.actualContainerCost !== null && editable && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {mayOverrideCost ? (
            <Button
              variant="secondary"
              size="inline"
              disabled={busy}
              onClick={() => setOverriding(true)}
            >
              Change the split by hand
            </Button>
          ) : (
            /*
              Shown, not hidden. Somebody who cannot do this still needs to
              know it is possible and who to ask — a missing button teaches
              nothing.
            */
            <p className="text-cell text-steel">
              Changing this split by hand needs the &ldquo;Override cost split&rdquo; permission.
              The figures above are the calculated split.
            </p>
          )}
          {overridden && (
            <span className="text-cell text-signal">
              This split was changed by hand; the calculated figures are kept in the Default column.
            </span>
          )}
        </div>
      )}

      {overriding && (
        <OverrideDialog
          clp={clp}
          open={overriding}
          onClose={() => setOverriding(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

/**
 * §9's manual split.
 *
 * Every booking carries a figure — including zero, which is a decision — and
 * the running total is shown against the container cost as the figures are
 * typed, so the refusal is visible before the request is made. The server
 * checks it again regardless.
 */
function OverrideDialog({
  clp,
  open,
  onClose,
  onSaved,
}: {
  clp: ClpCard;
  open: boolean;
  onClose: () => void;
  onSaved: (next: ClpPlan) => void;
}) {
  const { authorizedRequest } = useSession();
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(clp.bookings.map((b) => [b.shipmentId, b.allocatedCostAmount ?? '0'])),
  );
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);

  const target = Number(clp.actualContainerCost ?? 0);
  const entered = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const diff = entered - target;
  const balances = Math.abs(diff) < 0.00005;
  const negative = Object.values(amounts).some((v) => Number(v) < 0);
  const ready = balances && !negative && reason.trim().length >= 5;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    try {
      onSaved(
        await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${clp.id}/cost/allocations`, {
          method: 'PUT',
          body: {
            allocations: clp.bookings.map((b) => ({
              shipmentId: b.shipmentId,
              amount: (amounts[b.shipmentId] ?? '0').trim(),
            })),
            reason: reason.trim(),
          },
        }),
      );
      toast.success('Cost split changed, and the reason recorded');
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change that split.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Change the cost split"
      description="Every booking carries a share. The parts have to add up to what the container cost."
    >
      <FormLayout
        onSubmit={submit}
        onCancel={onClose}
        isPending={pending}
        submitDisabled={!ready}
        submitLabel="Save the split"
      >
        {clp.bookings.map((b) => (
          <Field key={b.shipmentId} id={`alloc-${b.shipmentId}`} label={b.bookingCode}>
            <Input
              id={`alloc-${b.shipmentId}`}
              numeric
              value={amounts[b.shipmentId] ?? ''}
              onChange={(event) =>
                setAmounts((current) => ({ ...current, [b.shipmentId]: event.target.value }))
              }
              className="font-mono tabular-nums"
            />
          </Field>
        ))}

        <p
          className={
            balances && !negative
              ? 'rounded-manifest border border-line bg-paper px-3 py-2 text-body text-hull'
              : 'rounded-manifest border border-alert/40 bg-alert/5 px-3 py-2 text-body text-hull'
          }
        >
          <span className="font-mono tabular-nums">{num(entered)}</span> of{' '}
          <span className="font-mono tabular-nums">{num(target)}</span>{' '}
          {clp.costCurrencyCode ?? ''}
          {negative ? (
            <span className="ml-2 text-alert">A booking cannot carry a negative share.</span>
          ) : balances ? (
            <span className="ml-2 text-verified">Balances exactly.</span>
          ) : (
            <span className="ml-2 text-alert">
              {diff > 0 ? 'Over' : 'Under'} by {num(Math.abs(diff))} — every part of the cost has
              to land on a booking.
            </span>
          )}
        </p>

        <Field
          id={`why-${clp.id}`}
          label="Why the split is being changed"
          required
          hint="Kept against your name, so an invoice query can be answered later."
        >
          <Input
            id={`why-${clp.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Agreed with the customer at 60/40."
          />
        </Field>
      </FormLayout>
    </Modal>
  );
}
