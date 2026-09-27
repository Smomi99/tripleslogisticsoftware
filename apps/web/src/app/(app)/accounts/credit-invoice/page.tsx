'use client';

import {
  type CreditInvoiceRow,
  CREDIT_INVOICE_PAYMENT_FILTERS,
  DEFAULT_PAGE_SIZE,
  PAY_TO_PARTY_TYPES,
  SUPPLIER_PARTY_LABEL,
  SUPPLIER_PAYMENT_STATUS_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { amount, PAYMENT_TONE } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Credit Invoice — the client's `Credit Invoice` sheet
 * (docs/MODULE_ACCOUNTS.md §14.2).
 *
 * Every supplier's invoice on an issued debit invoice: what each carrier,
 * agent and vendor has billed for a job, and what has been paid against it.
 * The sheet's row actions: `Make Payment` (opens Expense against it — the
 * `Expense-Vendor` sheet), `Edit` and `Delete` (both change the debit invoice
 * the cost was recorded on, so they take the grant that does that there).
 */
export default function CreditInvoicePage() {
  const { can, authorizedRequest } = useSession();
  const list = useMasterList<CreditInvoiceRow, 'date'>(
    '/api/tenant/accounts/credit-invoices',
    'date',
    DEFAULT_PAGE_SIZE,
    'desc',
  );
  const [removing, setRemoving] = useState<CreditInvoiceRow | null>(null);
  const [busy, setBusy] = useState(false);

  const canPay = can('ACCOUNTS.EXPENSE.CREATE');
  const canChange = can('ACCOUNTS.DEBIT_INVOICE.EDIT') && can('ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE');

  const columns: DataTableColumn<CreditInvoiceRow>[] = useMemo(
    () => [
      { id: 'date', header: 'Date', numeric: true, sortable: true, cell: (r) => r.date },
      {
        id: 'party',
        header: 'Vendor / Agent / Carrier',
        cell: (r) => (
          <div className="flex flex-col">
            <span>{r.partyName}</span>
            <span className="text-cell text-steel">{SUPPLIER_PARTY_LABEL[r.partyType]}</span>
          </div>
        ),
      },
      {
        id: 'description',
        header: 'Description',
        cell: (r) => (
          <div className="flex flex-col">
            <span>{r.description}</span>
            <span className="font-mono text-cell tabular-nums text-steel">{r.debitInvoiceCode}</span>
          </div>
        ),
      },
      {
        id: 'amount',
        header: 'Amount',
        numeric: true,
        sortable: true,
        cell: (r) => (
          <div className="flex flex-col items-end">
            <span className="font-mono tabular-nums">
              {r.currencyCode} {amount(r.amount)}
            </span>
            {r.paymentStatus === 'PARTIAL' && (
              <span className="font-mono text-cell tabular-nums text-steel">{amount(r.outstandingAmount)} due</span>
            )}
          </div>
        ),
      },
      { id: 'rate', header: 'Conversion Rate', numeric: true, cell: (r) => r.conversionRate },
      {
        id: 'amountBase',
        header: 'Amount (Base Cur)',
        numeric: true,
        cell: (r) => <span className="font-mono tabular-nums">{amount(r.amountBase)}</span>,
      },
      {
        id: 'status',
        header: 'Payment Status',
        cell: (r) => (
          <Status tone={PAYMENT_TONE[r.paymentStatus]}>{SUPPLIER_PAYMENT_STATUS_LABEL[r.paymentStatus]}</Status>
        ),
      },
    ],
    [],
  );

  async function remove(): Promise<void> {
    if (removing === null) return;
    setBusy(true);
    try {
      await authorizedRequest(`/api/tenant/accounts/credit-invoices/${removing.id}`, { method: 'DELETE' });
      toast.success(`${removing.supplierInvoiceNo ?? 'Credit invoice'} deleted`);
      setRemoving(null);
      await list.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not delete it.');
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Credit Invoice"
        description="What carriers, agents and vendors have billed on each job, and what has been paid against it."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search credit invoices"
            placeholder="Invoice no, supplier, booking or debit invoice"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Supplier</span>
          <Select aria-label="Kind of supplier" value={list.filters.partyType ?? ''} onChange={(e) => list.setFilter('partyType', e.target.value)}>
            <option value="">Every supplier</option>
            {PAY_TO_PARTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {SUPPLIER_PARTY_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Payment Status</span>
          <Select aria-label="Payment status" value={list.filters.payment ?? ''} onChange={(e) => list.setFilter('payment', e.target.value)}>
            <option value="">Any</option>
            {CREDIT_INVOICE_PAYMENT_FILTERS.map((s) => (
              <option key={s} value={s}>
                {SUPPLIER_PAYMENT_STATUS_LABEL[s]}
              </option>
            ))}
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
        getRowId={(r) => r.id}
        getCode={(r) => r.supplierInvoiceNo ?? '—'}
        codeHeader="Vendor/Agent/Carrier Inv No"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'date', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {row.paymentStatus !== 'PAID' && canPay && (
              <Link
                href={`/accounts/expense/new?creditInvoice=${row.id}` as Route}
                className="text-body text-harbour hover:underline"
              >
                Make Payment
              </Link>
            )}
            {canChange && (
              <Link
                href={`/accounts/debit-invoice/${row.debitInvoiceId}` as Route}
                className="text-body text-harbour hover:underline"
              >
                Edit
              </Link>
            )}
            {canChange && row.deletable && (
              <Button variant="destructive" size="inline" onClick={() => setRemoving(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No credit invoices match those filters"
              description="Try a different term, or clear them to see every supplier invoice."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No credit invoices yet"
              description="A supplier's invoice appears here once it is entered on a debit invoice's Buying block and that debit invoice is sent."
              action={
                <Link href={{ pathname: '/accounts/debit-invoice' }} className="text-body text-harbour hover:underline">
                  Go to Debit Invoice
                </Link>
              }
            />
          )
        }
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Delete this credit invoice?"
        message={
          removing === null
            ? ''
            : `${removing.supplierInvoiceNo ?? 'This supplier invoice'} from ${removing.partyName} comes off ${removing.debitInvoiceCode}, and what they are owed goes down by ${removing.currencyCode} ${amount(removing.amount)}. Nothing has been paid against it.`
        }
        confirmLabel="Delete"
        destructive
        isPending={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
