'use client';

import {
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_STATUSES,
  type ShipmentListRow,
  type ShipmentStatus,
  shipmentAction,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
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

const TONE: Record<ShipmentStatus, 'active' | 'pending' | 'inactive' | 'overdue'> = {
  BOOKING_RECEIVED: 'pending',
  VESSEL_PROPOSED: 'pending',
  APPROVED_FOR_SHIPMENT: 'active',
  REJECTED: 'overdue',
  SO_ISSUED: 'active',
  SO_SKIPPED: 'active',
  PART_RECEIVED: 'pending',
  CARGO_RECEIVED: 'active',
  SHORT_CLOSED: 'inactive',
  CANCELLED: 'overdue',
};

interface Meta {
  page: number;
  limit: number;
  total: number;
}

export function ShipmentBookingList({ mode }: { mode: 'SEA' | 'AIR' }) {
  const { authorizedList, can } = useSession();

  const [rows, setRows] = useState<ShipmentListRow[]>([]);
  const [meta, setMeta] = useState<Meta>({ page: 1, limit: 25, total: 0 });
  const [page, setPage] = useState(1);
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

    const params = new URLSearchParams({
      page: String(page),
      limit: '25',
      shipmentType: mode,
      scope,
      sortOrder,
    });
    if (search !== '') params.set('search', search);
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

    return () => {
      cancelled = true;
    };
  }, [authorizedList, mode, page, scope, search, sortBy, sortOrder, status]);

  const isAir = mode === 'AIR';
  const hasFilters = search !== '' || status !== '';

  const columns: DataTableColumn<ShipmentListRow>[] = useMemo(
    () => [
      {
        id: 'quotationCode',
        header: 'Quotation No',
        numeric: true,
        cell: (r) => r.quotationCode,
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
    [isAir],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Shipment Booking - ${isAir ? 'Air' : 'Sea'}`}
        description="Bookings raised against an accepted quotation, and what each one is waiting on."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Booking no, quotation no or customer"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-52 flex-col gap-1">
          <span className="label-manifest">Status</span>
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {SHIPMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SHIPMENT_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        {/* §7's VIEW_ALL. Hidden from anyone who only ever sees their own. */}
        {can('CUSTOMER_SERVICE.CARGO_BOOKING.VIEW_ALL') && (
          <div className="flex w-44 flex-col gap-1">
            <span className="label-manifest">Show</span>
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
                // "Awaiting Shipment Approval" is a statement, not a button:
                // the customer is the one who acts next.
                <span className="text-body text-steel">{next.label}</span>
              ) : (
                // A terminal booking's next action IS View, which the link
                // above already is — drawing it twice would say nothing twice.
                next.label !== 'View' &&
                can(next.permission) &&
                (next.permission === 'CUSTOMER_SERVICE.SCHEDULE.CREATE' ? (
                  // §6.4's screen, which phase E built.
                  <Link
                    href={`/cs/shipment-booking/${row.id}?tab=schedule`}
                    className="text-body text-harbour hover:underline"
                  >
                    {next.label}
                  </Link>
                ) : (
                  <Button
                    variant="text"
                    size="inline"
                    disabled
                    title={`${next.label} arrives with the screen that does it`}
                  >
                    {next.label}
                  </Button>
                ))
              )}
            </>
          );
        }}
        empty={
          hasFilters ? (
            <EmptyState
              title="No bookings match that search"
              description="Try a different term, or clear the filters to see them all."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearchInput('');
                    setStatus('');
                    setPage(1);
                  }}
                >
                  Clear filters
                </Button>
              }
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
