'use client';

import {
  type ClpCard,
  type ClpPlan,
  type ClpPoolRow,
  splitPreview,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

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
      await authorizedRequest(`/api/tenant/ops/bookings/${shipmentId}/clps`, {
        method: 'POST',
        body: { containerSizeId: sizeId },
      });
      toast.success('Container added to the plan');
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not add that container.');
    } finally {
      setBusy(false);
    }
  }

  /** §2.2: both buttons land here. `add` simply passes the whole balance. */
  async function put(row: ClpPoolRow, ctnQty: number): Promise<void> {
    if (target === '') {
      toast.error('Add a container first, then choose which one to load into.');
      return;
    }
    setBusy(true);
    try {
      const next = await authorizedRequest<ClpPlan>(`/api/tenant/ops/clps/${target}/lines`, {
        method: 'POST',
        body: { cargoLineId: row.cargoLineId, ctnQty },
      });
      apply(next);
      setSplitting(null);
      toast.success(`${ctnQty} cartons of ${row.poNo} loaded`);
    } catch (error) {
      // The refusal names the PO and the balance (§4.1), so it goes through
      // as it came rather than being replaced with something vaguer.
      toast.error(error instanceof ApiError ? error.message : 'Could not load that cargo.');
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
  const drafts = plan.clps.filter((c) => c.status === 'DRAFT');

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
        <p className="mt-3 text-cell text-steel">
          {plan.booking.unallocatedCtnQty === 0
            ? 'Every received carton is assigned to a container.'
            : `${plan.booking.unallocatedCtnQty} cartons still unassigned.`}
        </p>
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
              isTarget={clp.id === target}
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
  isTarget,
  mayEdit,
  busy,
  onRemoveLine,
  onRemove,
}: {
  clp: ClpCard;
  isTarget: boolean;
  mayEdit: boolean;
  busy: boolean;
  onRemoveLine: (id: string, label: string) => void;
  onRemove: () => void;
}) {
  const volume = clp.volumeUtilisation === null ? null : Number(clp.volumeUtilisation);
  const weight = clp.weightUtilisation === null ? null : Number(clp.weightUtilisation);

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
        Two bars from the first allocation, not only when exceeded (§4.2). A
        bar past 100% turns --alert; "capacity not set" is said plainly rather
        than drawn as an empty bar, which would read as room to spare.
      */}
      <div className="mb-3 flex flex-col gap-2">
        <Utilisation label="Volume" ratio={volume} limit={clp.maxVolumeCbm} unit="CBM" />
        <Utilisation label="Weight" ratio={weight} limit={clp.maxWeightKg} unit="kg" />
      </div>

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
    </section>
  );
}

function Utilisation({
  label,
  ratio,
  limit,
  unit,
}: {
  label: string;
  ratio: number | null;
  limit: string | null;
  unit: string;
}) {
  if (limit === null || ratio === null) {
    return (
      <p className="text-cell text-steel">
        {label}: capacity not set for this container size.
      </p>
    );
  }
  const pct = ratio * 100;
  const over = ratio > 1;
  return (
    <div>
      <div className="flex items-baseline justify-between text-cell">
        <span className="label-manifest">{label}</span>
        <span className={over ? 'font-mono tabular-nums text-alert' : 'font-mono tabular-nums text-hull'}>
          {pct.toFixed(1)}% of {num(limit, 0)} {unit}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-manifest bg-paper">
        <div
          className={over ? 'h-1.5 rounded-manifest bg-alert' : 'h-1.5 rounded-manifest bg-harbour'}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
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
