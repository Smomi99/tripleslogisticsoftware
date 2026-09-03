'use client';

import {
  QUOTATION_STATUS_LABEL,
  QUOTATION_STATUSES,
  type QuotationListItemDto,
  type QuotationStatus,
} from '@ff/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { FollowupDrawer } from './followup-drawer';

/**
 * Customer Service → Quotation List (§6.7).
 *
 * The client's columns in the client's order, and their four row actions. The
 * list is the screen the feature opens on; a new quotation is raised from the
 * Add button, the same way Live Inquiry works.
 *
 * Booking is the hand-off to the next module, and it now goes somewhere:
 * MODULE_BOOKING_CARGO.md §6.1's screen, against this quotation. It stays
 * disabled until the customer has accepted, because §1's flow starts there.
 */

const TONE: Record<QuotationStatus, 'active' | 'pending' | 'inactive' | 'overdue'> = {
  DRAFT: 'pending',
  SENT: 'pending',
  ACCEPTED: 'active',
  REJECTED: 'overdue',
  EXPIRED: 'inactive',
  SUPERSEDED: 'inactive',
};

/** "1450.5" -> "1,450.50", so a column of prices lines up (§12). */
function money(value: string | null): string {
  if (value === null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuotationListPage() {
  const { authorizedList: list, can } = useSession();
  const router = useRouter();

  const [rows, setRows] = useState<QuotationListItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'' | QuotationStatus>('');
  const [isPending, setPending] = useState(true);
  const [followingUp, setFollowingUp] = useState<QuotationListItemDto | null>(null);

  // Debounced, like every other search box in the product (§8).
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    const params = new URLSearchParams({ page: String(page), limit: '25' });
    if (query !== '') params.set('search', query);
    if (status !== '') params.set('status', status);

    void (async () => {
      try {
        const result = await list<QuotationListItemDto[]>(
          `/api/tenant/cs/quotations?${params.toString()}`,
        );
        if (cancelled) return;
        setRows(result.data);
        setTotal(result.meta?.total ?? result.data.length);
      } catch (caught) {
        if (cancelled) return;
        toast.error(
          caught instanceof ApiError ? caught.message : 'Could not load the quotations.',
        );
      } finally {
        if (!cancelled) setPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [list, page, query, status]);

  const columns: DataTableColumn<QuotationListItemDto>[] = [
    {
      id: 'inquiryCode',
      header: 'Inquiry No',
      numeric: true,
      cell: (row) => (
        <Link
          href={{ pathname: '/sales/inquiry' }}
          className="text-harbour hover:underline"
          title={`Inquiry ${row.inquiryCode}`}
        >
          {row.inquiryCode}
        </Link>
      ),
    },
    {
      id: 'quotationDate',
      header: 'Quotation Date',
      numeric: true,
      cell: (row) => row.quotationDate,
    },
    { id: 'customerName', header: 'Customer', cell: (row) => row.customerName },
    {
      id: 'commodity',
      header: 'Commodity',
      cell: (row) =>
        row.commodities.length === 0 ? (
          <span className="text-steel">—</span>
        ) : (
          row.commodities.join(', ')
        ),
    },
    { id: 'shipmentType', header: 'Shipment Type', cell: (row) => row.shipmentType },
    {
      id: 'pol',
      header: 'POL/AOL',
      cell: (row) => row.polName ?? row.polCode ?? '—',
    },
    {
      id: 'pod',
      header: 'POD/AOD',
      cell: (row) => row.podName ?? row.podCode ?? '—',
    },
    {
      id: 'requiredContainer',
      header: 'Required Container',
      numeric: true,
      cell: (row) => row.requiredContainer,
    },
    {
      id: 'totalAmountUsd',
      header: 'Total ($)',
      numeric: true,
      align: 'right',
      cell: (row) => money(row.totalAmountUsd),
    },
    {
      id: 'validityDate',
      header: 'Valid to Date',
      numeric: true,
      cell: (row) => row.validityDate ?? '—',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <Status tone={TONE[row.status]}>
          {QUOTATION_STATUS_LABEL[row.status]}
          {/* A revision is a different document with the same number, so the
              list has to say which one it is showing. */}
          {row.revisionNo > 1 && ` · rev ${row.revisionNo}`}
        </Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Quotation List"
        description="Every price that has gone to a customer, and the ones still being built."
        action={
          can('CUSTOMER_SERVICE.QUOTATION.CREATE') ? (
            <Button onClick={() => router.push('/cs/quotation/new')}>+ New quotation</Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search quotation no, inquiry no or customer"
          aria-label="Search quotations"
          className="w-72"
        />
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as '' | QuotationStatus);
            setPage(1);
          }}
          aria-label="Filter by status"
          className="w-44"
        >
          <option value="">All statuses</option>
          {QUOTATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {QUOTATION_STATUS_LABEL[value]}
            </option>
          ))}
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getCode={(row) => row.code}
        codeHeader="Quotation No"
        total={total}
        page={page}
        limit={25}
        sortOrder="desc"
        onSortChange={() => undefined}
        onPageChange={setPage}
        isPending={isPending}
        empty={
          <EmptyState
            title={query === '' ? 'No quotations yet' : 'Nothing matches that'}
            description={
              query === ''
                ? 'Raise one from an inquiry and it will appear here. The lines pull themselves from your price list.'
                : 'Try a quotation number, an inquiry number, or the customer name.'
            }
          />
        }
        actions={(row) => (
          <span className="inline-flex items-center gap-3">
            <Link
              href={{ pathname: `/cs/quotation/${row.id}` }}
              className="text-cell text-harbour hover:underline"
            >
              View
            </Link>
            {can('CUSTOMER_SERVICE.QUOTATION.EDIT') && row.status !== 'SUPERSEDED' && (
              <Link
                href={{ pathname: `/cs/quotation/${row.id}` }}
                className="text-cell text-harbour hover:underline"
              >
                Edit
              </Link>
            )}
            {can('CUSTOMER_SERVICE.QUOTATION.FOLLOWUP') && (
              <Button variant="text" size="inline" onClick={() => setFollowingUp(row)}>
                Follow up
              </Button>
            )}
            {/* §6.7's hand-off into MODULE_BOOKING_CARGO.md §6.1. */}
            {can('CUSTOMER_SERVICE.CARGO_BOOKING.CREATE') &&
              /*
                Offered from SENT, not only ACCEPTED. Nothing in the product
                ever wrote ACCEPTED, so this button was permanently disabled —
                the customer's acceptance arrives by phone or email, and
                raising the booking is how it gets recorded. The booking route
                marks the quotation accepted when it does.
              */
              (row.status === 'SENT' || row.status === 'ACCEPTED' ? (
                <Link
                  href={{ pathname: '/cs/shipment-booking/new', query: { quotationId: row.id } }}
                  className="text-body text-harbour hover:underline"
                  title="Start a shipment booking"
                >
                  Booking
                </Link>
              ) : (
                <Button
                  variant="text"
                  size="inline"
                  disabled
                  title="Available once the quotation has been sent"
                >
                  Booking
                </Button>
              ))}
          </span>
        )}
      />

      <FollowupDrawer quotation={followingUp} onClose={() => setFollowingUp(null)} />
    </div>
  );
}
