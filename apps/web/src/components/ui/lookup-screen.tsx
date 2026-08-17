'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { type MasterListState, useMasterList } from '@/lib/use-master-list';

/**
 * A Settings screen for a system-capable lookup.
 *
 * The Sea-Air Port anatomy — shared rows alongside the workspace's own, Edit
 * hidden on a shared row, deactivate writing an override — reduced to one
 * component. The five §3.1 lookups differ only in their columns and their form,
 * so those are all a caller supplies.
 */

interface LookupRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  isSystem: boolean;
}

export interface LookupScreenProps<TRow extends LookupRow> {
  endpoint: string;
  feature: string;
  title: string;
  description: string;
  /** Singular noun for toasts and confirmations, e.g. "goods type". */
  noun: string;
  addLabel: string;
  searchPlaceholder: string;
  columns: DataTableColumn<TRow>[];
  emptyDescription: string;
  /** Extra controls beside the search box, e.g. a mode filter. */
  filters?: (list: MasterListState<TRow, 'name'>) => ReactNode;
  renderForm: (args: {
    row: TRow | null;
    onSubmit: (values: unknown) => Promise<void>;
    onCancel: () => void;
  }) => ReactNode;
}

export function LookupScreen<TRow extends LookupRow>({
  endpoint,
  feature,
  title,
  description,
  noun,
  addLabel,
  searchPlaceholder,
  columns,
  emptyDescription,
  filters,
  renderForm,
}: LookupScreenProps<TRow>) {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<TRow, 'name'>(endpoint, 'name');

  const [editing, setEditing] = useState<TRow | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<TRow | null>(null);
  const [isToggling, setToggling] = useState(false);

  const withMeta: DataTableColumn<TRow>[] = useMemo(
    () => [
      ...columns,
      {
        id: 'source',
        header: 'Source',
        cell: (r) => (
          <span className="text-cell text-steel">{r.isSystem ? 'Shared' : 'Workspace'}</span>
        ),
      },
      {
        id: 'isActive',
        header: 'Status',
        cell: (r) => (
          <Status tone={r.isActive ? 'active' : 'inactive'}>
            {r.isActive ? 'Active' : 'Inactive'}
          </Status>
        ),
      },
    ],
    [columns],
  );

  async function submit(values: unknown): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest(isEdit ? `${endpoint}/${editing.id}` : endpoint, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} added`);
    await list.reload();
  }

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`${endpoint}/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={title}
        description={description}
        action={
          can(`${feature}.CREATE`) ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              {addLabel}
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        {filters?.(list)}
      </div>

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={withMeta}
        rows={list.rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'name', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {/* §7A rule 7: a shared row is switchable, never editable. */}
            {can(`${feature}.EDIT`) && !row.isSystem && (
              <Button
                variant="text"
                size="inline"
                onClick={() => {
                  setEditing(row);
                  setFormOpen(true);
                }}
              >
                Edit
              </Button>
            )}
            {can(`${feature}.TOGGLE_STATUS`) && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title={`No ${noun}s match those filters`}
              description="Try a different term, or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState title={`No ${noun}s yet`} description={emptyDescription} />
          )
        }
      />

      <Modal
        open={isFormOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing === null ? addLabel.replace('+ ', '') : `Edit ${editing.name}`}
      >
        {renderForm({
          row: editing,
          onSubmit: submit,
          onCancel: () => {
            setFormOpen(false);
            setEditing(null);
          },
        })}
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? `Deactivate this ${noun}?` : `Activate this ${noun}?`}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? toToggle.isSystem
                ? `${toToggle.name} is shared. Deactivating hides it from your workspace only — other workspaces keep it.`
                : `${toToggle.name} will stop appearing when creating new records.`
              : `${toToggle.name} will be available again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}
