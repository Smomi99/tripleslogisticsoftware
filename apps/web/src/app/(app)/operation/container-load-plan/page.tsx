'use client';

import type { ClpBookingRow, ClpListRow, ClpStatus } from '@ff/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Cargo Load Plan — MODULE_CLP.md §5.1's booking selector and §5.2's list of
 * CLPs, on one screen with a switch between them.
 *
 * They answer two different questions. "To plan" is the work queue: bookings
 * whose goods are in at CFS and which still need containers. "Container
 * plans" is §5.2's register: every CLP made, with its container number and
 * status, which is what somebody chasing a sailing opens.
 *
 * One screen rather than two menu items because they are the same job seen
 * from either end, and the sidebar maps one path per feature.
 */
type View = 'bookings' | 'clps';

/**
 * The FCL/LCL split — CR-002 §13.
 *
 * FCL and LCL are different jobs done by different people: an FCL planner
 * fills one customer's box, an LCL planner builds a consolidation out of many.
 * Reading both queues at once means scrolling past rows you can never act on.
 *
 * It is a filter, not a new engine. The classification is `shipment.
 * loading_type`, already stored, read through the same helper the creation
 * screen uses — CONSOL_BOX is FCL-like, and a booking with no loading type
 * appears under neither rather than being guessed into one. "All" stays the
 * default so the screen opens as it always has.
 */
type Family = '' | 'FCL' | 'LCL';

/** What the operator calls it, from what the booking stored. */
const loadingLabel = (loadingType: string | null): string =>
  loadingType === null
    ? '—'
    : loadingType === 'CONSOL_BOX'
      ? 'Consol box'
      : loadingType;

export default function ContainerLoadPlanPage() {
  const { authorizedList, can } = useSession();
  const [view, setView] = useState<View>('bookings');
  const [bookings, setBookings] = useState<ClpBookingRow[]>([]);
  const [clps, setClps] = useState<ClpListRow[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | ClpStatus>('');
  const [family, setFamily] = useState<Family>('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (term: string, which: View, clpStatus: string, fam: Family) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (term.trim() !== '') params.set('search', term.trim());
        if (which === 'clps' && clpStatus !== '') params.set('status', clpStatus);
        // Both lists take it: the queue filters on the booking's own loading
        // type, the register on its participating bookings'.
        if (fam !== '') params.set('family', fam);
        const qs = params.toString() === '' ? '' : `?${params.toString()}`;

        if (which === 'bookings') {
          const result = await authorizedList<ClpBookingRow[]>(
            `/api/tenant/ops/clp-bookings${qs}`,
          );
          setBookings(result.data);
        } else {
          const result = await authorizedList<ClpListRow[]>(`/api/tenant/ops/clps${qs}`);
          setClps(result.data);
        }
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not load that list.');
      } finally {
        setLoading(false);
      }
    },
    [authorizedList],
  );

  useEffect(() => {
    const id = setTimeout(() => void load(search, view, status, family), search === '' ? 0 : 300);
    return () => clearTimeout(id);
  }, [load, search, view, status, family]);

  const mayView = can('OPERATION.CONTAINER_LOAD_PLAN.VIEW');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cargo Load Plan"
        action={
          can('OPERATION.CONTAINER_LOAD_PLAN.CREATE') ? (
            <Button variant="primary" asChild>
              {/*
                Carries the chosen workflow through, so a planner reading the
                LCL queue does not land on the FCL creation screen and have to
                switch again.
              */}
              <Link
                href={
                  family === ''
                    ? '/operation/container-load-plan/new'
                    : `/operation/container-load-plan/new?family=${family}`
                }
              >
                + New container plan
              </Link>
            </Button>
          ) : undefined
        }
        description={
          (view === 'bookings'
            ? 'Bookings with cargo received at CFS, waiting to be planned into containers.'
            : 'Every container plan made, with its container number and status.') +
          (family === ''
            ? ''
            : family === 'FCL'
              ? ' Full containers and consol boxes only.'
              : ' LCL only.')
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        {/* The switch. Two questions, one screen. */}
        <div
          className="inline-flex rounded-manifest border border-line bg-surface p-0.5"
          role="tablist"
          aria-label="Which list to show"
        >
          {(
            [
              ['bookings', 'To plan'],
              ['clps', 'Container plans'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={
                view === key
                  ? 'rounded-[3px] bg-harbour px-3 py-1.5 text-cell font-semibold text-white'
                  : 'rounded-[3px] px-3 py-1.5 text-cell text-steel hover:text-hull'
              }
            >
              {label}
            </button>
          ))}
        </div>

        {/*
          The workflow switch, the same control as the one above it. Two
          switches rather than four combined tabs: which list and which
          workflow are independent questions, and folding them together would
          make "To plan, LCL" a different tab from "To plan, FCL" instead of
          the same list seen through a filter.
        */}
        <div
          className="inline-flex rounded-manifest border border-line bg-surface p-0.5"
          role="tablist"
          aria-label="Which loading type to show"
        >
          {(
            [
              ['', 'All'],
              ['FCL', 'FCL'],
              ['LCL', 'LCL'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key === '' ? 'all' : key}
              type="button"
              role="tab"
              aria-selected={family === key}
              onClick={() => setFamily(key)}
              className={
                family === key
                  ? 'rounded-[3px] bg-harbour px-3 py-1.5 text-cell font-semibold text-white'
                  : 'rounded-[3px] px-3 py-1.5 text-cell text-steel hover:text-hull'
              }
            >
              {label}
            </button>
          ))}
        </div>

        <Input
          type="search"
          placeholder={
            view === 'bookings' ? 'Booking number or customer' : 'CLP, container no, booking or customer'
          }
          /*
            Named for what it searches. The top bar carries a global search
            box, so two controls both called "Search" would leave a screen
            reader unable to tell them apart.
          */
          aria-label={view === 'bookings' ? 'Search bookings' : 'Search container plans'}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-80"
        />

        {view === 'clps' && (
          <Select
            aria-label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as '' | ClpStatus)}
            className="w-40"
          >
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="FINAL">Final</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        )}
      </div>

      {loading ? (
        <p className="text-body text-steel">Loading…</p>
      ) : view === 'bookings' ? (
        <BookingTable rows={bookings} mayView={mayView} family={family} />
      ) : (
        <ClpTable rows={clps} mayView={mayView} family={family} />
      )}
    </div>
  );
}

function BookingTable({
  rows,
  mayView,
  family,
}: {
  rows: ClpBookingRow[];
  mayView: boolean;
  family: Family;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={family === '' ? 'Nothing to plan yet' : `No ${family} booking to plan`}
        description={
          family === ''
            ? 'A booking appears here once its cargo has been received and accepted at the CFS.'
            : `A booking appears here once its cargo has been received and accepted at the CFS. There may still be work under the other loading type — try All.`
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
      <table className="w-full min-w-[1100px] border-collapse text-cell">
        <thead>
          <tr className="border-b border-line bg-paper">
            <th className="label-manifest px-3 py-2 text-left">Booking No</th>
            <th className="label-manifest px-3 py-2 text-left">S/O No</th>
            <th className="label-manifest px-3 py-2 text-left">Customer</th>
            <th className="label-manifest px-3 py-2 text-left">Exporter</th>
            <th className="label-manifest px-3 py-2 text-left">Commodity</th>
            <th className="label-manifest px-3 py-2 text-left">Loading</th>
            <th className="label-manifest px-3 py-2 text-left">POL</th>
            <th className="label-manifest px-3 py-2 text-left">POD</th>
            <th className="label-manifest px-3 py-2 text-left">Required Container</th>
            <th className="label-manifest px-3 py-2 text-left">Carrier</th>
            <th className="label-manifest px-3 py-2 text-right">Planned</th>
            <th className="label-manifest px-3 py-2 text-right">Unassigned CTN</th>
            <th className="label-manifest px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.shipmentId} className="border-b border-line last:border-0">
              <td className="px-3 py-2 font-mono tabular-nums text-hull">{row.code}</td>
              <td className="px-3 py-2 font-mono tabular-nums text-steel">
                {row.shippingOrderCode ?? '—'}
              </td>
              <td className="px-3 py-2 text-hull">{row.customerName}</td>
              <td className="px-3 py-2 text-steel">{row.exporterName ?? '—'}</td>
              <td className="px-3 py-2 text-steel">{row.commodity}</td>
              {/*
                Shown even when a workflow is chosen: inside FCL, a consol box
                is a different job from a customer's own full container, and
                the row should say which without being clicked.
              */}
              <td className="px-3 py-2 text-hull">{loadingLabel(row.loadingType)}</td>
              <td className="px-3 py-2 text-hull">{row.polName}</td>
              <td className="px-3 py-2 text-hull">{row.podName}</td>
              <td className="px-3 py-2 font-mono tabular-nums text-hull">
                {row.requiredContainer}
              </td>
              <td className="px-3 py-2 text-steel">{row.carrierName ?? '—'}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                {row.plannedCount}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {/*
                  The number that says whether this booking still needs work.
                  Zero left is the finish line, so it reads quietly rather than
                  as an alert.
                */}
                {row.unallocatedCtnQty === 0 ? (
                  <Status tone="active">All assigned</Status>
                ) : (
                  <span className="text-hull">{row.unallocatedCtnQty}</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                {mayView && (
                  <Button variant="text" size="inline" asChild>
                    <Link href={`/operation/container-load-plan/${row.shipmentId}`}>
                      {row.plannedCount === 0 ? 'Make CLP' : 'Open CLP'}
                    </Link>
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** §5.2's columns, one row per container plan. */
function ClpTable({
  rows,
  mayView,
  family,
}: {
  rows: ClpListRow[];
  mayView: boolean;
  family: Family;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={family === '' ? 'No container plans yet' : `No ${family} container plan`}
        description={
          family === ''
            ? 'Plan a booking into containers and its CLPs will be listed here.'
            : 'Plan a booking into containers and its CLPs will be listed here. There may be plans under the other loading type — try All.'
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
      <table className="w-full min-w-[1500px] border-collapse text-cell">
        <thead>
          <tr className="border-b border-line bg-paper">
            <th className="label-manifest px-3 py-2 text-left">CLP No</th>
            <th className="label-manifest px-3 py-2 text-left">Booking No</th>
            <th className="label-manifest px-3 py-2 text-left">S/O No</th>
            <th className="label-manifest px-3 py-2 text-left">Customer</th>
            <th className="label-manifest px-3 py-2 text-left">Exporter</th>
            <th className="label-manifest px-3 py-2 text-left">Commodity</th>
            <th className="label-manifest px-3 py-2 text-left">Type</th>
            <th className="label-manifest px-3 py-2 text-left">Loading</th>
            <th className="label-manifest px-3 py-2 text-left">POL/AOL</th>
            <th className="label-manifest px-3 py-2 text-left">POD/AOD</th>
            <th className="label-manifest px-3 py-2 text-left">Required Container</th>
            <th className="label-manifest px-3 py-2 text-left">Carrier</th>
            <th className="label-manifest px-3 py-2 text-left">Container No</th>
            <th className="label-manifest px-3 py-2 text-right">CTN</th>
            <th className="label-manifest px-3 py-2 text-left">Status</th>
            <th className="label-manifest px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2">
                <span className="font-mono tabular-nums text-hull">{row.code}</span>
                <span className="ml-2 text-steel">· {row.clpSeq}</span>
              </td>
              <td className="px-3 py-2 font-mono tabular-nums text-hull">{row.bookingCode}</td>
              <td className="px-3 py-2 font-mono tabular-nums text-steel">
                {row.shippingOrderCode ?? '—'}
              </td>
              <td className="px-3 py-2 text-hull">{row.customerName}</td>
              <td className="px-3 py-2 text-steel">{row.exporterName ?? '—'}</td>
              <td className="px-3 py-2 text-steel">{row.commodity}</td>
              <td className="px-3 py-2 text-steel">{row.shipmentType}</td>
              <td className="px-3 py-2 text-hull">
                {loadingLabel(row.loadingType)}
                {/*
                  A shared container is worth seeing from the register: it is
                  the one row where "whose cargo is in here" is not the single
                  booking in the column beside it.
                */}
                {row.bookingCount > 1 && (
                  <span className="ml-2 text-steel">+{row.bookingCount - 1}</span>
                )}
              </td>
              <td className="px-3 py-2 text-hull">{row.polName}</td>
              <td className="px-3 py-2 text-hull">{row.podName}</td>
              <td className="px-3 py-2 font-mono tabular-nums text-steel">
                {row.requiredContainer}
              </td>
              <td className="px-3 py-2 text-steel">{row.carrierName ?? '—'}</td>
              <td className="px-3 py-2 font-mono tabular-nums text-hull">
                {/*
                  Blank until finalised. A draft has no container number by
                  definition, so an em dash says "not yet" rather than looking
                  like missing data.
                */}
                {row.containerNo ?? <span className="text-steel">—</span>}
                <span className="ml-2 text-steel">{row.containerSizeCode}</span>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                {row.totalCtnQty}
              </td>
              <td className="px-3 py-2">
                <Status
                  tone={
                    row.status === 'FINAL'
                      ? 'active'
                      : row.status === 'CANCELLED'
                        ? 'inactive'
                        : 'pending'
                  }
                >
                  {row.status === 'FINAL' ? 'Final' : row.status === 'CANCELLED' ? 'Cancelled' : 'Draft'}
                </Status>
              </td>
              <td className="px-3 py-2 text-right">
                {mayView && (
                  <Button variant="text" size="inline" asChild>
                    <Link href={`/operation/container-load-plan/${row.shipmentId}`}>
                      {row.status === 'DRAFT' ? 'Finalise' : 'Open'}
                    </Link>
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
