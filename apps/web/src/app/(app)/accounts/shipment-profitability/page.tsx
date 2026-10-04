'use client';

import {
  LOADING_TYPE_LABEL,
  SHIPMENT_STATUS_LABEL,
  type ShipmentProfitabilityRow,
  type ShipmentProfitabilitySortField,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useMemo } from 'react';

import { amount } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Shipment Profitability — the client's `Shipment Profitabilit`
 * sheet (docs/DESIGN-UPDATE-2026-10-04.md §8).
 *
 * One row per invoiced booking: what its issued debit invoices billed, what
 * their cost blocks say the suppliers charged, and the difference. Read-only —
 * a wrong figure is corrected on the invoice, and shows here on reload.
 */

/** A loss is the row the screen exists to find, so it reads as one (§12 --alert). */
function Figure({ value, signed = false, suffix = '' }: { value: string | null; signed?: boolean; suffix?: string }) {
  const negative = signed && value !== null && value.startsWith('-');
  return (
    <span className={cn('font-mono tabular-nums', negative && 'text-alert')}>
      {value === null ? '—' : `${suffix === '%' ? value : amount(value)}${suffix}`}
    </span>
  );
}

function modeOf(row: ShipmentProfitabilityRow): string {
  if (row.shipmentType === 'AIR') return 'Air';
  return row.loadingType === null ? 'Sea' : LOADING_TYPE_LABEL[row.loadingType];
}

export default function ShipmentProfitabilityPage() {
  const { can } = useSession();
  const list = useMasterList<ShipmentProfitabilityRow, ShipmentProfitabilitySortField>(
    '/api/tenant/accounts/shipment-profitability',
    'code',
    undefined,
    'desc',
  );
  const canViewQuotation = can('CUSTOMER_SERVICE.QUOTATION.VIEW');
  const base = list.rows[0]?.currencyCode || 'Base';

  const columns: DataTableColumn<ShipmentProfitabilityRow>[] = useMemo(
    () => [
      {
        id: 'quotation',
        header: 'Quotation No',
        cell: (r) =>
          canViewQuotation ? (
            <Link
              href={`/cs/quotation/${r.quotationId}` as Route}
              className="font-mono tabular-nums text-harbour hover:underline"
            >
              {r.quotationCode}
            </Link>
          ) : (
            <span className="font-mono tabular-nums">{r.quotationCode}</span>
          ),
      },
      { id: 'bl', header: 'BL No', cell: (r) => <span className="font-mono tabular-nums">{r.blNo ?? '—'}</span> },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      { id: 'mode', header: 'Mode', cell: modeOf },
      {
        id: 'route',
        header: 'Route (POL-POD)',
        cell: (r) => (
          <span className="font-mono tabular-nums" title={`${r.polName} – ${r.podName}`}>
            {r.polCode}-{r.podCode}
          </span>
        ),
      },
      { id: 'revenue', header: `Revenue (${base})`, align: 'right', sortable: true, cell: (r) => <Figure value={r.revenue} /> },
      { id: 'cost', header: `Cost (${base})`, align: 'right', sortable: true, cell: (r) => <Figure value={r.cost} /> },
      { id: 'gp', header: `GP (${base})`, align: 'right', sortable: true, cell: (r) => <Figure value={r.gp} signed /> },
      {
        id: 'gpPercent',
        header: 'GP %',
        align: 'right',
        sortable: true,
        cell: (r) => <Figure value={r.gpPercent} signed suffix="%" />,
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => <span className="text-cell text-steel">{SHIPMENT_STATUS_LABEL[r.bookingStatus]}</span>,
      },
    ],
    [base, canViewQuotation],
  );

  const totals = list.meta.totals;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Shipment Profitability"
        description="What each invoiced booking earned: the revenue on its issued debit invoices, less what the carrier, agent and vendors charged on them."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Booking, quotation, BL no or customer"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-40 flex-col gap-1">
          <span className="label-manifest">Mode</span>
          <Select
            aria-label="Sea or air"
            value={list.filters.shipmentType ?? ''}
            onChange={(e) => list.setFilter('shipmentType', e.target.value)}
          >
            <option value="">Sea and air</option>
            <option value="SEA">Sea</option>
            <option value="AIR">Air</option>
          </Select>
        </div>
        {/* On the booking's first issued invoice — the day the job was billed. */}
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor="profit-from" className="label-manifest">
            Invoiced from
          </label>
          <Input
            id="profit-from"
            type="date"
            numeric
            value={list.filters.from ?? ''}
            max={list.filters.to || undefined}
            onChange={(e) => list.setFilter('from', e.target.value)}
          />
        </div>
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor="profit-to" className="label-manifest">
            Invoiced to
          </label>
          <Input
            id="profit-to"
            type="date"
            numeric
            value={list.filters.to ?? ''}
            min={list.filters.from || undefined}
            onChange={(e) => list.setFilter('to', e.target.value)}
          />
        </div>
      </div>

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={list.rows}
        getRowId={(r) => r.shipmentId}
        getCode={(r) => r.bookingCode}
        codeHeader="Booking No"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as ShipmentProfitabilitySortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No invoiced bookings match those filters"
              description="Try a different term or dates, or clear the filters to see every invoiced booking."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No invoiced bookings yet"
              description="A booking appears here once its debit invoice is issued. Invoice the bookings waiting on Awaiting Freight Inv to start measuring their margin."
            />
          )
        }
      />

      {/* Every page, not just this one: a period's GP % is its total GP over its total revenue. */}
      {totals !== undefined && list.rows.length > 0 && (
        <div className="grid grid-cols-2 gap-4 rounded-manifest border border-line bg-paper px-4 py-3 sm:grid-cols-4">
          {(
            [
              [`Total revenue (${base})`, totals.revenue, false, ''],
              [`Total cost (${base})`, totals.cost, false, ''],
              [`Total GP (${base})`, totals.gp, true, ''],
              ['GP %', totals.gpPercent || null, true, '%'],
            ] as [string, string | null | undefined, boolean, string][]
          ).map(([label, value, signed, suffix]) => (
            <div key={label} className="text-right">
              <span className="label-manifest">{label}</span>
              <p className="text-section text-hull">
                <Figure value={value ?? null} signed={signed} suffix={suffix} />
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
