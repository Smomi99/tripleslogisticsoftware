'use client';

import {
  MOVEMENT_TYPE_LABEL,
  MOVEMENT_TYPES,
  TARIFF_TYPE_LABEL,
  TARIFF_TYPES,
  type TariffListRow,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Purchase → Price List → Tariff — the client's `Tarrif` sheet
 * (docs/DESIGN-UPDATE-2026-10-04.md §5): local charges at a port, by
 * movement and type.
 */
export default function TariffListPage() {
  const { can, authorizedRequest } = useSession();
  const list = useMasterList<TariffListRow, 'code' | 'pol' | 'country'>('/api/tenant/purchase/tariffs', 'code');
  const [toToggle, setToToggle] = useState<TariffListRow | null>(null);
  const [isToggling, setToggling] = useState(false);

  const columns: DataTableColumn<TariffListRow>[] = useMemo(
    () => [
      { id: 'country', header: 'Country', sortable: true, cell: (r) => r.country },
      {
        id: 'pol',
        header: 'POL',
        sortable: true,
        cell: (r) => (
          <span>
            {r.polName} <span className="font-mono tabular-nums text-steel">{r.polCode}</span>
          </span>
        ),
      },
      { id: 'movement', header: 'Movement Type', cell: (r) => MOVEMENT_TYPE_LABEL[r.movementType] },
      { id: 'type', header: 'Tariff Type', cell: (r) => TARIFF_TYPE_LABEL[r.tariffType] },
      { id: 'lines', header: 'Charges', numeric: true, cell: (r) => r.lineCount },
      { id: 'status', header: 'Status', cell: (r) => <ActiveStatus isActive={r.isActive} /> },
    ],
    [],
  );

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`/api/tenant/purchase/tariffs/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      void list.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tariff"
        description="Local charges at a port — port tariff and CFS charges — by movement."
        action={
          can('PURCHASE.TARIFF.CREATE') ? (
            <Button asChild>
              <Link href={'/purchase/tariff/new' as Route}>+ Add tariff</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search tariffs"
            placeholder="Code, port or country"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Movement</span>
          <Select aria-label="Movement type" value={list.filters.movementType ?? ''} onChange={(e) => list.setFilter('movementType', e.target.value)}>
            <option value="">Inbound and outbound</option>
            {MOVEMENT_TYPES.map((m) => (
              <option key={m} value={m}>
                {MOVEMENT_TYPE_LABEL[m]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Tariff type</span>
          <Select aria-label="Tariff type" value={list.filters.tariffType ?? ''} onChange={(e) => list.setFilter('tariffType', e.target.value)}>
            <option value="">Every type</option>
            {TARIFF_TYPES.map((t) => (
              <option key={t} value={t}>
                {TARIFF_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-36 flex-col gap-1">
          <span className="label-manifest">Status</span>
          <Select aria-label="Status" value={list.filters.isActive ?? ''} onChange={(e) => list.setFilter('isActive', e.target.value)}>
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
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
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'code' | 'pol' | 'country', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('PURCHASE.TARIFF.EDIT') && (
              <Link href={`/purchase/tariff/${row.id}` as Route} className="text-body text-harbour hover:underline">
                Edit
              </Link>
            )}
            {can('PURCHASE.TARIFF.TOGGLE_STATUS') && (
              <Button variant={row.isActive ? 'destructive' : 'text'} size="inline" onClick={() => setToToggle(row)}>
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No tariffs match those filters"
              description="Try a different term, or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No tariffs yet"
              description="Add the port tariff or CFS charges for a port, so the local charges are on record beside the freight."
            />
          )
        }
      />

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this tariff?' : 'Activate this tariff?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.code} (${toToggle.polName}) will be kept but marked inactive.`
              : `${toToggle.code} will be active again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}
