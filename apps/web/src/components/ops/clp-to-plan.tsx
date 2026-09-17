'use client';

import type {
  ClpCandidateList,
  ClpCandidateRow,
  ClpCompatibilityResult,
  ClpLoadingFamily,
  ClpSuggestedGroup,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { type FamilyTab, familyInSentence, loadingLabel, requiredLabel } from './clp-labels';

/**
 * Container Load Plan → To plan: tick the POs that go in one container.
 *
 * The client's loading-type sheet (2026-09-16) draws each workflow as
 * Inquiry → Quotation → Booking → PO and says the plan is made by ticking POs,
 * so the list is grouped that way, the PO is what gets ticked, and `Create
 * container plan` both makes the plan and loads what was ticked. A booking's
 * own plan — more containers, a split, finalising — is one click away on
 * `Open`, so there is one place to start and one place to finish.
 *
 * Three things share this view and must never be confused with each other:
 *
 *   HARD FAILURES are what the server will refuse. Red, and they disable the
 *   button.
 *   WARNINGS are data worth a second look — a cut-off that disagrees across
 *   one sailing — and they block nothing.
 *   SUGGESTIONS are bookings on one sailing. Proposals a planner applies or
 *   ignores, drawn as the quietest thing here, because a suggestion that
 *   looks like a rule is one people stop reading.
 *
 * No rule is evaluated in this file. Ticking a box asks the server whether the
 * selection holds; the server decides again on the write.
 */

const num = (v: string | number | null | undefined, dp = 2): string =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const day = (iso: string | null): string => (iso === null ? '—' : iso.slice(0, 10));

/** Where a planned PO's container is: its booking's plan page, scrolled to that card. */
const planHref = (shipmentId: string, clpId: string): Route =>
  `/operation/container-load-plan/${shipmentId}#clp-${clpId}` as Route;

/** A draft can still be changed; a final plan can only be looked at. */
const viewLabel = (plans: { status: string }[]): string =>
  plans.some((p) => p.status === 'DRAFT') ? 'View / edit' : 'View';

/** The POs of a booking that ticking can still load. */
const loadable = (c: ClpCandidateRow): string[] =>
  c.pos.filter((po) => po.ctnQty > 0).map((po) => po.poId);

const COLUMNS = 9;

export function ClpToPlan({
  family,
  search,
  preselect,
  onFamilyFromBooking,
}: {
  family: FamilyTab;
  search: string;
  /** A booking handed in by a `Make CLP` shortcut, whose POs arrive ticked. */
  preselect: string | null;
  /** The shortcut's booking belongs to this workflow; the page switches to it. */
  onFamilyFromBooking: (family: ClpLoadingFamily) => void;
}) {
  const router = useRouter();
  const { authorizedRequest, can } = useSession();
  const mayCreate = can('OPERATION.CONTAINER_LOAD_PLAN.CREATE');

  /*
    The list is kept with the workflow it was fetched for, so nothing below
    can act on one workflow's candidates while another's tab is showing.
  */
  const [list, setList] = useState<{ family: FamilyTab; data: ClpCandidateList } | null>(null);
  const [loading, setLoading] = useState(true);
  /** Ticked PO ids, in the order they were ticked — the order the box is described in. */
  const [picked, setPicked] = useState<string[]>([]);
  const [check, setCheck] = useState<ClpCompatibilityResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [sizeId, setSizeId] = useState('');
  const [cfs, setCfs] = useState('');
  const [busy, setBusy] = useState(false);

  const [preselectDone, setPreselectDone] = useState(preselect === null);
  const [preselectIssue, setPreselectIssue] = useState<string | null>(null);
  /** The booking whose POs are ticked once its workflow's list has arrived. */
  const pendingBooking = useRef<string | null>(null);
  /** Set when the shortcut moves the workflow, so that move keeps its ticks. */
  const keepSelection = useRef(false);

  /**
   * The candidate list for the workflow on screen.
   *
   * The answer is applied only if it is still the answer to the question that
   * was asked. Two of these are in flight whenever the workflow changes while
   * one is loading — which the `Make CLP` shortcut does on every arrival,
   * because it opens on one workflow and the server's reading of the booking
   * moves it to another. Without the guard the LAST response won regardless
   * of which workflow it was for, and the named booking could be missing from
   * the list with nothing ticked. Not a flicker: it stayed that way.
   *
   * Cancellation lives in the effect rather than in the request, so it covers
   * the debounce window too.
   */
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      void (async () => {
        setLoading(true);
        try {
          const query = new URLSearchParams();
          if (family !== '') query.set('family', family);
          if (search.trim() !== '') query.set('search', search.trim());
          const qs = query.toString();
          const result = await authorizedRequest<ClpCandidateList>(
            `/api/tenant/ops/clp-candidates${qs === '' ? '' : `?${qs}`}`,
          );
          if (!cancelled) setList({ family, data: result });
        } catch (error) {
          if (!cancelled) {
            toast.error(error instanceof ApiError ? error.message : 'Could not load the bookings.');
          }
        } finally {
          /*
            Left true when superseded: the request that replaced this one owns
            the spinner, and clearing it here would flash "nothing to plan"
            over a list that is still arriving.
          */
          if (!cancelled) setLoading(false);
        }
      })();
    }, search === '' ? 0 : 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [authorizedRequest, family, search]);

  /*
    Switching workflow clears the ticks: the workflows never share a box. Not
    when the shortcut made the switch, which sets the workflow and the booking
    together.
  */
  const firstFamily = useRef(true);
  useEffect(() => {
    if (firstFamily.current) {
      firstFamily.current = false;
      return;
    }
    if (keepSelection.current) {
      keepSelection.current = false;
      return;
    }
    setPicked([]);
    setCheck(null);
  }, [family]);

  const current = list !== null && list.family === family ? list.data : null;
  const candidates = useMemo(() => current?.candidates ?? [], [current]);

  // Sizes arrive with the candidates, so no Settings right is needed to see them.
  const sizes = useMemo(() => list?.data.containerSizes ?? [], [list]);
  useEffect(() => {
    setSizeId((chosen) => chosen || (sizes[0]?.id ?? ''));
  }, [sizes]);

  /*
    A booking handed in by the shortcut. The server is asked which workflow it
    belongs to and whether it is eligible at all — the same endpoint the
    selection uses, so there is no second set of rules to keep in step.
  */
  useEffect(() => {
    if (preselect === null || preselectDone) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await authorizedRequest<ClpCompatibilityResult>(
          '/api/tenant/ops/clp-candidates/check',
          { method: 'POST', body: { shipmentIds: [preselect] } },
        );
        if (cancelled) return;
        if (result.family !== null && result.family !== family) {
          keepSelection.current = true;
          onFamilyFromBooking(result.family);
        }
        // Ineligible bookings never reach the list, so the reason is carried
        // here rather than leaving an empty screen.
        const blocked = result.issues.filter((i) => i.blocking);
        if (blocked.length > 0) setPreselectIssue(blocked.map((i) => i.reason).join(' '));
        pendingBooking.current = preselect;
      } catch (error) {
        if (!cancelled) {
          setPreselectIssue(
            error instanceof ApiError ? error.message : 'That booking could not be checked.',
          );
        }
      } finally {
        if (!cancelled) setPreselectDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once for the booking it was handed; the workflow it reads is the
    // one on screen when it arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorizedRequest, preselect, preselectDone]);

  /*
    Ticks the shortcut's booking once the list for its workflow is on screen.
    Waiting for THAT list, not any list, is what keeps a late response for the
    workflow the screen opened on from swallowing the preselection.
  */
  useEffect(() => {
    const wanted = pendingBooking.current;
    if (wanted === null || !preselectDone || loading || current === null) return;
    const booking = current.candidates.find((c) => c.shipmentId === wanted);
    if (booking === undefined) return;
    pendingBooking.current = null;
    setPicked(loadable(booking));
  }, [current, loading, preselectDone]);

  /*
    Every change of selection asks the SERVER. Mirroring the rules in React is
    how a screen and an API start disagreeing about what is legal.
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
          { method: 'POST', body: { shipmentPoIds: picked } },
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

  /** Inquiry → Quotation → bookings, in the order the bookings arrived. */
  const groups = useMemo(() => {
    const found = new Map<string, ClpCandidateRow[]>();
    for (const c of candidates) {
      const key = `${c.inquiryCode ?? ''}|${c.quotationCode ?? ''}`;
      found.set(key, [...(found.get(key) ?? []), c]);
    }
    return [...found.entries()].map(([key, bookings]) => ({ key, bookings }));
  }, [candidates]);

  const togglePo = (poId: string) =>
    setPicked((now) => (now.includes(poId) ? now.filter((x) => x !== poId) : [...now, poId]));

  const toggleBooking = (booking: ClpCandidateRow) => {
    const ids = loadable(booking);
    setPicked((now) =>
      ids.every((id) => now.includes(id))
        ? now.filter((x) => !ids.includes(x))
        : [...now, ...ids.filter((id) => !now.includes(id))],
    );
  };

  const applySuggestion = (group: ClpSuggestedGroup) => {
    const ids = group.shipmentIds.flatMap((id) => {
      const booking = candidates.find((c) => c.shipmentId === id);
      return booking === undefined ? [] : loadable(booking);
    });
    setPicked(ids);
  };

  const blocking = (check?.issues ?? []).filter((i) => i.blocking);
  const warnings = (check?.issues ?? []).filter((i) => !i.blocking);
  const ready = picked.length > 0 && check?.ok === true && sizeId !== '' && !checking;

  const tickedBookings = candidates.filter((c) => c.pos.some((po) => picked.includes(po.poId)));
  const tickedCustomers = new Set(tickedBookings.map((c) => c.customerName)).size;

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const made = await authorizedRequest<{ id: string; shipmentId: string }>(
        '/api/tenant/ops/clps/consolidate',
        {
          method: 'POST',
          body: {
            shipmentPoIds: picked,
            containerSizeId: sizeId,
            ...(cfs.trim() === '' ? {} : { finalCfsLocation: cfs.trim() }),
          },
        },
      );
      toast.success(
        tickedBookings.length > 1
          ? `Container plan created for ${tickedBookings.length} bookings`
          : `Container plan created with ${picked.length} PO${picked.length === 1 ? '' : 's'} loaded`,
      );
      router.push(`/operation/container-load-plan/${made.shipmentId}` as Route);
    } catch (error) {
      // The refusal names the booking or PO and the rule, so it goes through as it came.
      toast.error(error instanceof ApiError ? error.message : 'Could not create that plan.');
    } finally {
      setBusy(false);
    }
  }

  const size = sizes.find((s) => s.id === sizeId);
  const percentOf = (used: string | undefined, limit: string | null | undefined): number | null =>
    used === undefined || limit === null || limit === undefined || Number(limit) === 0
      ? null
      : (Number(used) / Number(limit)) * 100;
  const volumePct = percentOf(check?.totalCbm, size?.maxVolumeCbm);
  const weightPct = percentOf(check?.totalGrossKg, size?.maxWeightKg);
  const suggestions = (current?.suggestions ?? []).filter((g) => g.shipmentIds.length > 1);

  return (
    <div className="flex flex-col gap-3">
      {preselectIssue !== null && (
        <p className="rounded-manifest border border-alert/40 bg-alert/5 px-3 py-2 text-body text-hull">
          <span className="label-manifest text-alert">Cannot be planned yet</span>{' '}
          {preselectIssue}
        </p>
      )}

      {/* Suggestions: quiet, one line, never mistaken for a rule. */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-cell text-steel">
          <span className="label-manifest">Same sailing</span>
          {suggestions.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => applySuggestion(g)}
              className="rounded-manifest border border-line bg-surface px-2.5 py-1 font-mono tabular-nums text-hull transition-colors duration-[120ms] hover:border-harbour"
            >
              {g.shipmentIds.length} bookings · {g.totalCtnQty} CTN · {num(g.totalCbm)} CBM
            </button>
          ))}
          <span>— tick them all, then untick what does not belong.</span>
        </div>
      )}

      {loading || current === null ? (
        <p className="text-body text-steel">Loading…</p>
      ) : candidates.length === 0 ? (
        <EmptyState
          title="Nothing waiting to be planned"
          description={
            search.trim() !== ''
              ? 'No booking with cargo received matches that search.'
              : family === ''
                ? 'A booking appears here once its cargo has been received and accepted at the CFS.'
                : `No ${familyInSentence(family)} booking has cargo received and accepted at the CFS yet.`
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-[900px] border-collapse text-cell">
            <thead className="sticky top-0 z-20">
              <tr className="bg-paper">
                <th className="w-10 border-b border-line px-3 py-2">
                  <span className="sr-only">Every PO of the booking</span>
                </th>
                {[
                  ['Booking No', 'left'],
                  ['Exporter → Importer', 'left'],
                  ['', 'left'],
                  ['PO', 'left'],
                  ['EFR No', 'left'],
                  ['CTN', 'right'],
                  ['CBM', 'right'],
                  ['G.WT', 'right'],
                  ['Sailing', 'left'],
                ].map(([text, align], index) => (
                  <th
                    key={`${text}-${index}`}
                    className={`label-manifest whitespace-nowrap border-b border-line px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'} ${text === '' ? 'w-10' : ''}`}
                  >
                    {text === '' ? <span className="sr-only">This PO</span> : text}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const lead = group.bookings[0]!;
                /*
                  Required Container belongs to the quotation, so it is only
                  "none" when every booking under it is a consol box — one
                  quotation can carry an FCL and an LCL booking side by side.
                */
                const allConsol = group.bookings.every((b) => b.loadingType === 'CONSOL_BOX');
                return (
                  <Fragment key={group.key}>
                    {/*
                      What the bookings under one quotation share, drawn once —
                      the client's sheet merges the Inquiry and Quotation cells
                      down every booking the same way.
                    */}
                    <tr className="border-b border-line bg-paper/60">
                      <td colSpan={COLUMNS} className="px-3 py-1.5">
                        <span className="whitespace-nowrap font-mono tabular-nums text-hull">
                          {lead.inquiryCode ?? 'No inquiry'} · {lead.quotationCode ?? 'No quotation'}
                        </span>
                        {/* One quotation is one customer, so the name is said once, here. */}
                        <span className="ml-3 text-hull">{lead.customerName}</span>
                        <span className="ml-3 text-steel">
                          {lead.polName} → {lead.podName} · {lead.carrierName} · Required{' '}
                          <span className="font-mono tabular-nums text-hull">
                            {requiredLabel(allConsol ? 'CONSOL_BOX' : null, lead.requiredContainer)}
                          </span>
                        </span>
                      </td>
                    </tr>
                    {group.bookings.map((c) => (
                      <BookingRows
                        key={c.shipmentId}
                        booking={c}
                        groupCustomer={lead.customerName}
                        picked={picked}
                        failed={blocking.some((b) => b.shipmentId === c.shipmentId)}
                        onTogglePo={togglePo}
                        onToggleBooking={toggleBooking}
                      />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------- the selection and what it would load */}
      {picked.length > 0 && (
        <section className="sticky bottom-0 z-30 rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-section text-hull">
              {picked.length} PO{picked.length === 1 ? '' : 's'} ticked
              <span className="ml-2 text-body font-normal text-steel">
                {tickedBookings.length} booking{tickedBookings.length === 1 ? '' : 's'} ·{' '}
                {tickedCustomers} customer{tickedCustomers === 1 ? '' : 's'}
              </span>
            </h2>
            {/* What the ticked POs would put in the box, moving as boxes are ticked. */}
            <p className="font-mono text-cell tabular-nums text-hull">
              {check?.totalCtnQty ?? 0} CTN · {num(check?.totalCbm)} CBM ·{' '}
              {num(check?.totalGrossKg, 0)} kg
              {size !== undefined && volumePct !== null && (
                <span className={volumePct > 100 ? 'ml-3 text-alert' : 'ml-3 text-steel'}>
                  {volumePct.toFixed(1)}% volume
                </span>
              )}
              {size !== undefined && weightPct !== null && (
                <span className={weightPct > 100 ? 'ml-2 text-alert' : 'ml-2 text-steel'}>
                  {weightPct.toFixed(1)}% weight of a {size.code}
                </span>
              )}
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
              <Status tone="active">
                {tickedBookings.length > 1 ? 'These can travel together' : 'Ready to plan'}
              </Status>
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

            <Field id="cfs" label="Stuffed at" hint="Chosen, not guessed — a booking can arrive at several CFS.">
              <Input
                id="cfs"
                value={cfs}
                onChange={(event) => setCfs(event.target.value)}
                placeholder={check?.cfsLocations[0] ?? 'CFS location'}
                className="w-64"
              />
            </Field>

            <div className="ml-auto flex items-center gap-3">
              <Button variant="secondary" size="inline" onClick={() => setPicked([])} disabled={busy}>
                Clear
              </Button>
              {mayCreate && (
                <Button variant="primary" disabled={!ready || busy} onClick={() => void create()}>
                  {checking ? 'Checking…' : busy ? 'Creating…' : 'Create container plan'}
                </Button>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One booking and its POs — the booking's cells drawn once down all of them,
 * the way the client's sheet merges them.
 */
function BookingRows({
  booking,
  groupCustomer,
  picked,
  failed,
  onTogglePo,
  onToggleBooking,
}: {
  booking: ClpCandidateRow;
  /** The quotation's customer, already shown on the group header. */
  groupCustomer: string;
  picked: string[];
  failed: boolean;
  onTogglePo: (poId: string) => void;
  onToggleBooking: (booking: ClpCandidateRow) => void;
}) {
  const open = loadable(booking);
  const tickedHere = open.filter((id) => picked.includes(id)).length;
  const all = open.length > 0 && tickedHere === open.length;
  const some = tickedHere > 0 && !all;
  const span = Math.max(1, booking.pos.length);
  const tone = failed ? 'bg-alert/5' : tickedHere > 0 ? 'bg-harbour/5' : '';
  const cell = `px-3 py-2 align-top ${tone}`;

  const leading = (
    <>
      <td rowSpan={span} className={cell}>
        <input
          type="checkbox"
          aria-label={`Include every PO of ${booking.code}`}
          checked={all}
          ref={(el) => {
            if (el !== null) el.indeterminate = some;
          }}
          disabled={open.length === 0}
          onChange={() => onToggleBooking(booking)}
          className="mt-0.5 size-4 accent-[var(--color-harbour)]"
        />
      </td>
      {/* §12: the business code on its stencilled gutter, never wrapped. */}
      <td rowSpan={span} className={`px-3 py-2 align-top ${tone === '' ? 'bg-paper/60' : tone}`}>
        <span className="block whitespace-nowrap font-mono tabular-nums text-hull">{booking.code}</span>
        {/*
          Open sits with the booking it opens rather than in a column of its
          own — that column was the one a 1280px laptop pushed off screen.
        */}
        <span className="block whitespace-nowrap text-cell text-steel">
          {loadingLabel(booking.loadingType)}
          {/*
            Only while nothing of it is planned: once cargo is in a container,
            the planned PO rows carry the one button that opens it.
          */}
          {booking.plannedCtnQty === 0 && (
            <>
              {' · '}
              <Link
                href={`/operation/container-load-plan/${booking.shipmentId}` as Route}
                className="text-harbour hover:underline"
                aria-label={`Open the plan for ${booking.code}`}
              >
                Open
              </Link>
            </>
          )}
        </span>
        {/* Only when it is not the quotation's customer, which the header already names. */}
        {booking.customerName !== groupCustomer && (
          <span className="block text-cell text-hull">{booking.customerName}</span>
        )}
      </td>
      <td rowSpan={span} className={cell}>
        <span className="block text-hull">{booking.exporterName ?? '—'}</span>
        {booking.importerName !== null && (
          <span className="block text-cell text-steel">to {booking.importerName}</span>
        )}
      </td>
    </>
  );

  const trailing = (
    <>
      <td rowSpan={span} className={cell}>
        {booking.vesselName === null ? (
          <span className="text-signal">No approved sailing</span>
        ) : (
          <span className="block font-mono tabular-nums text-hull">
            {booking.vesselName}{' '}
            <span className="whitespace-nowrap">{booking.voyageNo ?? ''}</span>
          </span>
        )}
        <span className="block whitespace-nowrap text-cell text-steel">
          Cut-off <span className="font-mono tabular-nums">{day(booking.cutOffDate)}</span>
        </span>
      </td>
    </>
  );

  if (booking.pos.length === 0) {
    return (
      <tr className="border-b border-line">
        {leading}
        <td colSpan={6} className="px-3 py-2 text-steel">
          No PO has cargo received yet.
        </td>
        {trailing}
      </tr>
    );
  }

  return (
    <>
      {booking.pos.map((po, index) => {
        const chosen = picked.includes(po.poId);
        const done = po.ctnQty === 0;
        // The whole PO row takes the tint, so a ticked line reads as one band.
        const tint = failed ? 'bg-alert/5' : chosen ? 'bg-harbour/5' : '';
        const last = index === booking.pos.length - 1;
        return (
          <tr key={po.poId} className={last ? 'border-b border-line' : 'border-b border-line/50'}>
            {index === 0 && leading}
            <td className={`px-3 py-2 ${tint}`}>
              <input
                type="checkbox"
                aria-label={`Include ${po.poNo} of ${booking.code}`}
                checked={chosen}
                disabled={done}
                onChange={() => onTogglePo(po.poId)}
                className="size-4 accent-[var(--color-harbour)]"
              />
            </td>
            <td className={`whitespace-nowrap px-3 py-2 font-mono tabular-nums text-hull ${tint}`}>
              {po.poNo}
            </td>
            <td className={`whitespace-nowrap px-3 py-2 font-mono tabular-nums text-hull ${tint}`}>
              {po.efrNos.length === 0 ? <span className="text-steel">—</span> : po.efrNos.join(', ')}
            </td>
            {done ? (
              /*
                Every received carton is in a container: say which one, and
                give the one button that opens it — a Draft to change, a
                Final to look at.
              */
              <td colSpan={3} className={`px-3 py-2 ${tint}`}>
                <span className="flex items-center justify-end gap-3 whitespace-nowrap">
                  <Status tone="active">
                    Planned in{' '}
                    <span className="font-mono tabular-nums">
                      {po.plans.map((plan) => plan.code).join(', ')}
                    </span>
                  </Status>
                  {po.plans[0] !== undefined && (
                    <Button variant="secondary" size="inline" asChild>
                      <Link
                        href={planHref(booking.shipmentId, po.plans[0].clpId)}
                        aria-label={`${viewLabel(po.plans)} the plan holding ${po.poNo}`}
                      >
                        {viewLabel(po.plans)}
                      </Link>
                    </Button>
                  )}
                </span>
              </td>
            ) : (
              <>
                <td className={`whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-hull ${tint}`}>
                  {po.ctnQty}
                  {po.ctnQty < po.receivedCtnQty && (
                    <span className="ml-1 text-steel">of {po.receivedCtnQty}</span>
                  )}
                  {/* Part of it is already planned — the same button, smaller. */}
                  {po.plans[0] !== undefined && (
                    <Link
                      href={planHref(booking.shipmentId, po.plans[0].clpId)}
                      className="block font-sans text-cell text-harbour hover:underline"
                      aria-label={`${viewLabel(po.plans)} the plan holding part of ${po.poNo}`}
                    >
                      {po.receivedCtnQty - po.ctnQty} planned · {viewLabel(po.plans)}
                    </Link>
                  )}
                </td>
                <td className={`whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-hull ${tint}`}>
                  {num(po.cbm)}
                </td>
                <td className={`whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-steel ${tint}`}>
                  {num(po.grossKg, 0)}
                </td>
              </>
            )}
            {index === 0 && trailing}
          </tr>
        );
      })}
    </>
  );
}
