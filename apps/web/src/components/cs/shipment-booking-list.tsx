'use client';

import {
  SHIPMENT_LIST_TAB_LABEL,
  SHIPMENT_LIST_TAB_STATUSES,
  SHIPMENT_LIST_TABS,
  SHIPMENT_STATUS_LABEL,
  type ShipmentListRow,
  type ShipmentListTab,
  type ShipmentStatus,
  type ShipmentTabCountsDto,
  shipmentAction,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { EfrNos, groupColours } from '@/components/cs/efr-nos';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { Tabs } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The Booking List — §6.2, one component for both menu items.
 *
 * §3 splits the menu into Shipment Booking - Sea and - Air; §7 keeps them one
 * permission. So the mode is a filter on one screen rather than a fork, the
 * same decision the booking form makes.
 *
 * The Action column is the point of this screen. §5.1: "The Action button on
 * the Booking List is derived from status, never stored." It is computed here
 * by `shipmentAction`, reading the same table the API guards transitions with —
 * so a button can never offer a move the server would refuse.
 */

/**
 * Where each next action happens.
 *
 * Keyed on the permission `shipmentAction` returns rather than on the label,
 * because the label changes with the mode ("Vsl Booking" / "Flight Booking")
 * and the permission does not.
 */
const TAB_FOR: Record<string, string> = {
  'CUSTOMER_SERVICE.SCHEDULE.CREATE': 'schedule',
  'CUSTOMER_SERVICE.SHIPPING_ORDER.VIEW': 'shipping-order',
  'OPERATION.CARGO_RECEIPT.VIEW': 'cargo-receipt',
  // Documentation (MODULE_DOCUMENTATION): the advise, the draft, and BL Print's
  // Issue BL all work on the booking's own tabs.
  'DOCUMENTATION.SHIPMENT_ADVISE.VIEW': 'shipment-advise',
  'DOCUMENTATION.BL_DRAFT.VIEW': 'bl',
  'DOCUMENTATION.BL_PRINT.VIEW': 'bl',
};

const TONE: Record<ShipmentStatus, 'active' | 'pending' | 'inactive' | 'overdue'> = {
  BOOKING_RECEIVED: 'pending',
  VESSEL_PROPOSED: 'pending',
  APPROVED_FOR_SHIPMENT: 'active',
  REJECTED: 'overdue',
  SO_ISSUED: 'active',
  SO_SKIPPED: 'active',
  PART_RECEIVED: 'pending',
  CARGO_RECEIVED: 'active',
  ADVISED: 'active',
  BL_DRAFTED: 'active',
  BL_ISSUED: 'active',
  SHORT_CLOSED: 'inactive',
  CANCELLED: 'overdue',
};

interface Meta {
  page: number;
  limit: number;
  total: number;
}

export function ShipmentBookingList({ mode }: { mode: 'SEA' | 'AIR' }) {
  const { authorizedList, authorizedRequest, can } = useSession();

  const [rows, setRows] = useState<ShipmentListRow[]>([]);
  const [meta, setMeta] = useState<Meta>({ page: 1, limit: 25, total: 0 });
  const [page, setPage] = useState(1);
  /*
   * Owner, 2026-11-20: two tabs — the bookings still being worked, and the
   * cancelled ones — and a From / To on the day each booking was made.
   */
  const [tab, setTab] = useState<ShipmentListTab>('ACTIVE');
  const [tabCounts, setTabCounts] = useState<ShipmentTabCountsDto | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState<'OWN' | 'ALL'>('ALL');
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounced, like every other search box in the product (§8).
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setPending(true);

    // The filters the tab counts share with the list: everything but the
    // tab, the status within it, and the page.
    const filters = new URLSearchParams({ shipmentType: mode, scope });
    if (search !== '') filters.set('search', search);
    if (fromDate !== '') filters.set('fromDate', fromDate);
    if (toDate !== '') filters.set('toDate', toDate);

    const params = new URLSearchParams(filters);
    params.set('tab', tab);
    params.set('page', String(page));
    params.set('limit', '25');
    params.set('sortOrder', sortOrder);
    if (status !== '') params.set('status', status);
    if (sortBy !== '') params.set('sortBy', sortBy);

    void authorizedList<ShipmentListRow[]>(`/api/tenant/cs/bookings?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setRows(result.data);
        if (result.meta !== undefined) setMeta(result.meta);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load the bookings.');
        }
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });

    // Each tab's count, fetched with the list so the two never disagree. A
    // failed count drops the numbers rather than showing stale ones.
    void authorizedRequest<ShipmentTabCountsDto>(
      `/api/tenant/cs/bookings/tab-counts?${filters.toString()}`,
    )
      .then((counts) => {
        if (!cancelled) setTabCounts(counts);
      })
      .catch(() => {
        if (!cancelled) setTabCounts(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    authorizedList,
    authorizedRequest,
    fromDate,
    mode,
    page,
    scope,
    search,
    sortBy,
    sortOrder,
    status,
    tab,
    toDate,
  ]);

  const isAir = mode === 'AIR';
  const hasFilters = search !== '' || status !== '' || fromDate !== '' || toDate !== '';
  // The open tab's statuses. Cancelled is one status, so it has nothing to choose.
  const tabStatuses = SHIPMENT_LIST_TAB_STATUSES[tab];

  function changeTab(next: ShipmentListTab): void {
    setTab(next);
    // A status belongs to one tab, so it does not travel; the page starts again.
    setStatus('');
    setPage(1);
  }

  function clearFilters(): void {
    setSearchInput('');
    setSearch('');
    setStatus('');
    setFromDate('');
    setToDate('');
    setPage(1);
  }

  // CR-005: one colour per advise group, in the order the groups appear.
  const colours = useMemo(() => groupColours(rows), [rows]);

  const columns: DataTableColumn<ShipmentListRow>[] = useMemo(
    () => [
      // The day the booking was made — what From / To filter on.
      {
        id: 'bookingDate',
        header: 'Booking Date',
        numeric: true,
        sortable: true,
        cell: (r) => r.bookingDate,
      },
      {
        id: 'quotationCode',
        header: 'Quotation No',
        numeric: true,
        // Whole, like the EFR beside it — a code broken over three lines misreads.
        cell: (r) => <span className="whitespace-nowrap">{r.quotationCode}</span>,
      },
      // From the confirmed cargo receipts, so blank until the cargo is in.
      {
        id: 'efr',
        header: 'EFR No',
        numeric: true,
        cell: (r) => <EfrNos values={r.efrNos} code={r.code} group={r.efrGroup} colours={colours} />,
      },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      { id: 'commodity', header: 'Commodity', cell: (r) => r.commodity },
      {
        id: 'shipmentType',
        header: 'Shipment Type',
        cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea'),
      },
      // Port NAME first, the way every other table in the product reads.
      { id: 'pol', header: isAir ? 'AOL' : 'POL', cell: (r) => r.polName },
      { id: 'pod', header: isAir ? 'AOD' : 'POD', cell: (r) => r.podName },
      {
        id: 'requiredContainer',
        header: 'Required Container',
        numeric: true,
        cell: (r) => r.requiredContainer,
      },
      { id: 'transitType', header: 'Transit Type', cell: (r) => r.transitType ?? '—' },
      {
        id: 'goodsHandoverDate',
        header: 'Goods H/DT',
        numeric: true,
        sortable: true,
        cell: (r) => r.goodsHandoverDate ?? '—',
      },
      { id: 'etd', header: 'ETD', numeric: true, sortable: true, cell: (r) => r.etd ?? '—' },
      { id: 'eta', header: 'ETA', numeric: true, sortable: true, cell: (r) => r.eta ?? '—' },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (r) => (
          <Status tone={TONE[r.status]}>{SHIPMENT_STATUS_LABEL[r.status]}</Status>
        ),
      },
    ],
    [isAir, colours],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Shipment Booking - ${isAir ? 'Air' : 'Sea'}`}
        description="Bookings raised against an accepted quotation, and what each one is waiting on."
      />

      <Tabs
        label="Booking status"
        value={tab}
        onChange={changeTab}
        tabs={SHIPMENT_LIST_TABS.map((t) => ({
          id: t,
          label: SHIPMENT_LIST_TAB_LABEL[t],
          count: tabCounts?.[t],
        }))}
      />

      <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
        <div className="col-span-2 flex flex-col gap-1 sm:w-72">
          <span className="label-field">Search</span>
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Booking no, quotation no or customer"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        {/* The booking date, both days included. */}
        <label className="flex min-w-0 flex-col gap-1 sm:w-40">
          <span className="label-field">From</span>
          <Input
            type="date"
            numeric
            value={fromDate}
            max={toDate === '' ? undefined : toDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 sm:w-40">
          <span className="label-field">To</span>
          <Input
            type="date"
            numeric
            value={toDate}
            min={fromDate === '' ? undefined : fromDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setPage(1);
            }}
          />
        </label>
        {tabStatuses.length > 1 && (
          <div className="flex min-w-0 flex-col gap-1 sm:w-52">
            <span className="label-field">Status</span>
            <Select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {tabStatuses.map((s) => (
                <option key={s} value={s}>
                  {SHIPMENT_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </div>
        )}
        {/* §7's VIEW_ALL. Hidden from anyone who only ever sees their own. */}
        {can('CUSTOMER_SERVICE.CARGO_BOOKING.VIEW_ALL') && (
          <div className="flex min-w-0 flex-col gap-1 sm:w-44">
            <span className="label-field">Show</span>
            <Select
              aria-label="Filter by owner"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value === 'OWN' ? 'OWN' : 'ALL');
                setPage(1);
              }}
            >
              <option value="ALL">Everyone&apos;s</option>
              <option value="OWN">Mine</option>
            </Select>
          </div>
        )}
        {hasFilters && (
          <Button variant="secondary" onClick={clearFilters} className="col-span-2">
            Clear filters
          </Button>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={meta.total}
        page={page}
        limit={meta.limit}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={(by, order) => {
          setSortBy(by);
          setSortOrder(order);
          setPage(1);
        }}
        onPageChange={setPage}
        isPending={isPending}
        actions={(row) => {
          // §5.1: derived from the status, every time, from the same table the
          // API guards the transition with.
          const next = shipmentAction(row.status, row.shipmentType);
          return (
            <>
              <Link
                href={`/cs/shipment-booking/${row.id}`}
                className="text-body text-harbour hover:underline"
              >
                View
              </Link>
              {row.status === 'BOOKING_RECEIVED' &&
                can('CUSTOMER_SERVICE.CARGO_BOOKING.EDIT') && (
                  <Link
                    href={`/cs/shipment-booking/${row.id}`}
                    className="text-body text-harbour hover:underline"
                  >
                    Edit
                  </Link>
                )}
              {next.permission === null ? (
                // "Awaiting Shipment Approval" is a statement, not an action:
                // the customer is the one who acts next. Drawn as a disabled
                // button, so it does not pass for one in the row's action pills.
                <Button variant="text" size="inline" disabled className="text-steel">
                  {next.label}
                </Button>
              ) : (
                // A terminal booking's next action IS View, which the link
                // above already is — drawing it twice would say nothing twice.
                next.label !== 'View' &&
                can(next.permission) && (
                  /*
                    Every one of these tabs exists now, so each is a link to the
                    one that does the work. It used to draw a disabled button
                    saying the screen had not arrived — true when phase E
                    shipped, and stale from phase H onward.
                  */
                  <Link
                    href={`/cs/shipment-booking/${row.id}?tab=${TAB_FOR[next.permission] ?? 'overview'}`}
                    className="text-body text-harbour hover:underline"
                  >
                    {next.label}
                  </Link>
                )
              )}
            </>
          );
        }}
        empty={
          hasFilters ? (
            <EmptyState
              title="No bookings match those filters"
              description="Try a different term or a wider date range, or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : tab === 'CANCELLED' ? (
            <EmptyState
              title={`No cancelled ${isAir ? 'air' : 'sea'} bookings`}
              description="A booking moves here when it is cancelled. The ones still being worked are on the Active tab."
            />
          ) : (
            <EmptyState
              title={`No ${isAir ? 'air' : 'sea'} bookings yet`}
              description="A booking starts from an accepted quotation — open one and use its Booking action."
              action={
                <Link href="/cs/quotation" className="text-body text-harbour hover:underline">
                  Go to the quotation list
                </Link>
              }
            />
          )
        }
      />
    </div>
  );
}
