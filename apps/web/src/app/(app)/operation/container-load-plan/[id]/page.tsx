'use client';

import {
  CLP_OVER_VOLUME,
  type ClpCard,
  type ClpDetailsInput,
  type ClpFinaliseInput,
  type ClpPlan,
  type ClpPoolRow,
  splitPreview,
  validateContainerNo,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { VirtualContainer } from '@/components/ops/virtual-container';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { ChildScreenHeader, FormLayout } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Cargo Load Plan - SEA, the builder — MODULE_CLP.md §5.1.
 *
 * Three parts, in the order the wireframe draws them: the booking it belongs
 * to, the pool of cargo still waiting for a container, and the containers
 * themselves as cards.
 *
 * §2.2 — `add` and `Split` are one operation. `add` sends the whole remaining
 * balance and `Split` sends part of it; the server is not told which button
 * was pressed, because nothing downstream should care.
 *
 * §2.3 — the carton is the only number anyone types. The split dialog has one
 * editable cell and everything else recalculates, which is the client's own
 * instruction: "we always work at carton level".
 */

/**
 * What to tell the user when a request is refused.
 *
 * A Zod refusal arrives as "Some fields need attention" with the real reason
 * in `fields` — so the toast said nothing actionable while the server was
 * holding "Check digit should be 3, not 7". §12 asks errors to name the fix;
 * the field message is the one that does.
 */
function refusal(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const first = Object.values(error.fields ?? {})[0]?.[0];
  return first ?? error.message;
}

/**
 * §4.4's balance, in one sentence.
 *
 * The POs are named rather than summed: "20 cartons unassigned" tells a
 * planner only that they are not finished, where "PO-004 has 20 cartons
 * unassigned" tells them where to look.
 *
 * The "fully allocated" clause is dropped when it is zero — opening with
 * "0 POs fully allocated" reads as a rebuke on a plan nobody has started yet.
 */
function balanceSentence(r: ClpPlan['reconciliation']): string {
  if (r.outstanding.length === 0) return 'Every received carton is assigned to a container.';

  const left = r.outstanding
    .map((o) => `${o.poNo} has ${o.ctnQty} cartons unassigned`)
    .join('; ');
  if (r.fullyAllocatedPos === 0) return `${left}.`;
  const done = `${r.fullyAllocatedPos} PO${r.fullyAllocatedPos === 1 ? '' : 's'} fully allocated`;
  return `${done}. ${left}.`;
}

const num = (v: string | number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

const whole = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-US');

export default function ClpBuilderPage() {
  const params = useParams<{ id: string }>();
  const shipmentId = params.id;
  const { authorizedRequest, can } = useSession();

  const [plan, setPlan] = useState<ClpPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sizeId, setSizeId] = useState('');
  const [target, setTarget] = useState<string>('');
  const [splitting, setSplitting] = useState<ClpPoolRow | null>(null);
  const [toRemove, setToRemove] = useState<{ id: string; label: string } | null>(null);
  /*
    §4.2 — what was refused for volume, held so a supervisor can send it again
    with a reason. Keeping the attempt means they do not have to retype the
    split they just described.
  */
  const [blocked, setBlocked] = useState<
    { row: ClpPoolRow; ctnQty: number; why: string } | null
  >(null);

  const endpoint = `/api/tenant/ops/bookings/${shipmentId}/clp`;

  const load = useCallback(async () => {
    try {
      const next = await authorizedRequest<ClpPlan>(endpoint);
      setPlan(next);
      setSizeId((current) => current || (next.containerSizes[0]?.id ?? ''));
      setTarget((current) => {
        const drafts = next.clps.filter((c) => c.status === 'DRAFT');
        return drafts.some((c) => c.id === current) ? current : (drafts[0]?.id ?? '');
      });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load the plan.');
    } finally {
      setLoading(false);
    }
  }, [authorizedRequest, endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Applies a server response that already carries the whole plan back. */
  function apply(next: ClpPlan): void {
    setPlan(next);
    const drafts = next.clps.filter((c) => c.status === 'DRAFT');
    setTarget((current) => (drafts.some((c) => c.id === current) ? current : (drafts[0]?.id ?? '')));
  }

  async function addContainer(): Promise<void> {
    if (sizeId === '') return;
    setBusy(true);
    try {
      const added = await authorizedRequest<{ id: string }>(
        `/api/tenant/ops/bookings/${shipmentId}/clps`,
        { method: 'POST', body: { containerSizeId: sizeId } },
      );
      toast.success('Container added to the plan');
      await load();
      /*
        Aim at the container that was just added. Somebody adds a box because
        they have cargo for it, and the previous target is usually the one
        that just ran out of room — leaving the selection there sends the next
        `add` straight back into the container they were trying to relieve.

        This runs after load(), which sets the target itself and would
        otherwise overwrite it.
      */
      setTarget(added.id);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not add that container.');
    } finally {
      setBusy(false);
    }
  }

  /** §5.2's SAVE CLP — records what is known so far on a draft. */
  async function saveDetails(clpId: string, input: ClpDetailsInput): Promise<void> {
    setBusy(true);
    try {
      apply(
        await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${clpId}`, {
          method: 'PATCH',
          body: input,
        }),
      );
      toast.success('Saved');
    } catch (error) {
      toast.error(refusal(error, 'Could not save those details.'));
    } finally {
      setBusy(false);
    }
  }

  /** §4.3's one-way door. */
  async function finalise(clpId: string, input: ClpFinaliseInput): Promise<void> {
    setBusy(true);
    try {
      apply(
        await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${clpId}/finalise`, {
          method: 'POST',
          body: input,
        }),
      );
      toast.success('Load plan finalised');
    } catch (error) {
      toast.error(refusal(error, 'Could not finalise that plan.'));
    } finally {
      setBusy(false);
    }
  }

  /** §2.2: both buttons land here. `add` simply passes the whole balance. */
  async function put(row: ClpPoolRow, ctnQty: number, overrideReason?: string): Promise<void> {
    if (target === '') {
      toast.error('Add a container first, then choose which one to load into.');
      return;
    }
    setBusy(true);
    try {
      const next = await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${target}/lines`, {
        method: 'POST',
        body: {
          cargoLineId: row.cargoLineId,
          ctnQty,
          ...(overrideReason === undefined ? {} : { overrideReason }),
        },
      });
      apply(next);
      setSplitting(null);
      setBlocked(null);
      toast.success(
        overrideReason === undefined
          ? `${ctnQty} cartons of ${row.poNo} loaded`
          : `${ctnQty} cartons of ${row.poNo} loaded over capacity — the reason is on the plan`,
      );
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Could not load that cargo.';
      /*
        §4.2 — a volume refusal is the one that has a way through. Offer it
        only to somebody who actually holds the right: showing the dialog to a
        planner who cannot use it would be a promise the server then breaks.
      */
      if (error instanceof ApiError && error.code === CLP_OVER_VOLUME && mayOverride) {
        setSplitting(null);
        setBlocked({ row, ctnQty, why: message });
      } else {
        // The refusal names the PO and the figures (§4.1), so it goes through
        // as it came rather than being replaced with something vaguer.
        toast.error(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(): Promise<void> {
    if (toRemove === null) return;
    setBusy(true);
    try {
      const next = await authorizedRequest<ClpPlan>(
        `/api/tenant/ops/clp-lines/${toRemove.id}`,
        { method: 'DELETE' },
      );
      apply(next);
      setToRemove(null);
      toast.success('Taken back out of the container');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not take that out.');
    } finally {
      setBusy(false);
    }
  }

  async function removeContainer(clp: ClpCard): Promise<void> {
    setBusy(true);
    try {
      const next = await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${clp.id}`, {
        method: 'DELETE',
      });
      apply(next);
      toast.success(`${clp.code} removed`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove that plan.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-body text-steel">Loading…</p>;
  if (plan === null) return <p className="text-body text-alert">Could not load this plan.</p>;

  const mayEdit = can('OPERATION.CONTAINER_LOAD_PLAN.CREATE');
  const maySplit = can('OPERATION.CONTAINER_LOAD_PLAN.SPLIT');
  const mayOverride = can('OPERATION.CONTAINER_LOAD_PLAN.OVERRIDE_CAPACITY');
  const mayFinalise = can('OPERATION.CONTAINER_LOAD_PLAN.FINALISE');
  const drafts = plan.clps.filter((c) => c.status === 'DRAFT');
  /*
    The biggest capacity on this plan, so every container is drawn to the same
    scale. Two cards side by side then compare honestly — a 40HC looks longer
    than a 20STD because it holds more, not because it is on the right.
  */
  const largestCbm = Math.max(
    1,
    ...plan.clps.map((c) => Number(c.maxVolumeCbm ?? 0)).filter((n) => Number.isFinite(n)),
  );

  return (
    <div className="flex flex-col gap-4">
      <ChildScreenHeader
        parentLabel="Cargo Load Plan"
        parentName={`${plan.booking.code} · ${plan.booking.customerName}`}
        title="Container Load Plan"
        backHref={'/operation/container-load-plan' as Route}
      />

      {/* ------------------------------------------------- the booking (§5.1) */}
      <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['S/O No', plan.booking.shippingOrderCode ?? '—'],
            ['POL', plan.booking.polName],
            ['POD', plan.booking.podName],
            ['Carrier', plan.booking.carrierName ?? '—'],
            ['Required', plan.booking.requiredContainer],
            ['Received CTN', whole(plan.booking.receivedCtnQty)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd className="font-mono text-body tabular-nums text-hull">{value}</dd>
            </div>
          ))}
        </dl>

        {/*
          §4.4 — never blocks. The real cargo decides what it takes, and the
          gap between that and what was quoted is exactly what customer
          service needs to see.
        */}
        {plan.clps.length > 0 && !plan.reconciliation.matches && (
          <p className="mt-3 rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2 text-body text-hull">
            Booking declares {plan.reconciliation.required}. This plan uses{' '}
            {plan.reconciliation.planned}.
          </p>
        )}
        {/* §4.4 — always shown, and the outstanding POs named. */}
        <p className="mt-3 text-cell text-steel">{balanceSentence(plan.reconciliation)}</p>
      </section>

      {/* --------------------------------------------- select container (§5.1) */}
      {mayEdit && (
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <div className="flex flex-wrap items-end gap-3">
            <Field id="containerSizeId" label="Select container">
              <Select
                id="containerSizeId"
                value={sizeId}
                onChange={(event) => setSizeId(event.target.value)}
                className="w-56"
              >
                {plan.containerSizes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code}
                    {s.maxVolumeCbm === null ? '' : ` — ${num(s.maxVolumeCbm, 0)} CBM`}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={() => void addContainer()} disabled={busy || sizeId === ''}>
              + Add container
            </Button>

            {drafts.length > 1 && (
              <Field id="target" label="Load into">
                <Select
                  id="target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  className="w-44"
                >
                  {drafts.map((c) => (
                    <option key={c.id} value={c.id}>
                      CLP {c.clpSeq} · {c.containerSizeCode}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </section>
      )}

      {/* ------------------------------------------------ the cargo pool (§5.1) */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-section text-hull">Cargo to load</h2>
          <p className="text-cell text-steel">
            What arrived and was accepted, less whatever is already in a container. A row leaves
            this grid once all of it is assigned.
          </p>
        </div>

        {plan.pool.length === 0 ? (
          <p className="px-4 py-6 text-cell text-steel">
            Nothing left to assign — every received carton is in a container.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-cell">
              <thead>
                <tr className="border-b border-line bg-paper">
                  <th className="label-manifest px-3 py-2 text-left">PO</th>
                  <th className="label-manifest px-3 py-2 text-left">Item</th>
                  <th className="label-manifest px-3 py-2 text-left">SKU</th>
                  <th className="label-manifest px-3 py-2 text-right">CTN Qty</th>
                  <th className="label-manifest px-3 py-2 text-right">PCS Qty</th>
                  <th className="label-manifest px-3 py-2 text-right">N.WT</th>
                  <th className="label-manifest px-3 py-2 text-right">G.WT</th>
                  <th className="label-manifest px-3 py-2 text-left">Carton (L·W·H)</th>
                  <th className="label-manifest px-3 py-2 text-right">CBM</th>
                  {mayEdit && <th className="label-manifest px-3 py-2 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {plan.pool.map((row) => (
                  <tr key={row.cargoLineId} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 font-mono tabular-nums text-hull">{row.poNo}</td>
                    <td className="px-3 py-2 text-hull">{row.itemCode}</td>
                    <td className="px-3 py-2 text-steel">{row.sku ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {whole(row.ctnQty)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {whole(row.pcsQty)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {num(row.netWeightKg, 3)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {num(row.grossWeightKg, 3)}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-steel">
                      {row.cartonLengthCm === null
                        ? '—'
                        : `${num(row.cartonLengthCm, 0)}·${num(row.cartonWidthCm, 0)}·${num(row.cartonHeightCm, 0)}`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {num(row.volumeCbm, 4)}
                    </td>
                    {mayEdit && (
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex gap-3">
                          <Button
                            variant="text"
                            size="inline"
                            disabled={busy || target === ''}
                            onClick={() => void put(row, row.ctnQty)}
                          >
                            add
                          </Button>
                          {maySplit && (
                            <Button
                              variant="text"
                              size="inline"
                              disabled={busy || target === '' || row.ctnQty < 2}
                              onClick={() => setSplitting(row)}
                            >
                              Split
                            </Button>
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {/* §5.1's footer strip. */}
              <tfoot>
                <tr className="border-t border-line bg-paper">
                  <td className="px-3 py-2 label-manifest" colSpan={3}>
                    {new Set(plan.pool.map((r) => r.poNo)).size} PO ·{' '}
                    {new Set(plan.pool.map((r) => r.itemCode)).size} item
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {whole(plan.pool.reduce((s, r) => s + r.ctnQty, 0))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {whole(plan.pool.reduce((s, r) => s + (r.pcsQty ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {num(plan.pool.reduce((s, r) => s + Number(r.netWeightKg ?? 0), 0), 3)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {num(plan.pool.reduce((s, r) => s + Number(r.grossWeightKg ?? 0), 0), 3)}
                  </td>
                  <td />
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {num(plan.pool.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0), 4)}
                  </td>
                  {mayEdit && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------- the CLP cards (§5.1) */}
      {plan.clps.length === 0 ? (
        <EmptyState
          title="No containers yet"
          description="Pick a container size above to start the plan."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {plan.clps.map((clp) => (
            <ClpCardView
              key={clp.id}
              clp={clp}
              largestCbm={largestCbm}
              isTarget={clp.id === target}
              supervisors={plan.supervisors}
              mayFinalise={mayFinalise}
              onSave={(input) => saveDetails(clp.id, input)}
              onFinalise={(input) => finalise(clp.id, input)}
              mayEdit={mayEdit}
              busy={busy}
              onRemoveLine={(id, label) => setToRemove({ id, label })}
              onRemove={() => void removeContainer(clp)}
            />
          ))}
        </div>
      )}

      <Modal
        open={splitting !== null}
        onOpenChange={(open) => !open && setSplitting(null)}
        title={splitting === null ? 'Split' : `Split ${splitting.poNo}`}
        description="Type the cartons. Everything else follows."
      >
        {splitting !== null && (
          <SplitForm
            row={splitting}
            pending={busy}
            onCancel={() => setSplitting(null)}
            onSubmit={(n) => put(splitting, n)}
          />
        )}
      </Modal>

      <Modal
        open={blocked !== null}
        onOpenChange={(open) => !open && setBlocked(null)}
        title="This container will be over its volume"
        description="Say why it may go ahead. The reason is kept on the plan and in the audit trail."
      >
        {blocked !== null && (
          <OverrideForm
            why={blocked.why}
            pending={busy}
            onCancel={() => setBlocked(null)}
            onSubmit={(reason) => put(blocked.row, blocked.ctnQty, reason)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => !open && setToRemove(null)}
        title="Take this cargo out?"
        message={
          toRemove === null
            ? ''
            : `${toRemove.label} goes back to the pool and can be loaded somewhere else.`
        }
        confirmLabel="Take out"
        destructive
        isPending={busy}
        onConfirm={() => void removeLine()}
      />
    </div>
  );
}

/** One container, with what is in it and how full it is. */
function ClpCardView({
  clp,
  largestCbm,
  isTarget,
  mayEdit,
  mayFinalise,
  supervisors,
  busy,
  onRemoveLine,
  onRemove,
  onSave,
  onFinalise,
}: {
  clp: ClpCard;
  largestCbm: number;
  isTarget: boolean;
  mayEdit: boolean;
  mayFinalise: boolean;
  supervisors: { id: string; name: string }[];
  busy: boolean;
  onRemoveLine: (id: string, label: string) => void;
  onRemove: () => void;
  onSave: (input: ClpDetailsInput) => Promise<void>;
  onFinalise: (input: ClpFinaliseInput) => Promise<void>;
}) {
  /*
    One band per PO (§5.1). A PO split across two containers appears on both,
    which is the point of the picture: you can see where it went.
  */
  const bands = clp.lines.map((line) => ({
    poNo: line.poNo,
    volumeCbm: Number(line.volumeCbm ?? 0),
  }));

  return (
    <section
      className={
        isTarget
          ? 'rounded-manifest border-2 border-harbour bg-surface p-4 shadow-manifest'
          : 'rounded-manifest border border-line bg-surface p-4 shadow-manifest'
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-3 text-section text-hull">
          <span>CLP No : {clp.clpSeq}</span>
          <span className="font-mono text-cell tabular-nums text-steel">{clp.code}</span>
          <Status tone={clp.status === 'DRAFT' ? 'pending' : clp.status === 'FINAL' ? 'active' : 'inactive'}>
            {clp.status === 'DRAFT' ? 'Draft' : clp.status === 'FINAL' ? 'Final' : 'Cancelled'}
          </Status>
        </h3>
        <span className="font-mono text-cell tabular-nums text-hull">{clp.containerSizeCode}</span>
      </div>

      <dl className="mb-3 grid grid-cols-4 gap-3">
        {[
          ['CTN', whole(clp.totalCtnQty)],
          ['PCS', whole(clp.totalPcsQty)],
          ['G.WT', num(clp.totalGrossWeightKg, 3)],
          ['CBM', num(clp.totalVolumeCbm, 4)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="label-manifest">{label}</dt>
            <dd className="font-mono text-body tabular-nums text-hull">{value}</dd>
          </div>
        ))}
      </dl>

      {/*
        §5.1's virtual container, shown from the first allocation rather than
        only when something is wrong — the picture is how a planner sees the
        shape of the load, not just its failure.
      */}
      <div className="mb-3">
        <VirtualContainer
          sizeCode={clp.containerSizeCode}
          maxVolumeCbm={clp.maxVolumeCbm === null ? null : Number(clp.maxVolumeCbm)}
          maxWeightKg={clp.maxWeightKg === null ? null : Number(clp.maxWeightKg)}
          usedWeightKg={Number(clp.totalGrossWeightKg ?? 0)}
          bands={bands}
          widthFraction={Number(clp.maxVolumeCbm ?? 0) / largestCbm}
        />
      </div>

      {/*
        §4.2 — the reason a supervisor gave, on the container it excuses.
        Written where the 107% is read, because that is where the question
        gets asked.
      */}
      {clp.capacityOverrideReason !== null && (
        <p className="mb-3 rounded-manifest border border-signal/40 bg-signal/5 px-3 py-2 text-cell text-hull">
          <span className="label-manifest text-signal">Loaded over capacity</span>{' '}
          <span className="ml-1">{clp.capacityOverrideReason}</span>
          {clp.capacityOverrideBy !== null && (
            <span className="text-steel"> — allowed by {clp.capacityOverrideBy}</span>
          )}
        </p>
      )}

      {clp.lines.length === 0 ? (
        <p className="text-cell text-steel">
          Nothing loaded yet.
          {mayEdit && ' Use add or Split on the grid above.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {clp.lines.map((line) => (
            <li
              key={line.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1 last:border-0"
            >
              <span className="text-body text-hull">
                <span className="font-mono tabular-nums">{line.poNo}</span>{' '}
                <span className="text-steel">{line.itemCode}</span>
                {line.isSplit && <span className="ml-2 text-cell text-signal">split</span>}
              </span>
              <span className="flex items-baseline gap-3">
                <span className="font-mono text-cell tabular-nums text-hull">
                  {whole(line.ctnQty)} CTN · {num(line.volumeCbm, 4)} CBM
                </span>
                {mayEdit && clp.status === 'DRAFT' && (
                  <Button
                    variant="destructive"
                    size="inline"
                    disabled={busy}
                    onClick={() => onRemoveLine(line.id, `${line.ctnQty} CTN of ${line.poNo}`)}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mayEdit && clp.status === 'DRAFT' && clp.lines.length === 0 && (
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="inline" disabled={busy} onClick={onRemove}>
            Remove this container
          </Button>
        </div>
      )}

      {clp.status !== 'CANCELLED' && (
        <FinalisePanel
          clp={clp}
          supervisors={supervisors}
          busy={busy}
          mayEdit={mayEdit}
          mayFinalise={mayFinalise}
          onSave={onSave}
          onFinalise={onFinalise}
        />
      )}
    </section>
  );
}


/**
 * §5.2's finalisation panel, and §4.3's one-way door.
 *
 * Two buttons, because the details arrive at different times. The container
 * number is known when the box reaches the gate; the seal number only once it
 * is closed, which can be hours later. `Save CLP` records what is known so far
 * on the draft. `Finalise` is the step with no way back.
 *
 * The container number is checked as you type, against the same shared
 * utility the server uses (§5.2 asks for exactly one implementation). A wrong
 * check digit is nearly always a misread character, so naming the digit that
 * was expected turns the error into an instruction.
 */
function FinalisePanel({
  clp,
  supervisors,
  busy,
  mayEdit,
  mayFinalise,
  onSave,
  onFinalise,
}: {
  clp: ClpCard;
  supervisors: { id: string; name: string }[];
  busy: boolean;
  mayEdit: boolean;
  mayFinalise: boolean;
  onSave: (input: ClpDetailsInput) => Promise<void>;
  onFinalise: (input: ClpFinaliseInput) => Promise<void>;
}) {
  const [containerNo, setContainerNo] = useState(clp.containerNo ?? '');
  const [sealNo, setSealNo] = useState(clp.sealNo ?? '');
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in local time.
  const [loadAt, setLoadAt] = useState(toLocalInput(clp.loadDatetime));
  const [supervisorId, setSupervisorId] = useState(clp.supervisorEmployeeId ?? '');
  const [tallyMan, setTallyMan] = useState(clp.tallyManName ?? '');
  const [confirming, setConfirming] = useState(false);

  // Empty is not an error while typing — it is just not finished yet.
  const check = containerNo.trim() === '' ? null : validateContainerNo(containerNo);
  const containerError = check !== null && !check.ok ? (check.message ?? null) : null;

  const details = (): ClpDetailsInput => ({
    containerNo: containerNo.trim() === '' ? null : containerNo,
    sealNo: sealNo.trim() === '' ? null : sealNo,
    loadDatetime: loadAt === '' ? null : new Date(loadAt).toISOString(),
    supervisorEmployeeId: supervisorId === '' ? null : supervisorId,
    tallyManName: tallyMan.trim() === '' ? null : tallyMan,
  });

  /* §4.3's preconditions, named before the click rather than after it. */
  const missing: string[] = [];
  if (check === null || !check.ok) missing.push('a valid container number');
  if (sealNo.trim() === '') missing.push('the seal number');
  if (loadAt === '') missing.push('the load date and time');
  if (clp.lines.length === 0) missing.push('at least one carton loaded');

  if (clp.status === 'FINAL') {
    return (
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-3 sm:grid-cols-3">
        {[
          ['Container No', clp.containerNo ?? '—'],
          ['Seal No', clp.sealNo ?? '—'],
          ['Loaded', clp.loadDatetime === null ? '—' : new Date(clp.loadDatetime).toLocaleString()],
          ['Supervisor', clp.supervisorName ?? '—'],
          ['Tally man', clp.tallyManName ?? '—'],
          ['Finalised by', clp.finalisedBy ?? '—'],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="label-manifest">{label}</dt>
            <dd className="font-mono text-cell tabular-nums text-hull">{value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (!mayEdit) return null;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="label-manifest mb-2">Finalisation</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          id={`containerNo-${clp.id}`}
          label="Container No"
          error={containerError ?? undefined}
          hint={
            containerError === null && check?.ok === true
              ? 'Check digit verified.'
              : '4 letters then 7 digits, like MSKU1234565.'
          }
        >
          <Input
            id={`containerNo-${clp.id}`}
            value={containerNo}
            onChange={(event) => setContainerNo(event.target.value)}
            placeholder="MSKU1234565"
            className="font-mono uppercase tabular-nums"
          />
        </Field>

        <Field id={`sealNo-${clp.id}`} label="Seal No">
          <Input
            id={`sealNo-${clp.id}`}
            value={sealNo}
            onChange={(event) => setSealNo(event.target.value)}
            className="font-mono tabular-nums"
          />
        </Field>

        <Field id={`loadAt-${clp.id}`} label="Load date & time">
          <Input
            id={`loadAt-${clp.id}`}
            type="datetime-local"
            value={loadAt}
            onChange={(event) => setLoadAt(event.target.value)}
          />
        </Field>

        <Field id={`supervisor-${clp.id}`} label="Supervisor">
          <Select
            id={`supervisor-${clp.id}`}
            value={supervisorId}
            onChange={(event) => setSupervisorId(event.target.value)}
          >
            <option value="">—</option>
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field id={`tallyMan-${clp.id}`} label="Tally man">
          <Input
            id={`tallyMan-${clp.id}`}
            value={tallyMan}
            onChange={(event) => setTallyMan(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        {missing.length > 0 && (
          <span className="mr-auto text-cell text-steel">
            Needs {missing.join(', ')} before it can be final.
          </span>
        )}
        <Button
          variant="secondary"
          size="inline"
          disabled={busy || containerError !== null}
          onClick={() => void onSave(details())}
        >
          Save CLP
        </Button>
        {mayFinalise && (
          <Button
            variant="primary"
            size="inline"
            disabled={busy || missing.length > 0}
            onClick={() => setConfirming(true)}
          >
            Finalise
          </Button>
        )}
      </div>

      {/*
        §4.3 — "the finalisation dialog must be a real confirmation step".
        There is no edit path and re-keying a container plan is expensive, so
        the figures being signed off appear here rather than a bare
        "are you sure?".
      */}
      <Modal
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={`Finalise CLP ${clp.clpSeq}?`}
        description="A final plan cannot be edited. To change it afterwards you cancel it and build a new one."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
          {[
            ['Container No', containerNo.toUpperCase()],
            ['Seal No', sealNo],
            ['Loaded', loadAt === '' ? '—' : new Date(loadAt).toLocaleString()],
            ['Cartons', whole(clp.totalCtnQty)],
            [
              'Volume used',
              clp.volumeUtilisation === null
                ? '—'
                : `${(Number(clp.volumeUtilisation) * 100).toFixed(1)}%`,
            ],
            [
              'Weight used',
              clp.weightUtilisation === null
                ? '—'
                : `${(Number(clp.weightUtilisation) * 100).toFixed(1)}%`,
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd className="font-mono text-body tabular-nums text-hull">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
            Back
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              await onFinalise({
                containerNo,
                sealNo,
                loadDatetime: new Date(loadAt).toISOString(),
                supervisorEmployeeId: supervisorId === '' ? null : supervisorId,
                tallyManName: tallyMan.trim() === '' ? null : tallyMan,
              });
              setConfirming(false);
            }}
          >
            Finalise CLP {clp.clpSeq}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** An ISO instant as <input type="datetime-local"> wants it, in local time. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * §4.2's override — a supervisor saying, in writing, that this box takes more
 * than its stated volume.
 *
 * Weight never reaches here: an overweight container is a legal and safety
 * matter at the port, and the service refuses it outright.
 */
function OverrideForm({
  why,
  pending,
  onCancel,
  onSubmit,
}: {
  why: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 5;

  return (
    <FormLayout
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (ready) void onSubmit(reason.trim());
      }}
      onCancel={onCancel}
      isPending={pending}
      submitDisabled={!ready}
      submitLabel="Load it anyway"
    >
      <p className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-hull">
        {why}
      </p>
      <Field
        id="overrideReason"
        label="Why this is acceptable"
        required
        hint="Kept on the plan and in the audit trail, against your name."
      >
        <Input
          id="overrideReason"
          autoFocus
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Cartons compress; supervisor present at stuffing."
        />
      </Field>
    </FormLayout>
  );
}

/** §5.1's split dialog: one editable cell, everything else calculated. */
function SplitForm({
  row,
  pending,
  onCancel,
  onSubmit,
}: {
  row: ClpPoolRow;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (ctnQty: number) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const use = Number.parseInt(text, 10);
  const valid = Number.isInteger(use) && use > 0 && use <= row.ctnQty;
  const preview = splitPreview(row, Number.isFinite(use) ? use : 0);

  const rows: [string, { available: number; use: number; remaining: number } | null, number][] = [
    ['Cartons', preview.cartons, 0],
    ['Pieces', preview.pieces, 0],
    ['Net weight', preview.netWeight, 3],
    ['Gross weight', preview.grossWeight, 3],
    ['Volume', preview.volume, 4],
  ];

  return (
    <FormLayout
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (valid) void onSubmit(use);
      }}
      onCancel={onCancel}
      isPending={pending}
      submitDisabled={!valid}
      submitLabel="Load these cartons"
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-cell">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest px-3 py-2 text-left" />
              <th className="label-manifest px-3 py-2 text-right">Available</th>
              <th className="label-manifest px-3 py-2 text-right">Use</th>
              <th className="label-manifest px-3 py-2 text-right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, value, dp]) => (
              <tr key={label} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-hull">{label}</td>
                {value === null ? (
                  <td className="px-3 py-2 text-right text-steel" colSpan={3}>
                    not recorded
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                      {num(value.available, dp)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {label === 'Cartons' ? (
                        <Input
                          id="ctnQty"
                          aria-label="Cartons to load"
                          autoFocus
                          numeric
                          inputMode="numeric"
                          value={text}
                          onChange={(event) => setText(event.target.value)}
                          className="w-24 text-right"
                        />
                      ) : (
                        <span className="font-mono tabular-nums text-hull">
                          {num(value.use, dp)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                      {num(value.remaining, dp)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-cell text-steel">
        {/*
          The preview rounds; the saved figures come from the database and the
          allocation that completes the line absorbs the rounding, so the parts
          add back to the whole exactly (§2.3). Saying so beats a planner
          finding a one-piece difference and assuming something is broken.
        */}
        Pieces and weights follow the cartons. The last container to take the
        balance of a line carries any rounding, so the parts always add back to
        the whole.
      </p>
    </FormLayout>
  );
}
