'use client';

import type { Route } from 'next';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * The §8 child-screen scaffold.
 *
 * §8 fixes the anatomy: scoped to the parent id via URL, the parent's name in
 * the header, and a Back to list link on every one — "required, not optional".
 * Built once here so the four child screens cannot each get it slightly wrong.
 *
 * The caller supplies only what actually differs: the columns, the form, and
 * the wording.
 */

interface ChildRow {
  id: string;
  code: string;
  isActive: boolean;
}

export interface ChildScreenProps<TRow extends ChildRow> {
  /** e.g. /api/tenant/setting/carriers/12 */
  parentEndpoint: string;
  /** e.g. /api/tenant/setting/carriers/12/pics */
  childEndpoint: string;
  backHref: Route;
  parentLabel: string;
  title: string;
  /** Permission feature key, e.g. SETTING.CARRIER */
  feature: string;
  columns: DataTableColumn<TRow>[];
  /**
   * Column the list sorts by until the user clicks a header. Defaults to
   * "name", which is what the contact and service-port lists sort by — a child
   * whose API takes a different set of sort fields must say so, or every list
   * request is a 400.
   */
  defaultSort?: string;
  searchPlaceholder: string;
  addLabel: string;
  /** Singular noun for toasts and confirmations, e.g. "contact". */
  noun: string;
  emptyTitle: string;
  emptyDescription: string;
  renderForm: (args: {
    row: TRow | null;
    onSubmit: (values: unknown) => Promise<void>;
    onCancel: () => void;
  }) => ReactNode;
  describeRow: (row: TRow) => string;
  /**
   * CR-001 §4 rule 3: a create that collides with a row that already exists
   * should reopen that row for editing rather than dead-end on an error.
   * Returns the colliding row's id, or null to let the error surface normally.
   */
  conflictOpensRow?: (error: ApiError) => string | null;
  /** Extra sentence on the deactivate confirmation — what else it affects. */
  deactivateWarning?: (row: TRow) => string | null;
}

export function ChildScreen<TRow extends ChildRow>({
  parentEndpoint,
  childEndpoint,
  backHref,
  parentLabel,
  title,
  feature,
  columns,
  defaultSort = 'name',
  searchPlaceholder,
  addLabel,
  noun,
  emptyTitle,
  emptyDescription,
  renderForm,
  describeRow,
  conflictOpensRow,
  deactivateWarning,
}: ChildScreenProps<TRow>) {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<TRow, string>(childEndpoint, defaultSort);

  const [parentName, setParentName] = useState<string>('');
  const [parentError, setParentError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TRow | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<TRow | null>(null);
  const [isToggling, setToggling] = useState(false);

  useEffect(() => {
    void authorizedRequest<{ name: string }>(`${parentEndpoint}/summary`)
      .then((parent) => setParentName(parent.name))
      .catch((error) =>
        setParentError(
          error instanceof ApiError ? error.message : 'Could not load this record.',
        ),
      );
  }, [authorizedRequest, parentEndpoint]);

  async function submit(values: unknown): Promise<void> {
    const isEdit = editing !== null;
    try {
      await authorizedRequest(isEdit ? `${childEndpoint}/${editing.id}` : childEndpoint, {
        method: isEdit ? 'PATCH' : 'POST',
        body: values,
      });
    } catch (error) {
      const existingId =
        error instanceof ApiError && conflictOpensRow !== undefined
          ? conflictOpensRow(error)
          : null;
      if (existingId === null) throw error;
      // Swap the open modal from create to edit on the row that already exists.
      const existing = await authorizedRequest<TRow>(`${childEndpoint}/${existingId}`);
      toast.info((error as ApiError).message);
      setEditing(existing);
      return;
    }
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} added`);
    await list.reload();
  }

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`${childEndpoint}/${toToggle.id}/toggle-status`, {
        method: 'POST',
      });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  const withStatus: DataTableColumn<TRow>[] = [
    ...columns,
    {
      id: 'isActive',
      header: 'Status',
      cell: (r) => (
        <Status tone={r.isActive ? 'active' : 'inactive'}>
          {r.isActive ? 'Active' : 'Inactive'}
        </Status>
      ),
    },
  ];

  if (parentError !== null) {
    return (
      <div className="flex flex-col gap-4">
        <ChildScreenHeader
          parentLabel={parentLabel}
          parentName="—"
          title={title}
          backHref={backHref}
        />
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {parentError}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ChildScreenHeader
          parentLabel={parentLabel}
          parentName={parentName === '' ? '…' : parentName}
          title={title}
          backHref={backHref}
        />
        {can(`${feature}.CREATE`) && (
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            {addLabel}
          </Button>
        )}
      </div>

      <Input
        type="search"
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        value={list.searchInput}
        onChange={(event) => list.setSearchInput(event.target.value)}
        className="w-72"
      />

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={withStatus}
        rows={list.rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can(`${feature}.EDIT`) && (
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
              title={`No ${noun}s match that search`}
              description="Try a different term, or clear the search to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={emptyTitle}
              description={emptyDescription}
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
          )
        }
      />

      <Modal
        open={isFormOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing === null ? addLabel.replace('+ ', '') : `Edit ${describeRow(editing)}`}
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
              ? [
                  `${describeRow(toToggle)} will stop appearing on new records. Existing records are unaffected.`,
                  deactivateWarning?.(toToggle),
                ]
                  .filter((line) => line !== null && line !== undefined)
                  .join(' ')
              : `${describeRow(toToggle)} will be available again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}
