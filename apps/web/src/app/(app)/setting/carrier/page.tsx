'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CarrierDto,
  type CarrierInput,
  carrierInputSchema,
  type CarrierSortField,
  type LookupOption,
} from '@ff/shared';
import Link from 'next/link';
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

/**
 * Settings → Carrier (CLAUDE.md §5, §8).
 *
 * Carriers are shared (§7A rule 7), so most rows cannot be edited — but every
 * row takes this workspace's own contacts and service ports. §8 lists ADD PIC
 * and Service Port as contextual buttons on the row, which is what they are.
 */
const ENDPOINT = '/api/tenant/setting/carriers';

export default function CarrierPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<CarrierDto, CarrierSortField>(ENDPOINT, 'name');

  const [types, setTypes] = useState<LookupOption[]>([]);
  const [editing, setEditing] = useState<CarrierDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<CarrierDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<CarrierDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);
  // CR-003. A shared row belongs to every workspace, so it cannot be
  // edited — this takes a copy that can be.
  const [toCustomise, setToCustomise] = useState<CarrierDto | null>(null);
  const [isCustomising, setCustomising] = useState(false);

  useEffect(() => {
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/types`)
      .then(setTypes)
      .catch(() => setTypes([]));
  }, [authorizedRequest]);

  const columns: DataTableColumn<CarrierDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Carrier', sortable: true, cell: (r) => r.name },
      { id: 'type', header: 'Type', cell: (r) => r.typeName },
      {
        id: 'children',
        header: 'Contacts / Lanes',
        align: 'right',
        numeric: true,
        cell: (r) => `${r.picCount} / ${r.servicePortCount}`,
      },
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

  async function submit(values: CarrierInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<CarrierDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Carrier added');
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

  async function confirmCustomise(): Promise<void> {
    if (toCustomise === null) return;
    setCustomising(true);
    try {
      await authorizedRequest(`/api/tenant/setting/carriers/${toCustomise.id}/customise`, { method: 'POST' });
      toast.success('Carrier is now yours to edit');
      setToCustomise(null);
      await list.reload();
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
      await authorizedRequest(`/api/tenant/setting/carriers/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Carrier deleted');
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
        title="Carrier"
        description="Shipping lines and airlines. Shared across workspaces; your contacts and lane rankings are your own."
        action={
          can('SETTING.CARRIER.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add carrier
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search carriers"
          aria-label="Search carriers"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by type"
          value={list.filters['typeId'] ?? ''}
          onChange={(event) => list.setFilter('typeId', event.target.value)}
          className="w-48"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
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
        onSortChange={(by, order) => list.setSort(by as CarrierSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {/* §8 contextual buttons — these work on shared carriers too. */}
            {can('SETTING.CARRIER.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/setting/carrier/${row.id}/pic`}>PIC</Link>
              </Button>
            )}
            {can('SETTING.CARRIER.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/setting/carrier/${row.id}/service-port`}>Service Port</Link>
              </Button>
            )}
            {/* CR-001 §5: after Service Port, and on its own permission — the
                pricing team owns lane rankings, not whoever keeps contacts. */}
            {can('SETTING.CARRIER_PORT_PAIR.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/setting/carrier/${row.id}/port-pair`}>Port Pair</Link>
              </Button>
            )}
            {can('SETTING.CARRIER.EDIT') && !row.isSystem && (
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
            {can('SETTING.CARRIER.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('SETTING.CARRIER.EDIT') && row.isSystem && (
              <Button variant="text" size="inline" onClick={() => setToCustomise(row)}>
                Customise
              </Button>
            )}
            {can('SETTING.CARRIER.DELETE') && !row.isSystem && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No carriers match those filters"
              description="Try a different name or type, or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No carriers yet"
              description="Add your first carrier to start building price lists."
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
        title={editing === null ? 'Add carrier' : `Edit ${editing.name}`}
      >
        <CarrierForm
          carrier={editing}
          types={types}
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
        title={toToggle?.isActive === true ? 'Deactivate this carrier?' : 'Activate this carrier?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? toToggle.isSystem
                ? `${toToggle.name} is shared. Deactivating hides it from your workspace only — other workspaces keep it.`
                : `${toToggle.name} will stop appearing on new bookings and price lists.`
              : `${toToggle.name} will be available again.`
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
        title="Delete this carrier?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a carrier added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
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
        title="Make this carrier your own?"
        message={
          toCustomise === null
            ? ''
            : `${toCustomise.name} is shared with every workspace, so it cannot be edited here. This takes your own copy of it, moves your existing records onto the copy, and hides the shared carrier from your list. Nobody else is affected.`
        }
        confirmLabel="Customise"
        isPending={isCustomising}
        onConfirm={() => void confirmCustomise()}
      />
    </div>
  );
}

function CarrierForm({
  carrier,
  types,
  onSubmit,
  onCancel,
}: {
  carrier: CarrierDto | null;
  types: LookupOption[];
  onSubmit: (values: CarrierInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CarrierInput>({
    resolver: zodResolver(carrierInputSchema),
    defaultValues: {
      name: carrier?.name ?? '',
      typeId: carrier?.typeId ?? '',
      officeAddress: carrier?.officeAddress ?? '',
    },
  });

  useEffect(() => {
    reset({
      name: carrier?.name ?? '',
      typeId: carrier?.typeId ?? types[0]?.id ?? '',
      officeAddress: carrier?.officeAddress ?? '',
    });
    setFormError(null);
  }, [carrier, types, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={carrier === null ? 'Add carrier' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Carrier name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>

      <Field id="typeId" label="Type" required error={errors.typeId?.message}>
        <Select id="typeId" aria-invalid={errors.typeId !== undefined} {...register('typeId')}>
          <option value="">Choose a type</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="officeAddress" label="Office address" error={errors.officeAddress?.message}>
        <Input id="officeAddress" {...register('officeAddress')} />
      </Field>
    </FormLayout>
  );
}
