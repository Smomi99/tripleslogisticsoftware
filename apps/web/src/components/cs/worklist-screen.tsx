'use client';

import {
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_WORKLISTS,
  type ShipmentStatus,
  type ShipmentWorklistId,
  type ShipmentWorklistRow,
  worklistStatuses,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The direct list screens for Approval, Shipping Order and Cargo Receipt.
 *
 * Client decision, 2026-09-03. Until now each of these was a tab you could
 * only reach by finding its booking first, which asks the operator to already
 * know the answer to the question they came with: what is waiting on me?
 *
 * One component for all three. They differ in which statuses they cover, what
 * their computed column says and which tab a row opens — and every one of
 * those comes from SHIPMENT_WORKLISTS, which the API reads too. The screen
 * decides nothing about scope on its own.
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

/** What the computed column is called on each screen. */
const DETAIL_HEADER: Record<ShipmentWorklistId, string> = {
  APPROVAL: 'POs',
  SHIPPING_ORDER: 'Order',
  CARGO_RECEIPT: 'Received',
};

/** The endpoint behind each, each with its own permission on the server. */
const ENDPOINT: Record<ShipmentWorklistId, string> = {
  APPROVAL: '/api/tenant/cs/shipment-approvals',
  SHIPPING_ORDER: '/api/tenant/cs/shipping-orders',
  CARGO_RECEIPT: '/api/tenant/ops/cargo-receipts',
};

const DESCRIPTION: Record<ShipmentWorklistId, string> = {
  APPROVAL: 'Bookings with a schedule in front of the customer, and the ones already decided.',
  SHIPPING_ORDER: 'Bookings cleared to ship, and the orders already issued against them.',
  CARGO_RECEIPT: 'Bookings with cargo still to arrive, and what has come in so far.',
};

const EMPTY: Record<ShipmentWorklistId, { title: string; description: string }> = {
  APPROVAL: {
    title: 'Nothing awaiting approval',
    description:
      'A booking arrives here once a vessel or flight has been proposed to the customer.',
  },
  SHIPPING_ORDER: {
    title: 'Nothing to instruct',
    description:
      'A booking arrives here once the customer has approved at least one PO on the schedule.',
  },
  CARGO_RECEIPT: {
    title: 'No cargo expected',
    description:
      'A booking arrives here once its shipping order is issued, or skipped on an inbound.',
  },
};

interface Meta {
  page: number;
  limit: number;
  total: number;
}

export function WorklistScreen({ worklist }: { worklist: ShipmentWorklistId }) {
  const config = SHIPMENT_WORKLISTS[worklist];
  const { authorizedList, can } = useSession();

  const [rows, setRows] = useState<ShipmentWorklistRow[]>([]);
  const [meta, setMeta] = useState<Meta>({ page: 1, limit: 25, total: 0 });
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'AWAITING' | 'ALL'>('AWAITING');
  const [mode, setMode] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounced, like every other search box in the product (§8).
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setPending(true);

    const params = new URLSearchParams({ page: String(page), limit: '25', show });
    if (search !== '') params.set('search', search);
    if (mode !== '') params.set('shipmentType', mode);
    if (sortBy !== '') {
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
    }

    void authorizedList<ShipmentWorklistRow[]>(`${ENDPOINT[worklist]}?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setRows(result.data);
        if (result.meta !== undefined) setMeta(result.meta);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load the list.');
        }
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authorizedList, mode, page, search, show, sortBy, sortOrder, worklist]);

  const columns: DataTableColumn<ShipmentWorklistRow>[] = useMemo(
    () => [
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      {
        id: 'shipmentType',
        header: 'Type',
        cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea'),
      },
      // Sea and air share this screen, so the header names both.
      { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
      { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
      { id: 'etd', header: 'ETD', numeric: true, sortable: true, cell: (r) => r.etd ?? '—' },
      { id: 'eta', header: 'ETA', numeric: true, sortable: true, cell: (r) => r.eta ?? '—' },
      {
        // The one column that differs per screen: POs decided, the order's
        // number, cartons outstanding. Computed by the API, which is the only
        // thing that has counted them.
        id: 'detail',
        header: DETAIL_HEADER[worklist],
        cell: (r) => r.detail,
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (r) => <Status tone={TONE[r.status]}>{SHIPMENT_STATUS_LABEL[r.status]}</Status>,
      },
    ],
    [worklist],
  );

  /*
   * "All" is the widest view, not a filter. Counting it as one meant an empty
   * queue offered "Clear filters" — a dead end, because clearing them narrows
   * the list rather than widening it. Only a search or a mode hides rows that
   * are really there.
   */
  const hasFilters = search !== '' || mode !== '';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={config.label} description={DESCRIPTION[worklist]} />

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
          <span className="label-manifest">Show</span>
          <Select
            aria-label="Awaiting action or all"
            value={show}
            onChange={(e) => {
              setShow(e.target.value === 'ALL' ? 'ALL' : 'AWAITING');
              setPage(1);
            }}
          >
            <option value="AWAITING">Awaiting action</option>
            <option value="ALL">All</option>
          </Select>
        </div>
        <div className="flex w-40 flex-col gap-1">
          <span className="label-manifest">Mode</span>
          <Select
            aria-label="Sea or air"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Sea and air</option>
            <option value="SEA">Sea</option>
            <option value="AIR">Air</option>
          </Select>
        </div>
      </div>

      {/* What "awaiting action" means here, said once rather than guessed at. */}
      <p className="text-cell text-steel">
        {show === 'AWAITING'
          ? `Waiting on: ${config.waiting}`
          : `Every booking this screen covers: ${worklistStatuses(worklist)
              .map((s) => SHIPMENT_STATUS_LABEL[s])
              .join(', ')}.`}
      </p>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
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
        actions={(row) => (
          <>
            {/*
              Straight to the tab that does the work — the whole point of the
              screen. The booking is still one click away underneath it.
            */}
            {can(`${config.feature}.VIEW`) && (
              <Link
                href={`/cs/shipment-booking/${row.id}?tab=${config.tab}`}
                className="text-body text-harbour hover:underline"
              >
                {row.awaiting ? 'Open' : 'Review'}
              </Link>
            )}
            <Link
              href={`/cs/shipment-booking/${row.id}`}
              className="text-body text-steel hover:underline"
            >
              Booking
            </Link>
          </>
        )}
        empty={
          hasFilters ? (
            <EmptyState
              title="Nothing matches those filters"
              description="Try a different term, or clear them to see the whole queue."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearchInput('');
                    setMode('');
                    setShow('AWAITING');
                    setPage(1);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={EMPTY[worklist].title}
              description={EMPTY[worklist].description}
              action={
                <Link
                  href="/cs/shipment-booking-sea"
                  className="text-body text-harbour hover:underline"
                >
                  Go to the booking list
                </Link>
              }
            />
          )
        }
      />
    </div>
  );
}
