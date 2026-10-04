'use client';

import {
  DEFAULT_PAGE_SIZE,
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_KIND_LABEL,
  JOURNAL_ENTRY_STATUS_LABEL,
  JOURNAL_ENTRY_STATUSES,
  type JournalEntryKind,
  type JournalEntryListRow,
  type JournalEntryStatus,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status, type StatusTone } from '@/components/ui/status';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

import { amount } from './format';

/** Where each Transaction screen lives, on the web and on the API alike. */
export const VOUCHER_SLUG: Record<JournalEntryKind, string> = {
  JOURNAL: 'journal',
  EXPENSE: 'expense',
  INCOME: 'income',
  TRANSFER: 'internal-transfer',
};

export const VOUCHER_STATUS_TONE: Record<JournalEntryStatus, StatusTone> = {
  DRAFT: 'pending',
  POSTED: 'active',
  CANCELLED: 'inactive',
};

const DESCRIPTION: Record<JournalEntryKind, string> = {
  JOURNAL: 'Entries written as debits and credits — an opening balance, a correction, a salary accrual.',
  EXPENSE: 'Money paid out of a bank or cash account, and what it was spent on — suppliers’ invoices included.',
  INCOME: 'Money deposited into a bank or cash account, and what it was earned from — customers’ invoices included.',
  TRANSFER: 'Money moved between the company’s own bank and cash accounts.',
};

const EMPTY: Record<JournalEntryKind, string> = {
  JOURNAL: 'No journals yet. Start with the opening balance of each bank account.',
  EXPENSE: 'No expenses yet. Record the first payment made from a bank or cash account.',
  INCOME: 'No income yet. Record the first money received, or open Receive on a debit invoice.',
  TRANSFER: 'No transfers yet. Record money moved between the company’s own accounts here.',
};

/**
 * The list each Transaction screen opens on (§8): every voucher of one kind,
 * newest first, with `+ New` for the sheet's form.
 */
export function VoucherList({ kind }: { kind: JournalEntryKind }) {
  const { can } = useSession();
  const router = useRouter();
  const slug = VOUCHER_SLUG[kind];
  const feature = JOURNAL_ENTRY_FEATURE[kind];
  const list = useMasterList<JournalEntryListRow, 'entryDate'>(
    `/api/tenant/accounts/${slug}`,
    'entryDate',
    DEFAULT_PAGE_SIZE,
    'desc',
  );
  const label = JOURNAL_ENTRY_KIND_LABEL[kind];
  const settles = kind === 'EXPENSE' || kind === 'INCOME';

  const columns: DataTableColumn<JournalEntryListRow>[] = useMemo(
    () => [
      // Dates and invoice codes stay whole: the row grows wider, never splits 2026-09-30 in two.
      {
        id: 'entryDate',
        header: 'Date',
        numeric: true,
        sortable: true,
        cell: (r) => <span className="whitespace-nowrap">{r.entryDate}</span>,
      },
      ...(settles
        ? [
            {
              id: 'party',
              header: kind === 'EXPENSE' ? 'Pay to' : 'Income From',
              cell: (r: JournalEntryListRow) =>
                r.partyName === null ? (
                  <span className="text-steel">—</span>
                ) : (
                  <div className="flex flex-col">
                    <span>{r.partyName}</span>
                    {r.settledReference !== null && (
                      <span className="whitespace-nowrap font-mono text-cell tabular-nums text-steel">{r.settledReference}</span>
                    )}
                  </div>
                ),
            },
          ]
        : []),
      { id: 'accounts', header: 'From → To', cell: (r) => r.accounts },
      { id: 'description', header: 'Description', cell: (r) => r.description ?? <span className="text-steel">—</span> },
      {
        id: 'amount',
        header: 'Amount',
        numeric: true,
        sortable: true,
        cell: (r) => <span className="font-mono tabular-nums">{amount(r.totalAmount)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => <Status tone={VOUCHER_STATUS_TONE[r.status]}>{JOURNAL_ENTRY_STATUS_LABEL[r.status]}</Status>,
      },
    ],
    [kind, settles],
  );

  const add = can(`${feature}.CREATE`) ? (
    <Button onClick={() => router.push(`/accounts/${slug}/new` as Route)}>+ New {label.toLowerCase()}</Button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={label} description={DESCRIPTION[kind]} action={add} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={settles ? 'Voucher no, description or party' : 'Voucher no or description'}
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Status</span>
          <Select aria-label="Status" value={list.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">Any status</option>
            {JOURNAL_ENTRY_STATUSES.filter((s) => kind === 'JOURNAL' || s !== 'DRAFT').map((s) => (
              <option key={s} value={s}>
                {JOURNAL_ENTRY_STATUS_LABEL[s]}
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
        codeHeader="Voucher No"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'entryDate', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <Link href={`/accounts/${slug}/${row.id}` as Route} className="text-body text-harbour hover:underline">
            {row.status === 'DRAFT' && can('ACCOUNTS.JOURNAL.EDIT') ? 'Edit' : 'View'}
          </Link>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="Nothing matches those filters"
              description="Try a different term, or clear them to see every voucher."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState title={`No ${label.toLowerCase()} yet`} description={EMPTY[kind]} action={add} />
          )
        }
      />
    </div>
  );
}
