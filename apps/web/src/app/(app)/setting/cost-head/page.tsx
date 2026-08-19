'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  COST_HEAD_CATEGORIES,
  COST_HEAD_CATEGORY_LABEL,
  type CostHeadDto,
  type CostHeadInput,
  costHeadInputSchema,
  type CostHeadSortField,
  type LookupOption,
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

/**
 * Settings → Cost Head (CLAUDE.md §5).
 * Same pattern as Sea-Air Port; plain tenant-owned, so every row is editable.
 */
const ENDPOINT = '/api/tenant/setting/cost-heads';

export default function CostHeadPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<CostHeadDto, CostHeadSortField>(ENDPOINT, 'name');

  const [units, setUnits] = useState<LookupOption[]>([]);
  const [editing, setEditing] = useState<CostHeadDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<CostHeadDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<CostHeadDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  useEffect(() => {
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/units`).then(setUnits).catch(() => {
      setUnits([]);
    });
  }, [authorizedRequest]);

  const columns: DataTableColumn<CostHeadDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Cost Head', sortable: true, cell: (r) => r.name },
      {
        id: 'category',
        header: 'Category',
        sortable: true,
        cell: (r) => COST_HEAD_CATEGORY_LABEL[r.category],
      },
      { id: 'unit', header: 'Unit', cell: (r) => r.unitName },
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

  async function submit(values: CostHeadInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<CostHeadDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Cost head added');
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
      await authorizedRequest(`/api/tenant/setting/cost-heads/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Cost head deleted');
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
        title="Cost Head"
        description="The charges this workspace bills and pays, and the unit each is measured in."
        action={
          can('SETTING.COST_HEAD.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add cost head
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search cost heads"
          aria-label="Search cost heads"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by category"
          value={list.filters['category'] ?? ''}
          onChange={(event) => list.setFilter('category', event.target.value)}
          className="w-48"
        >
          <option value="">All categories</option>
          {COST_HEAD_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {COST_HEAD_CATEGORY_LABEL[c]}
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
        onSortChange={(by, order) => list.setSort(by as CostHeadSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SETTING.COST_HEAD.EDIT') && (
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
            {can('SETTING.COST_HEAD.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('SETTING.COST_HEAD.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No cost heads match those filters"
              description="Try a different name or category, or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No cost heads yet"
              description="Add your first cost head so quotations and invoices have something to charge against."
              action={
                can('SETTING.COST_HEAD.CREATE') ? (
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setFormOpen(true);
                    }}
                  >
                    + Add cost head
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
        title={editing === null ? 'Add cost head' : `Edit ${editing.name}`}
      >
        <CostHeadForm
          costHead={editing}
          units={units}
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
        title={toToggle?.isActive === true ? 'Deactivate this cost head?' : 'Activate this cost head?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing on new quotations and invoices. Existing records are unaffected.`
              : `${toToggle.name} will be available again on new quotations and invoices.`
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
        title="Delete this cost head?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a cost head added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function CostHeadForm({
  costHead,
  units,
  onSubmit,
  onCancel,
}: {
  costHead: CostHeadDto | null;
  units: LookupOption[];
  onSubmit: (values: CostHeadInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CostHeadInput>({
    resolver: zodResolver(costHeadInputSchema),
    defaultValues: {
      name: costHead?.name ?? '',
      category: costHead?.category ?? 'SERVICE',
      unitId: costHead?.unitId ?? '',
    },
  });

  useEffect(() => {
    reset({
      name: costHead?.name ?? '',
      category: costHead?.category ?? 'SERVICE',
      unitId: costHead?.unitId ?? units[0]?.id ?? '',
    });
    setFormError(null);
  }, [costHead, units, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.fields !== undefined) {
          for (const [field, messages] of Object.entries(error.fields)) {
            if (field === 'name' || field === 'category' || field === 'unitId') {
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
      submitLabel={costHead === null ? 'Add cost head' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Cost head name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>

      <Field id="category" label="Category" required error={errors.category?.message}>
        <Select id="category" aria-invalid={errors.category !== undefined} {...register('category')}>
          {COST_HEAD_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {COST_HEAD_CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="unitId"
        label="Unit"
        required
        hint="How this charge is measured — per container, per HBL, per CBM."
        error={errors.unitId?.message}
      >
        <Select id="unitId" aria-invalid={errors.unitId !== undefined} {...register('unitId')}>
          <option value="">Choose a unit</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
    </FormLayout>
  );
}
