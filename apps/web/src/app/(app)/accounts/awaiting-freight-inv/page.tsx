'use client';

import {
  AWAITING_STAGE_LABEL,
  AWAITING_STAGES,
  type AwaitingFreightInvRow,
  SHIPMENT_STATUS_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useMemo } from 'react';

import { money } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Awaiting Freight Inv — the client's `Awaiting Debit Note` sheet
 * (docs/MODULE_ACCOUNTS.md §2.1).
 *
 * A queue of bookings, like every other stage list in the product: confirmed,
 * and not yet invoiced (§3.1). `Make invoice` opens the invoice prefilled from
 * the quotation; a booking with a draft shows `Edit` instead, so a half-made
 * invoice is carried on rather than started again.
 */
export default function AwaitingFreightInvPage() {
  const { can } = useSession();
  const list = useMasterList<AwaitingFreightInvRow, 'code'>('/api/tenant/accounts/awaiting-freight-inv', 'code');
  const canViewQuotation = can('CUSTOMER_SERVICE.QUOTATION.VIEW');

  const columns: DataTableColumn<AwaitingFreightInvRow>[] = useMemo(
    () => [
      { id: 'inquiry', header: 'Inquiry No', cell: (r) => <span className="font-mono tabular-nums">{r.inquiryCode}</span> },
      { id: 'quotation', header: 'Quotation No', cell: (r) => <span className="font-mono tabular-nums">{r.quotationCode}</span> },
      { id: 'quotationDate', header: 'Quotation Date', numeric: true, sortable: true, cell: (r) => r.quotationDate },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      { id: 'commodity', header: 'Commodity', cell: (r) => r.commodity },
      { id: 'type', header: 'Shipment Type', cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea') },
      // Sea and air share this screen, so the headers name both.
      { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
      { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
      { id: 'required', header: 'Required Container', cell: (r) => r.requiredContainer },
      {
        // L5: "Quote can see by click on the amount".
        id: 'quoted',
        header: 'Quoted Amount',
        numeric: true,
        cell: (r) => {
          const text =
            r.quotedAmount.length === 0 ? '—' : r.quotedAmount.map((q) => money(q.currencyCode, q.amount)).join(' + ');
          return canViewQuotation ? (
            <Link
              href={`/cs/quotation/${r.quotationId}` as Route}
              className="font-mono tabular-nums text-harbour hover:underline"
              title="Open the quotation"
            >
              {text}
            </Link>
          ) : (
            <span className="font-mono tabular-nums">{text}</span>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => (
          <div className="flex flex-col">
            <Status tone="pending">{r.invoiceState === 'DRAFT' ? `Draft ${r.invoiceCode ?? ''}` : 'Awaiting invoice'}</Status>
            {/* The booking's own stage, so the ready ones stand out (§3.1). */}
            <span className="text-cell text-steel">{SHIPMENT_STATUS_LABEL[r.bookingStatus]}</span>
          </div>
        ),
      },
    ],
    [canViewQuotation],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Awaiting Freight Inv"
        description="Confirmed bookings that have not been invoiced yet. Make the invoice from the quotation, add what the carrier, agent and vendor charged, and send it."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Booking, quotation, inquiry or customer"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-56 flex-col gap-1">
          <span className="label-manifest">Stage</span>
          <Select
            aria-label="Booking stage"
            value={list.filters.stage ?? ''}
            onChange={(e) => list.setFilter('stage', e.target.value)}
          >
            <option value="">Every confirmed booking</option>
            {AWAITING_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {AWAITING_STAGE_LABEL[stage]}
              </option>
            ))}
          </Select>
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
        onSortChange={(by, order) => list.setSort(by as 'code', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {row.invoiceState === 'AWAITING' && can('ACCOUNTS.AWAITING_FREIGHT_INV.CREATE') && (
              <Link
                href={`/accounts/debit-invoice/new?shipment=${row.shipmentId}` as Route}
                className="text-body text-harbour hover:underline"
              >
                Make invoice
              </Link>
            )}
            {row.invoiceState === 'DRAFT' && row.invoiceId !== null && can('ACCOUNTS.DEBIT_INVOICE.VIEW') && (
              <Link
                href={`/accounts/debit-invoice/${row.invoiceId}` as Route}
                className="text-body text-harbour hover:underline"
              >
                Edit
              </Link>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="Nothing matches those filters"
              description="Try a different term, or clear them to see the whole queue."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Nothing waiting to be invoiced"
              description="A booking arrives here once it is approved for shipment, and leaves once its debit invoice has been sent."
            />
          )
        }
      />
    </div>
  );
}
