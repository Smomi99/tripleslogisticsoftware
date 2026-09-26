'use client';

import {
  DEBIT_INVOICE_DISPLAY_STATUS_LABEL,
  DEBIT_INVOICE_DISPLAY_STATUSES,
  type DebitInvoiceDto,
  type DebitInvoiceListRow,
  DEFAULT_PAGE_SIZE,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { DISPLAY_STATUS_TONE, money } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Debit Invoice — the client's `Debit note (Other)` sheet
 * (docs/MODULE_ACCOUNTS.md §2.3).
 *
 * Every debit invoice, whether made from a booking on Awaiting Freight Inv or
 * raised by hand with `Create New`. The row actions are the sheet's:
 * `Receive` (the form on rows 15–20), `Edit` and `Cancel`.
 */

const today = (): string => new Date().toISOString().slice(0, 10);

export default function DebitInvoiceListPage() {
  const { can, authorizedRequest } = useSession();
  const router = useRouter();
  // A register of documents: newest first.
  const list = useMasterList<DebitInvoiceListRow, 'code'>(
    '/api/tenant/accounts/debit-invoices',
    'code',
    DEFAULT_PAGE_SIZE,
    'desc',
  );
  const [receiving, setReceiving] = useState<DebitInvoiceListRow | null>(null);
  const [paymentDate, setPaymentDate] = useState(today());
  const [received, setReceived] = useState('');
  const [cancelling, setCancelling] = useState<DebitInvoiceListRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const canViewQuotation = can('CUSTOMER_SERVICE.QUOTATION.VIEW');

  const columns: DataTableColumn<DebitInvoiceListRow>[] = useMemo(
    () => [
      { id: 'inquiry', header: 'Inquiry No', cell: (r) => <span className="font-mono tabular-nums">{r.inquiryCode ?? '—'}</span> },
      {
        id: 'quotation',
        header: 'Quotation No',
        cell: (r) =>
          r.quotationCode === null ? (
            '—'
          ) : canViewQuotation && r.quotationId !== null ? (
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
      { id: 'quotationDate', header: 'Quotation Date', numeric: true, cell: (r) => r.quotationDate ?? '—' },
      { id: 'booking', header: 'Booking No', cell: (r) => <span className="font-mono tabular-nums">{r.bookingCode ?? '—'}</span> },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      {
        id: 'type',
        header: 'Shipment Type',
        cell: (r) => (r.shipmentType === null ? 'Other' : r.shipmentType === 'AIR' ? 'Air' : 'Sea'),
      },
      { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName ?? '—' },
      { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName ?? '—' },
      {
        id: 'amount',
        header: 'Invoice Amount',
        numeric: true,
        sortable: true,
        cell: (r) => (
          <div className="flex flex-col items-end">
            <span className="font-mono tabular-nums">{money(null, r.totalAmount)}</span>
            {r.displayStatus === 'PARTIAL' && (
              <span className="font-mono text-cell tabular-nums text-steel">
                {money(null, r.outstandingAmount)} due
              </span>
            )}
          </div>
        ),
      },
      { id: 'currency', header: 'Currency', cell: (r) => r.currencyCode },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => <Status tone={DISPLAY_STATUS_TONE[r.displayStatus]}>{DEBIT_INVOICE_DISPLAY_STATUS_LABEL[r.displayStatus]}</Status>,
      },
    ],
    [canViewQuotation],
  );

  async function receive(): Promise<void> {
    if (receiving === null) return;
    setBusy(true);
    try {
      const done = await authorizedRequest<DebitInvoiceDto>(
        `/api/tenant/accounts/debit-invoices/${receiving.id}/receipts`,
        { method: 'POST', body: { paymentDate, amount: received.trim() } },
      );
      toast.success(
        done.paymentStatus === 'PAID'
          ? `${done.code} received in full`
          : `Received — ${money(done.currencyCode, done.outstandingAmount)} still due`,
      );
      setReceiving(null);
      await list.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not record the payment.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (cancelling === null) return;
    setBusy(true);
    try {
      await authorizedRequest(`/api/tenant/accounts/debit-invoices/${cancelling.id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      toast.success(`${cancelling.code} cancelled`);
      setCancelling(null);
      await list.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not cancel the invoice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Debit Invoice"
        description="Every debit invoice — made from a booking, or raised by hand. Record money received against it here."
        action={
          can('ACCOUNTS.DEBIT_INVOICE.CREATE') ? (
            <Button onClick={() => router.push('/accounts/debit-invoice/new' as Route)}>+ Create New</Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search debit invoices"
            placeholder="Invoice, booking, quotation or customer"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-48 flex-col gap-1">
          <span className="label-manifest">Status</span>
          <Select aria-label="Status" value={list.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">Any status</option>
            {DEBIT_INVOICE_DISPLAY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {DEBIT_INVOICE_DISPLAY_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Kind</span>
          <Select aria-label="Kind" value={list.filters.kind ?? ''} onChange={(e) => list.setFilter('kind', e.target.value)}>
            <option value="">Freight and other</option>
            <option value="FREIGHT">Freight</option>
            <option value="OTHER">Other</option>
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
        getCode={(r) => r.code}
        codeHeader="Debit Invoice No"
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
            {row.status === 'ISSUED' && row.displayStatus !== 'PAID' && can('ACCOUNTS.DEBIT_INVOICE.RECEIVE') && (
              <Button
                variant="text"
                size="inline"
                onClick={() => {
                  setReceiving(row);
                  setPaymentDate(today());
                  setReceived(Number(row.outstandingAmount).toFixed(2));
                }}
              >
                Receive
              </Button>
            )}
            <Link
              href={`/accounts/debit-invoice/${row.id}` as Route}
              className="text-body text-harbour hover:underline"
            >
              {row.status === 'CANCELLED' || !can('ACCOUNTS.DEBIT_INVOICE.EDIT') ? 'View' : 'Edit'}
            </Link>
            {row.cancellable && can('ACCOUNTS.DEBIT_INVOICE.CANCEL') && (
              <Button
                variant="destructive"
                size="inline"
                onClick={() => {
                  setCancelling(row);
                  setReason('');
                }}
              >
                Cancel
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No invoices match those filters"
              description="Try a different term, or clear them to see every invoice."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No debit invoices yet"
              description="Make one from a booking on Awaiting Freight Inv, or raise one by hand with Create New."
              action={
                <Link href={{ pathname: '/accounts/awaiting-freight-inv' }} className="text-body text-harbour hover:underline">
                  Go to Awaiting Freight Inv
                </Link>
              }
            />
          )
        }
      />

      {/* ------------------------------------ Receive (sheet rows 15–20) */}
      <Modal
        open={receiving !== null}
        onOpenChange={(open) => {
          if (!open) setReceiving(null);
        }}
        title={`Receive against ${receiving?.code ?? ''}`}
        description="Record money the customer has paid. Part payments are fine — the rest stays outstanding."
      >
        {receiving !== null && (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
              {(
                [
                  ['Inquiry No', receiving.inquiryCode],
                  ['Quotation No', receiving.quotationCode],
                  ['Booking No', receiving.bookingCode],
                  ['Debit Invoice No', receiving.code],
                  ['Customer', receiving.customerName],
                  ['Invoice Amount', money(receiving.currencyCode, receiving.totalAmount)],
                  ['Outstanding', money(receiving.currencyCode, receiving.outstandingAmount)],
                ] as [string, string | null][]
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="label-manifest">{label}</dt>
                  <dd className="text-body text-hull">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
            <div className="grid grid-cols-2 gap-3">
              <Field id="paymentDate" label="Payment Date" required>
                <Input id="paymentDate" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
              </Field>
              <Field id="received" label={`Amount received (${receiving.currencyCode})`} required>
                <Input
                  id="received"
                  numeric
                  inputMode="decimal"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setReceiving(null)}>
                Close
              </Button>
              <Button disabled={busy || received.trim() === '' || paymentDate === ''} onClick={() => void receive()}>
                {busy ? 'Recording…' : 'Record payment'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------- Cancel (P8) */}
      <Modal
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
        title={`Cancel ${cancelling?.code ?? ''}?`}
        description={
          cancelling?.kind === 'FREIGHT'
            ? 'The number is kept on the record, and the booking goes back on Awaiting Freight Inv to be invoiced again.'
            : 'The number is kept on the record.'
        }
      >
        <div className="flex flex-col gap-4">
          <Field id="reason" label="Reason" required>
            <textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            />
          </Field>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={busy || reason.trim() === ''} onClick={() => void cancel()}>
              {busy ? 'Cancelling…' : 'Cancel invoice'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
