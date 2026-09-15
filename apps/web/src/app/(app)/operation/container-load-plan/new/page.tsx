'use client';

import type {
  ClpCandidateList,
  ClpCandidateRow,
  ClpCompatibilityResult,
  ClpSuggestedGroup,
} from '@ff/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Build a container from several bookings — CR-002 §4.
 *
 * Three things share this screen and must never be confused with each other,
 * which is most of the design:
 *
 *   HARD FAILURES are what the server will refuse. Red, and they disable the
 *   button.
 *   WARNINGS are data worth a second look — a cut-off that disagrees across
 *   one sailing — and they block nothing.
 *   SUGGESTIONS are the commercial default. They are proposals a planner
 *   applies or ignores, and they are deliberately drawn as the quietest thing
 *   here, because a suggestion that looks like a rule is one people stop
 *   reading.
 *
 * No rule is evaluated in this file. Ticking a box asks the server whether the
 * selection holds; the server decides again on the write.
 */

type Family = 'FCL' | 'LCL';

const num = (v: string | number | null | undefined, dp = 2): string =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const day = (iso: string | null): string => (iso === null ? '—' : iso.slice(0, 10));

export default function NewConsolidatedClpPage() {
  const router = useRouter();
  const { authorizedRequest, can } = useSession();

  const [family, setFamily] = useState<Family>('FCL');
  const [search, setSearch] = useState('');
  const [list, setList] = useState<ClpCandidateList | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [check, setCheck] = useState<ClpCompatibilityResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [sizeId, setSizeId] = useState('');
  const [cfs, setCfs] = useState('');
  const [busy, setBusy] = useState(false);

  const mayCreate = can('OPERATION.CONTAINER_LOAD_PLAN.CREATE');

  const load = useCallback(
    async (f: Family, term: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ family: f });
        if (term.trim() !== '') params.set('search', term.trim());
        setList(
          await authorizedRequest<ClpCandidateList>(
            `/api/tenant/ops/clp-candidates?${params.toString()}`,
          ),
        );
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not load the bookings.');
      } finally {
        setLoading(false);
      }
    },
    [authorizedRequest],
  );

  useEffect(() => {
    const id = setTimeout(() => void load(family, search), search === '' ? 0 : 300);
    return () => clearTimeout(id);
  }, [load, family, search]);

  /* Switching workflow clears the selection: §3 never mixes the two. */
  useEffect(() => {
    setPicked([]);
    setCheck(null);
  }, [family]);

  // Sizes arrive with the candidates, so this screen needs no Settings right
  // to show what a planner is filling.
  const sizes = useMemo(() => list?.containerSizes ?? [], [list]);
  useEffect(() => {
    setSizeId((current) => current || (sizes[0]?.id ?? ''));
  }, [sizes]);

  /*
    Every change of selection asks the SERVER. The alternative — mirroring the
    rules in React — is how a screen and an API start disagreeing about what is
    legal, and the screen is the one that would be wrong.
  */
  useEffect(() => {
    if (picked.length === 0) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    void (async () => {
      try {
        const result = await authorizedRequest<ClpCompatibilityResult>(
          '/api/tenant/ops/clp-candidates/check',
          { method: 'POST', body: { shipmentIds: picked } },
        );
        if (!cancelled) setCheck(result);
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof ApiError ? error.message : 'Could not check that selection.');
          setCheck(null);
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, picked]);

  const byId = useMemo(
    () => new Map((list?.candidates ?? []).map((c) => [c.shipmentId, c])),
    [list],
  );

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  const applySuggestion = (group: ClpSuggestedGroup) => {
    setPicked(group.shipmentIds);
    toast.success(
      `${group.shipmentIds.length} booking${group.shipmentIds.length === 1 ? '' : 's'} selected — change it however you need`,
    );
  };

  const blocking = (check?.issues ?? []).filter((i) => i.blocking);
  const warnings = (check?.issues ?? []).filter((i) => !i.blocking);
  const ready = picked.length > 0 && check?.ok === true && sizeId !== '' && !checking;

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const made = await authorizedRequest<{ id: string; shipmentId: string }>(
        '/api/tenant/ops/clps/consolidate',
        {
          method: 'POST',
          body: {
            shipmentIds: picked,
            containerSizeId: sizeId,
            ...(cfs.trim() === '' ? {} : { finalCfsLocation: cfs.trim() }),
          },
        },
      );
      toast.success(
        picked.length === 1
          ? 'Container plan created'
          : `Container plan created for ${picked.length} bookings`,
      );
      router.push(`/operation/container-load-plan/${made.shipmentId}` as never);
    } catch (error) {
      // The refusal names the booking and the rule (§3), so it goes through as
      // it came rather than being replaced with something vaguer.
      toast.error(error instanceof ApiError ? error.message : 'Could not create that plan.');
    } finally {
      setBusy(false);
    }
  }

  const selected = picked.map((id) => byId.get(id)).filter((c): c is ClpCandidateRow => c !== undefined);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="New container plan"
        description="Pick the bookings that will share a container. The rules are checked as you go."
      />

      {/* ------------------------------------------------ Stage A: the pool */}
      <div className="flex flex-wrap items-end gap-3">
        <div
          className="inline-flex rounded-manifest border border-line bg-surface p-0.5"
          role="tablist"
          aria-label="Which workflow"
        >
          {(['FCL', 'LCL'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={family === f}
              onClick={() => setFamily(f)}
              className={
                family === f
                  ? 'rounded-[3px] bg-harbour px-3 py-1.5 text-cell font-semibold text-white'
                  : 'rounded-[3px] px-3 py-1.5 text-cell text-steel hover:text-hull'
              }
            >
              {f === 'FCL' ? 'FCL / Consol box' : 'LCL'}
            </button>
          ))}
        </div>

        <Input
          type="search"
          aria-label="Search bookings"
          placeholder="Booking, customer or exporter"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-80"
        />

        <p className="text-cell text-steel">
          {family === 'FCL'
            ? 'Whole containers, grouped by quotation. Consol box counts as FCL.'
            : 'Many shippers sharing one box, across customers.'}
        </p>
      </div>

      {/* --------------------------------------- Stage B: the suggestions */}
      {(list?.suggestions ?? []).filter((g) => g.shipmentIds.length > 1).length > 0 && (
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <h2 className="label-manifest">Suggested groups</h2>
          <p className="mt-1 text-cell text-steel">
            A starting point, not a rule — apply one and then add or remove whatever you need.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(list?.suggestions ?? [])
              .filter((g) => g.shipmentIds.length > 1)
              .map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => applySuggestion(g)}
                  className="rounded-manifest border border-line bg-paper px-3 py-2 text-left transition-colors duration-[120ms] hover:border-harbour"
                >
                  <span className="block font-mono text-cell tabular-nums text-hull">
                    {g.quotationCode ?? 'Ungrouped'} · {g.shipmentIds.length} bookings
                  </span>
                  <span className="block text-cell text-steel">
                    {g.totalCtnQty} CTN · {num(g.totalCbm)} CBM · {num(g.totalGrossKg, 0)} kg
                  </span>
                </button>
              ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------ Stage A: the candidates */}
      {loading ? (
        <p className="text-body text-steel">Loading…</p>
      ) : (list?.candidates ?? []).length === 0 ? (
        <EmptyState
          title="Nothing waiting to be planned"
          description={`No ${family} booking has cargo received and accepted at the CFS yet.`}
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-[1400px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="w-10 px-3 py-2" />
                <th className="label-manifest px-3 py-2 text-left">Booking No</th>
                <th className="label-manifest px-3 py-2 text-left">Customer</th>
                <th className="label-manifest px-3 py-2 text-left">Exporter</th>
                <th className="label-manifest px-3 py-2 text-left">Type</th>
                <th className="label-manifest px-3 py-2 text-left">POL</th>
                <th className="label-manifest px-3 py-2 text-left">POD</th>
                <th className="label-manifest px-3 py-2 text-left">Vessel / Voyage</th>
                <th className="label-manifest px-3 py-2 text-left">Cut-off</th>
                <th className="label-manifest px-3 py-2 text-right">CTN</th>
                <th className="label-manifest px-3 py-2 text-right">CBM</th>
                <th className="label-manifest px-3 py-2 text-right">Weight</th>
                <th className="label-manifest px-3 py-2 text-left">CFS</th>
              </tr>
            </thead>
            <tbody>
              {(list?.candidates ?? []).map((c) => {
                const chosen = picked.includes(c.shipmentId);
                const failed = blocking.some((b) => b.shipmentId === c.shipmentId);
                return (
                  <tr
                    key={c.shipmentId}
                    className={
                      failed
                        ? 'border-b border-line bg-alert/5 last:border-0'
                        : chosen
                          ? 'border-b border-line bg-harbour/5 last:border-0'
                          : 'border-b border-line last:border-0'
                    }
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Include ${c.code}`}
                        checked={chosen}
                        onChange={() => toggle(c.shipmentId)}
                        className="size-4 accent-[var(--color-harbour)]"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-hull">{c.code}</td>
                    <td className="px-3 py-2 text-hull">{c.customerName}</td>
                    <td className="px-3 py-2 text-steel">{c.exporterName ?? '—'}</td>
                    <td className="px-3 py-2 text-steel">{c.loadingType ?? '—'}</td>
                    <td className="px-3 py-2 text-hull">{c.polName}</td>
                    <td className="px-3 py-2 text-hull">{c.podName}</td>
                    <td className="px-3 py-2 font-mono text-cell tabular-nums text-hull">
                      {c.vesselName === null ? (
                        <span className="text-signal">no approved sailing</span>
                      ) : (
                        `${c.vesselName} ${c.voyageNo ?? ''}`
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-steel">
                      {day(c.cutOffDate)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {c.receivedCtnQty}
                      {c.plannedCtnQty > 0 && (
                        <span className="ml-1 text-steel">({c.plannedCtnQty} planned)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                      {num(c.receivedCbm)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                      {num(c.receivedGrossKg, 0)}
                    </td>
                    <td className="px-3 py-2 text-steel">
                      {/* §8 — never collapsed to one value. */}
                      {c.cfsLocations.length === 0
                        ? '—'
                        : c.cfsLocations.length === 1
                          ? c.cfsLocations[0]
                          : `${c.cfsLocations.length} locations`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------- Stage B/C: the selection and its fate */}
      {picked.length > 0 && (
        <section className="sticky bottom-0 rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-section text-hull">
              {picked.length} booking{picked.length === 1 ? '' : 's'} selected
            </h2>
            <p className="font-mono text-cell tabular-nums text-hull">
              {check?.totalCtnQty ?? 0} CTN · {num(check?.totalCbm)} CBM ·{' '}
              {num(check?.totalGrossKg, 0)} kg
              {(() => {
                const size = sizes.find((s) => s.id === sizeId);
                const cap = size?.maxVolumeCbm;
                if (cap === null || cap === undefined || check === null) return null;
                const pct = (Number(check.totalCbm) / Number(cap)) * 100;
                return (
                  <span className={pct > 100 ? 'ml-3 text-alert' : 'ml-3 text-steel'}>
                    {pct.toFixed(1)}% of a {size?.code}
                  </span>
                );
              })()}
            </p>
          </div>

          {/* Hard failures. These stop the button. */}
          {blocking.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 rounded-manifest border border-alert/40 bg-alert/5 p-3">
              {blocking.map((issue) => (
                <li key={`${issue.shipmentId}-${issue.reason}`} className="text-body text-hull">
                  <span className="label-manifest text-alert">Cannot share a container</span>{' '}
                  {issue.reason}
                </li>
              ))}
            </ul>
          )}

          {/* Warnings. Worth reading, but they stop nothing. */}
          {warnings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 rounded-manifest border border-signal/40 bg-signal/5 p-3">
              {warnings.map((issue) => (
                <li key={`${issue.shipmentId}-${issue.reason}`} className="text-body text-hull">
                  <span className="label-manifest text-signal">Worth checking</span> {issue.reason}
                </li>
              ))}
            </ul>
          )}

          {check?.ok === true && blocking.length === 0 && (
            <p className="mt-3 text-cell text-steel">
              <Status tone="active">These can travel together</Status>
              {check.cfsLocations.length > 1 && (
                <span className="ml-3 text-signal">
                  Multiple CFS locations: {check.cfsLocations.join(', ')} — choose the one this
                  container is stuffed at.
                </span>
              )}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field id="sizeId" label="Container" required>
              <Select
                id="sizeId"
                value={sizeId}
                onChange={(event) => setSizeId(event.target.value)}
                className="w-48"
              >
                {sizes.length === 0 && <option value="">Loading…</option>}
                {sizes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code}
                    {s.maxVolumeCbm === null ? '' : ` — ${num(s.maxVolumeCbm, 0)} CBM`}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              id="cfs"
              label="Stuffed at"
              hint="Chosen, not guessed — a booking can arrive at several CFS."
            >
              <Input
                id="cfs"
                value={cfs}
                onChange={(event) => setCfs(event.target.value)}
                placeholder={check?.cfsLocations[0] ?? 'CFS location'}
                className="w-56"
              />
            </Field>

            <div className="ml-auto flex items-center gap-3">
              <Button variant="secondary" size="inline" onClick={() => setPicked([])} disabled={busy}>
                Clear
              </Button>
              {mayCreate && (
                <Button variant="primary" disabled={!ready || busy} onClick={() => void create()}>
                  {checking ? 'Checking…' : 'Create container plan'}
                </Button>
              )}
            </div>
          </div>

          {selected.length > 1 && (
            <p className="mt-2 text-cell text-steel">
              {selected.map((s) => s.code).join(', ')}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
