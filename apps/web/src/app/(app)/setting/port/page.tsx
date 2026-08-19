'use client';

import {
  type ApiMeta,
  DEFAULT_PAGE_SIZE,
  type PortDto,
  type PortInput,
  PORT_TYPE_LABEL,
  type PortSortField,
} from '@ff/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { PortForm } from './port-form';

/**
 * Settings → Sea-Air Port (CLAUDE.md §5, §8).
 *
 * The reference implementation for every master screen: server-side search,
 * sort and pagination (§9); permission-gated controls that are hidden rather
 * than disabled (§7); confirm on deactivate; toast naming the same verb as the
 * button (§9).
 */
export default function PortListPage() {
  const { authorizedRequest, authorizedList, can } = useSession();

  const [rows, setRows] = useState<PortDto[]>([]);
  const [meta, setMeta] = useState<ApiMeta>({ page: 1, limit: DEFAULT_PAGE_SIZE, total: 0, totalPages: 1 });
  const [isPending, setIsPending] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<PortSortField>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const [editing, setEditing] = useState<PortDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<PortDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Separate from the toggle: Deactivate retires a port that was real,
  // Delete removes one that never was.
  const [toDelete, setToDelete] = useState<PortDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);
  // CR-003. A shared row belongs to every workspace, so it cannot be
  // edited — this takes a copy that can be.
  const [toCustomise, setToCustomise] = useState<PortDto | null>(null);
  const [isCustomising, setCustomising] = useState(false);

  // §8: search is server-side and debounced.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsPending(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(DEFAULT_PAGE_SIZE),
      sortBy,
      sortOrder,
    });
    if (search !== '') params.set('search', search);
    if (typeFilter !== '') params.set('type', typeFilter);

    try {
      const response = await authorizedList<PortDto[]>(
        `/api/tenant/setting/ports?${params.toString()}`,
      );
      // A slower earlier request must not overwrite a newer result — typing in
      // the search box fires several, and they can land out of order.
      if (requestId !== requestIdRef.current) return;
      setRows(response.data);
      if (response.meta !== undefined) setMeta(response.meta);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setLoadError(
        error instanceof ApiError ? error.message : 'Could not load ports. Please try again.',
      );
    } finally {
      if (requestId === requestIdRef.current) setIsPending(false);
    }
  }, [authorizedList, page, search, sortBy, sortOrder, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<PortDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Port Name', sortable: true, cell: (r) => r.name },
      { id: 'portCode', header: 'Port Code', sortable: true, numeric: true, cell: (r) => r.portCode },
      { id: 'country', header: 'Country', sortable: true, cell: (r) => r.country },
      { id: 'type', header: 'Type', sortable: true, cell: (r) => PORT_TYPE_LABEL[r.type] },
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
    [],
  );

  async function submitPort(values: PortInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<PortDto>(
      isEdit ? `/api/tenant/setting/ports/${editing.id}` : '/api/tenant/setting/ports',
      { method: isEdit ? 'PATCH' : 'POST', body: values },
    );
    setFormOpen(false);
    setEditing(null);
    // §9: the toast carries the same verb as the button that caused it.
    toast.success(isEdit ? 'Saved' : 'Port added');
    await load();
  }

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest<{ isActive: boolean }>(
        `/api/tenant/setting/ports/${toToggle.id}/toggle-status`,
        { method: 'POST' },
      );
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await load();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not change the status.',
      );
    } finally {
      setToggling(false);
    }
  }

  async function confirmCustomise(): Promise<void> {
    if (toCustomise === null) return;
    setCustomising(true);
    try {
      await authorizedRequest(`/api/tenant/setting/ports/${toCustomise.id}/customise`, { method: 'POST' });
      toast.success('Port is now yours to edit');
      setToCustomise(null);
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not customise it.');
      setToCustomise(null);
    } finally {
      setCustomising(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (toDelete === null) return;
    setDeleting(true);
    try {
      await authorizedRequest(`/api/tenant/setting/ports/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Port deleted');
      setToDelete(null);
      await load();
    } catch (error) {
      // A refusal here names what is still using the port, which is the whole
      // point — the operator needs to know to deactivate it instead.
      toast.error(error instanceof ApiError ? error.message : 'Could not delete the port.');
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sea-Air Port"
        description="Ports shared across every workspace, plus any this workspace adds."
        action={
          can('SETTING.SEA_AIR_PORT.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add port
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search name, code or country"
          aria-label="Search ports"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(event) => {
            setTypeFilter(event.target.value);
            setPage(1);
          }}
          className="w-40"
        >
          <option value="">All types</option>
          <option value="SEAPORT">Seaport</option>
          <option value="AIRPORT">Airport</option>
        </Select>
      </div>

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={meta.total}
        page={page}
        limit={DEFAULT_PAGE_SIZE}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={(by, order) => {
          setSortBy(by as PortSortField);
          setSortOrder(order);
          setPage(1);
        }}
        onPageChange={setPage}
        isPending={isPending}
        actions={(row) => (
          <>
            {/* §7A rule 7: a shared row is never editable, only switchable. */}
            {can('SETTING.SEA_AIR_PORT.EDIT') && !row.isSystem && (
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
            {can('SETTING.SEA_AIR_PORT.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('SETTING.SEA_AIR_PORT.EDIT') && row.isSystem && (
              <Button variant="text" size="inline" onClick={() => setToCustomise(row)}>
                Customise
              </Button>
            )}
            {/* A shared port belongs to every workspace, so it is never this
                workspace's to delete (§7A rule 7) — the API refuses too. */}
            {can('SETTING.SEA_AIR_PORT.DELETE') && !row.isSystem && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          search !== '' || typeFilter !== '' ? (
            <EmptyState
              title="No ports match those filters"
              description="Try a different name, port code or country — or clear the filters to see every port."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearchInput('');
                    setTypeFilter('');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No ports yet"
              description="Add your first port to start building price lists and shipping orders."
              action={
                can('SETTING.SEA_AIR_PORT.CREATE') ? (
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setFormOpen(true);
                    }}
                  >
                    + Add port
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
        title={editing === null ? 'Add port' : `Edit ${editing.name}`}
        description={
          editing === null ? 'This port will belong to your workspace.' : undefined
        }
      >
        <PortForm
          port={editing}
          onSubmit={submitPort}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this port?' : 'Activate this port?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? toToggle.isSystem
                ? `${toToggle.name} is a shared port. Deactivating hides it from your workspace only — other workspaces keep it.`
                : `${toToggle.name} will stop appearing when creating new records. Existing records that reference it are unaffected.`
              : `${toToggle.name} will be available again when creating new records.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Delete this port?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a port added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={toCustomise !== null}
        onOpenChange={(open) => {
          if (!open) setToCustomise(null);
        }}
        title="Make this port your own?"
        message={
          toCustomise === null
            ? ''
            : `${toCustomise.name} is shared with every workspace, so it cannot be edited here. This takes your own copy of it, moves your existing records onto the copy, and hides the shared port from your list. Nobody else is affected.`
        }
        confirmLabel="Customise"
        isPending={isCustomising}
        onConfirm={() => void confirmCustomise()}
      />
    </div>
  );
}
