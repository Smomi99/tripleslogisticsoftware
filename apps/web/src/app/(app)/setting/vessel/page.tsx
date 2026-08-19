'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type LookupOption,
  type VesselDto,
  type VesselInput,
  vesselInputSchema,
  type VesselSortField,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/** Settings → Vessel (CLAUDE.md §5). Tenant-owned, referencing shared carriers. */
const ENDPOINT = '/api/tenant/setting/vessels';

export default function VesselPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<VesselDto, VesselSortField>(ENDPOINT, 'name');

  const [carriers, setCarriers] = useState<LookupOption[]>([]);
  const [editing, setEditing] = useState<VesselDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<VesselDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<VesselDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  useEffect(() => {
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/carriers`)
      .then(setCarriers)
      .catch(() => setCarriers([]));
  }, [authorizedRequest]);

  const columns: DataTableColumn<VesselDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Vessel Name', sortable: true, cell: (r) => r.name },
      { id: 'carrier', header: 'Carrier', cell: (r) => r.carrierName },
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

  async function submit(values: VesselInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<VesselDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Vessel added');
    await list.reload();
  }

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`${ENDPOINT}/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (toDelete === null) return;
    setDeleting(true);
    try {
      await authorizedRequest(`/api/tenant/setting/vessels/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Vessel deleted');
      setToDelete(null);
      await list.reload();
    } catch (error) {
      // The refusal names what still uses it, which is the point.
      toast.error(error instanceof ApiError ? error.message : 'Could not delete it.');
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Vessel"
        description="Ships and aircraft, each belonging to a carrier."
        action={
          can('SETTING.VESSEL.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add vessel
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search vessels"
          aria-label="Search vessels"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by carrier"
          value={list.filters['carrierId'] ?? ''}
          onChange={(event) => list.setFilter('carrierId', event.target.value)}
          className="w-56"
        >
          <option value="">All carriers</option>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
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
        onSortChange={(by, order) => list.setSort(by as VesselSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SETTING.VESSEL.EDIT') && (
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
            {can('SETTING.VESSEL.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('SETTING.VESSEL.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No vessels match those filters"
              description="Try a different name or carrier, or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No vessels yet"
              description="Add your first vessel so bookings and shipping orders can name the ship."
              action={
                can('SETTING.VESSEL.CREATE') ? (
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setFormOpen(true);
                    }}
                  >
                    + Add vessel
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
        title={editing === null ? 'Add vessel' : `Edit ${editing.name}`}
      >
        <VesselForm
          vessel={editing}
          carriers={carriers}
          onSubmit={submit}
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
        title={toToggle?.isActive === true ? 'Deactivate this vessel?' : 'Activate this vessel?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing on new bookings. Existing shipments are unaffected.`
              : `${toToggle.name} will be available again on new bookings.`
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
        title="Delete this vessel?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a vessel added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function VesselForm({
  vessel,
  carriers,
  onSubmit,
  onCancel,
}: {
  vessel: VesselDto | null;
  carriers: LookupOption[];
  onSubmit: (values: VesselInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<VesselInput>({
    resolver: zodResolver(vesselInputSchema),
    defaultValues: { name: vessel?.name ?? '', carrierId: vessel?.carrierId ?? '' },
  });

  useEffect(() => {
    reset({
      name: vessel?.name ?? '',
      carrierId: vessel?.carrierId ?? carriers[0]?.id ?? '',
    });
    setFormError(null);
  }, [vessel, carriers, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.fields !== undefined) {
          for (const [field, messages] of Object.entries(error.fields)) {
            if (field === 'name' || field === 'carrierId') {
              setError(field, { message: messages[0] ?? 'Invalid value.' });
            }
          }
          return;
        }
        setFormError(error.message);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  });

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={vessel === null ? 'Add vessel' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Vessel name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>

      <Field id="carrierId" label="Carrier" required error={errors.carrierId?.message}>
        <Select id="carrierId" aria-invalid={errors.carrierId !== undefined} {...register('carrierId')}>
          <option value="">Choose a carrier</option>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
    </FormLayout>
  );
}
