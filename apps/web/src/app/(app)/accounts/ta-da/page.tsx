'use client';

import { DEFAULT_PAGE_SIZE, TA_DA_STATUS_LABEL, TA_DA_STATUSES, type TaDaListRow } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { TA_DA_TONE } from '@/components/accounts/ta-da-form';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → TA/DA (Menu M17) — every Travel Allowance / Daily Allowance
 * claim. The claim number opens it; a claim is made, submitted, approved and
 * paid from there.
 */
export default function TaDaListPage() {
  const { can, authorizedDownload } = useSession();
  const router = useRouter();
  const list = useMasterList<TaDaListRow, 'claimDate'>('/api/tenant/accounts/ta-da', 'claimDate', DEFAULT_PAGE_SIZE, 'desc');
  const [exporting, setExporting] = useState(false);

  const columns: DataTableColumn<TaDaListRow>[] = useMemo(
    () => [
      { id: 'claimDate', header: 'Date', numeric: true, sortable: true, cell: (r) => r.claimDate },
      { id: 'employee', header: 'Employee', cell: (r) => r.employeeName },
      { id: 'purpose', header: 'Purpose', cell: (r) => <span className="line-clamp-1">{r.purpose}</span> },
      { id: 'ta', header: 'TA', numeric: true, align: 'right', cell: (r) => amount(r.totalTa) },
      { id: 'da', header: 'DA', numeric: true, align: 'right', cell: (r) => amount(r.totalDa) },
      { id: 'amount', header: 'Total', numeric: true, align: 'right', sortable: true, cell: (r) => amount(r.totalAmount) },
      { id: 'status', header: 'Status', cell: (r) => <Status tone={TA_DA_TONE[r.status]}>{TA_DA_STATUS_LABEL[r.status]}</Status> },
      {
        id: 'voucher',
        header: 'Paid by',
        cell: (r) => <span className="font-mono tabular-nums">{r.voucherCode ?? '—'}</span>,
      },
    ],
    [],
  );

  async function exportIt(): Promise<void> {
    setExporting(true);
    try {
      const status = list.filters.status === undefined || list.filters.status === '' ? '' : `?status=${list.filters.status}`;
      await authorizedDownload(`/api/tenant/accounts/ta-da/export${status}`, 'ta-da-claims.xlsx');
    } catch {
      toast.error('Could not export the claims.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="TA/DA"
        description="Travel and daily allowance claims — made, approved, then paid from cash or bank."
        action={
          // A fragment, so each button is the header's own and shares the row on a phone.
          <>
            {can('ACCOUNTS.TA_DA.EXPORT') && (
              <Button variant="secondary" onClick={() => void exportIt()} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Export to Excel'}
              </Button>
            )}
            {can('ACCOUNTS.TA_DA.CREATE') && (
              <Button onClick={() => router.push('/accounts/ta-da/new' as Route)}>+ New claim</Button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1 sm:w-72">
          <span className="label-field">Search</span>
          <Input
            type="search"
            aria-label="Search claims"
            placeholder="Claim no, employee or purpose"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1 sm:w-48 sm:flex-none">
          <span className="label-field">Status</span>
          <Select aria-label="Status" value={list.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">Any status</option>
            {TA_DA_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TA_DA_STATUS_LABEL[s]}
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
        getCode={(r) => r.code}
        codeHeader="Claim No"
        onCodeClick={(r) => router.push(`/accounts/ta-da/${r.id}` as Route)}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'claimDate', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <Link href={`/accounts/ta-da/${row.id}` as Route} className="text-body text-harbour hover:underline">
            Open
          </Link>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No claims match those filters"
              description="Try a different term, or clear them to see every claim."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No TA/DA claims yet"
              description="Make one for an employee's trip to the port, customs or a customer, then submit it for approval."
              action={
                can('ACCOUNTS.TA_DA.CREATE') ? (
                  <Button onClick={() => router.push('/accounts/ta-da/new' as Route)}>+ New claim</Button>
                ) : undefined
              }
            />
          )
        }
      />
    </div>
  );
}
