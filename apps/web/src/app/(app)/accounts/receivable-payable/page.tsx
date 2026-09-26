'use client';

import {
  LEDGER_PARTY_LABEL,
  LEDGER_PARTY_TYPES,
  type ReceivablePayableRow,
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
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Receivable-Payable list — the client's `Receiveable-Payable list`
 * sheet, titled `Ledger` (docs/MODULE_ACCOUNTS.md §2.4, §3.6).
 *
 * Who owes us and whom we owe: issued invoices less what was received, the
 * costs on them, and the opening balances from CRM. The USD columns hold the
 * dollar-denominated part; the base columns hold everything, converted. Each
 * name opens that party's ledger, where every figure is in its own currency.
 */
export default function ReceivablePayablePage() {
  const list = useMasterList<ReceivablePayableRow, 'name'>('/api/tenant/accounts/receivable-payable', 'name');

  const openOnly = list.filters.openOnly !== 'false';

  const columns: DataTableColumn<ReceivablePayableRow>[] = useMemo(
    () => [
      {
        id: 'name',
        header: 'Agent / Carrier / Vendor name',
        sortable: true,
        cell: (r) => (
          <div className="flex flex-col">
            <Link
              href={`/accounts/receivable-payable/${r.partyType.toLowerCase()}/${r.partyId}` as Route}
              className="text-harbour hover:underline"
            >
              {r.partyName}
            </Link>
            <span className="text-cell text-steel">{LEDGER_PARTY_LABEL[r.partyType]}</span>
          </div>
        ),
      },
      {
        id: 'receivableUsd',
        header: 'Receivable (USD)',
        numeric: true,
        cell: (r) => <span className="font-mono tabular-nums">{amount(r.receivableUsd)}</span>,
      },
      {
        id: 'receivableBase',
        header: 'Receivable (Base Cur)',
        numeric: true,
        cell: (r) => (
          <span className="font-mono tabular-nums" title={r.rateMissing ? 'An opening balance has no rate to convert it — set one on Settings → Currency.' : undefined}>
            {amount(r.receivableBase)}
            {r.rateMissing && <span className="ml-1 text-signal">*</span>}
          </span>
        ),
      },
      {
        id: 'payableUsd',
        header: 'Payable (USD)',
        numeric: true,
        cell: (r) => <span className="font-mono tabular-nums">{amount(r.payableUsd)}</span>,
      },
      {
        id: 'payableBase',
        header: 'Payable (Base Cur)',
        numeric: true,
        cell: (r) => <span className="font-mono tabular-nums">{amount(r.payableBase)}</span>,
      },
    ],
    [],
  );

  const totals = list.meta.totals;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Receivable-Payable list"
        description="Who owes us, and whom we owe. Issued invoices less money received, what suppliers charged on them, and the opening balances from CRM."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search parties"
            placeholder="Name or code"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Party</span>
          <Select aria-label="Kind of party" value={list.filters.partyType ?? ''} onChange={(e) => list.setFilter('partyType', e.target.value)}>
            <option value="">Everyone</option>
            {LEDGER_PARTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {LEDGER_PARTY_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-body text-hull">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => list.setFilter('openOnly', e.target.checked ? '' : 'false')}
            className="h-4 w-4 accent-harbour"
          />
          Only open balances
        </label>
      </div>

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={list.rows}
        getRowId={(r) => `${r.partyType}:${r.partyId}`}
        getCode={(r) => r.partyCode}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'name', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <Link
            href={`/accounts/receivable-payable/${row.partyType.toLowerCase()}/${row.partyId}` as Route}
            className="text-body text-harbour hover:underline"
          >
            Ledger
          </Link>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="Nobody matches those filters"
              description="Try a different name, or clear the filters."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Nothing is owed either way"
              description="Balances appear here once a debit invoice is sent, or when a customer, agent or vendor has an opening balance in CRM."
            />
          )
        }
      />

      {/* The sheet's "Total =" row (C19): every page, not just this one. */}
      {totals !== undefined && list.rows.length > 0 && (
        <div className="grid grid-cols-2 gap-4 rounded-manifest border border-line bg-paper px-4 py-3 sm:grid-cols-4">
          {(
            [
              ['Total receivable (USD)', totals.receivableUsd],
              ['Total receivable (Base Cur)', totals.receivableBase],
              ['Total payable (USD)', totals.payableUsd],
              ['Total payable (Base Cur)', totals.payableBase],
            ] as [string, string | undefined][]
          ).map(([label, value]) => (
            <div key={label} className="text-right">
              <span className="label-manifest">{label}</span>
              <p className="font-mono text-section tabular-nums text-hull">{amount(value)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
