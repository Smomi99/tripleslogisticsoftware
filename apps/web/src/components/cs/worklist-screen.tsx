'use client';

import {
  defaultWorklistView,
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_WORKLISTS,
  type ShipmentStatus,
  type ShipmentWorklistId,
  type ShipmentWorklistRow,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { BlPrintActions } from '@/components/doc/bl-print-actions';
import { CargoStockTable } from '@/components/ops/cargo-stock-table';
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
  ADVISED: 'active',
  BL_DRAFTED: 'active',
  BL_ISSUED: 'active',
  SHORT_CLOSED: 'inactive',
  CANCELLED: 'overdue',
};

/** What the computed column is called on each screen. */
const DETAIL_HEADER: Record<ShipmentWorklistId, string> = {
  APPROVAL: 'POs',
  SHIPPING_ORDER: 'Order',
  CARGO_RECEIPT: 'Received',
  SHIPMENT_ADVISE: 'Advise',
  BL_DRAFT: 'Draft',
  BL_PRINT: 'BL',
};

/** The endpoint behind each, each with its own permission on the server. */
const ENDPOINT: Record<ShipmentWorklistId, string> = {
  APPROVAL: '/api/tenant/cs/shipment-approvals',
  SHIPPING_ORDER: '/api/tenant/cs/shipping-orders',
  CARGO_RECEIPT: '/api/tenant/ops/cargo-receipts',
  SHIPMENT_ADVISE: '/api/tenant/documentation/shipment-advise',
  BL_DRAFT: '/api/tenant/documentation/bl-drafts/worklist',
  BL_PRINT: '/api/tenant/documentation/bl-print',
};

const DESCRIPTION: Record<ShipmentWorklistId, string> = {
  APPROVAL: 'Bookings with a schedule in front of the customer, and the ones already decided.',
  SHIPPING_ORDER: 'Bookings cleared to ship, and the orders already issued against them.',
  CARGO_RECEIPT: 'Bookings with cargo still to arrive, and what has come in so far.',
  SHIPMENT_ADVISE:
    'Bookings with the cargo in and the container planned, and the advises already sent.',
  BL_DRAFT: 'Bookings that have been advised, and the bills of lading drafted against them.',
  BL_PRINT: 'Approved bills of lading waiting to be issued, and the ones already issued.',
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
  SHIPMENT_ADVISE: {
    title: 'Nothing to advise',
    description:
      'A booking arrives here once its cargo has been received. Finalise the load plan, then build the advise.',
  },
  BL_DRAFT: {
    title: 'No bills of lading waiting',
    description:
      'A booking arrives here once its shipment advise has gone to the customer — that is where the BL number comes from.',
  },
  BL_PRINT: {
    title: 'No bills of lading to issue',
    description:
      'A booking arrives here once its BL draft is approved. Approve a draft on the BL Draft screen to issue and print it.',
  },
};

interface Meta {
  page: number;
  limit: number;
  total: number;
  counts?: Record<string, number>;
}

export function WorklistScreen({
  worklist,
  fixedMode,
}: {
  worklist: ShipmentWorklistId;
  /**
   * Pins the Sea/Air filter and hides the dropdown.
   *
   * The client's menu splits Shipment Advise into two items the way it splits
   * Shipment Booking, and the two sheets differ by shipment_type and nothing
   * else — so this is one screen with the filter already answered, not a
   * second screen.
   */
  fixedMode?: 'SEA' | 'AIR';
}) {
  const config = SHIPMENT_WORKLISTS[worklist];
  const { authorizedList, authorizedObjectUrl, can } = useSession();

  const [rows, setRows] = useState<ShipmentWorklistRow[]>([]);
  const [meta, setMeta] = useState<Meta>({ page: 1, limit: 25, total: 0 });
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<string>(() => defaultWorklistView(worklist));
  const [mode, setMode] = useState<string>(fixedMode ?? '');
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped after an act on a row (BL Print's Issue BL) moves it to another tab.
  const [reloadKey, setReloadKey] = useState(0);

  // Debounced, like every other search box in the product (§8).
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const active = config.views.find((v) => v.id === view) ?? config.views[0];
  /*
   * Available stock is not a slice of the status machine — it counts cartons in
   * hand that no load plan has claimed — so it has its own endpoint and its own
   * table below. The booking query is skipped entirely while it is open.
   */
  const isStock = active.statuses.length === 0;

  useEffect(() => {
    if (isStock) return;
    let cancelled = false;
    setPending(true);

    const params = new URLSearchParams({
      page: String(page),
      limit: '25',
      view,
    });
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
  }, [authorizedList, isStock, mode, page, reloadKey, search, sortBy, sortOrder, view, worklist]);

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
   * The tab is the screen, not a filter on it, so it is not counted here.
   * Counting it meant an empty tab offered "Clear filters" — a dead end,
   * because switching tabs is not what is hiding the rows. Only a search or a
   * mode hides rows that are really there.
   */
  const hasFilters = search !== '' || mode !== '';

  /*
   * The PDF is behind the same auth as everything else, so it cannot be a bare
   * href — the token has to go with the request, and the blob it hands back is
   * what the new tab opens.
   */
  async function printOrder(shipmentId: string): Promise<void> {
    try {
      const url = await authorizedObjectUrl(
        `/api/tenant/cs/bookings/${shipmentId}/shipping-order/pdf`,
      );
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open the shipping order.');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={config.label} description={DESCRIPTION[worklist]} />

      {/*
        The client names these screens by their tabs (spec, 2026-09-18) — the
        statuses are the screen, not a filter on it, so they sit above the
        search box rather than inside a dropdown with it.
      */}
      <div
        role="tablist"
        aria-label={`${config.label} views`}
        className="flex border-b border-line"
      >
        {config.views.map((v) => {
          const selected = v.id === active.id;
          const n = meta.counts?.[v.id];
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setView(v.id);
                setPage(1);
              }}
              className={`-mb-px border-b-[3px] px-4 py-2 text-body transition-colors duration-120 ease-out ${
                selected
                  ? 'border-harbour font-semibold text-hull'
                  : 'border-transparent text-steel hover:text-hull'
              }`}
            >
              {v.label}
              {/*
                Counted across the whole list, not the page. Absent on a tab
                this endpoint has not counted, where a 0 would be a claim.
              */}
              {n !== undefined && (
                <span className="ml-2 font-mono text-cell tabular-nums">{n}</span>
              )}
            </button>
          );
        })}
      </div>

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
        {fixedMode === undefined && (
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
        )}
      </div>

      {/* What this tab holds, said once rather than guessed at. */}
      <p className="text-cell text-steel">{active.hint}</p>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      {isStock ? (
        <CargoStockTable search={search} shipmentType={mode} />
      ) : (
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
              {/*
              The client's move out of Declined (spec, 2026-09-18): "Need to
              modify the vessel schedule or cancel the booking." The schedule is
              the ordinary one of the two, so it is the one offered here —
              cancelling is a privileged action and stays on the booking, where
              it asks for a reason.
            */}
              {worklist === 'APPROVAL' &&
                row.status === 'REJECTED' &&
                can('CUSTOMER_SERVICE.SCHEDULE.CREATE') && (
                  <Link
                    href={`/cs/shipment-booking/${row.id}?tab=schedule`}
                    className="text-body text-harbour hover:underline"
                  >
                    New schedule
                  </Link>
                )}
              <Link
                href={`/cs/shipment-booking/${row.id}`}
                className="text-body text-steel hover:underline"
              >
                Booking
              </Link>
              {/*
              CR-002 §12 — straight from the receipt to the load plan, with
              this booking already chosen.

              An entry point and nothing more: it creates nothing, carries no
              rules of its own, and lands on the same screen with the same
              server-side compatibility check. A second creation path is
              exactly what §12 forbids, and the eligibility rules would be the
              first thing to drift.
            */}
              {worklist === 'CARGO_RECEIPT' && can('OPERATION.CONTAINER_LOAD_PLAN.CREATE') && (
                <Link
                  href={`/operation/container-load-plan?booking=${row.id}`}
                  className="text-body text-harbour hover:underline"
                >
                  Make CLP
                </Link>
              )}
              {/*
              The client's "download/print option" on the Shipping Order list
              (spec, 2026-09-18). Only where there is a document to print: a
              booking that skipped its order on an inbound has none, and a
              button that opened an error would be worse than no button.
            */}
              {worklist === 'SHIPPING_ORDER' &&
                row.status === 'SO_ISSUED' &&
                can(`${config.feature}.EXPORT_PDF`) && (
                  <button
                    type="button"
                    className="text-body text-harbour hover:underline"
                    onClick={() => {
                      void printOrder(row.id);
                    }}
                  >
                    Print
                  </button>
                )}
              {/*
              MODULE_DOCUMENTATION §13 — the screen's reason to exist: issue
              the approved bill, then print its originals, or a copy.
            */}
              {worklist === 'BL_PRINT' && (
                <BlPrintActions
                  shipmentId={row.id}
                  status={row.status}
                  onChanged={() => setReloadKey((k) => k + 1)}
                />
              )}
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
      )}
    </div>
  );
}
