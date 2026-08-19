'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type IndustrySectorDto,
  type IndustrySectorInput,
  industrySectorInputSchema,
  type IndustrySectorSortField,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Settings → Commodity Category (CLAUDE.md §5 Table_Commodity_Class).
 * Its items live on the child screen, per §8's Commodity_Catagory_Item_List.
 */
const ENDPOINT = '/api/tenant/setting/commodity-categories';

export default function CommodityPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<IndustrySectorDto, IndustrySectorSortField>(ENDPOINT, 'name');

  const [editing, setEditing] = useState<IndustrySectorDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<IndustrySectorDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<IndustrySectorDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  const columns: DataTableColumn<IndustrySectorDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Category', sortable: true, cell: (r) => r.name },
      {
        id: 'itemCount',
        header: 'Items',
        align: 'right',
        numeric: true,
        cell: (r) => String(r.itemCount),
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

  async function submit(values: IndustrySectorInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<IndustrySectorDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Category added');
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
      await authorizedRequest(`/api/tenant/setting/commodity-categories/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Commodity category deleted');
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
        title="Commodity Category"
        description="What your customers ship — Garments, Leather, Pharmaceuticals — and the items under each."
        action={
          can('SETTING.COMMODITY_CATEGORY.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add category
            </Button>
          ) : null
        }
      />

      <Input
        type="search"
        placeholder="Search categories"
        aria-label="Search categories"
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
        columns={columns}
        rows={list.rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as IndustrySectorSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SETTING.COMMODITY_CATEGORY.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/setting/commodity/${row.id}/item`}>Items</Link>
              </Button>
            )}
            {can('SETTING.COMMODITY_CATEGORY.EDIT') && (
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
            {can('SETTING.COMMODITY_CATEGORY.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('SETTING.COMMODITY_CATEGORY.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No categories match that search"
              description="Try a different name, or clear the search to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No categories yet"
              description="Add your first category — Garments, say — then list the items under it."
              action={
                can('SETTING.COMMODITY_CATEGORY.CREATE') ? (
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setFormOpen(true);
                    }}
                  >
                    + Add category
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
        title={editing === null ? 'Add category' : `Edit ${editing.name}`}
      >
        <SectorForm
          sector={editing}
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
        title={toToggle?.isActive === true ? 'Deactivate this category?' : 'Activate this category?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing when creating customers and shipments. Customers already using it are unaffected.`
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
        title="Delete this commodity category?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a commodity category added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function SectorForm({
  sector,
  onSubmit,
  onCancel,
}: {
  sector: IndustrySectorDto | null;
  onSubmit: (values: IndustrySectorInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<IndustrySectorInput>({
    resolver: zodResolver(industrySectorInputSchema),
    defaultValues: { name: sector?.name ?? '' },
  });

  useEffect(() => {
    reset({ name: sector?.name ?? '' });
    setFormError(null);
  }, [sector, reset]);

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
      submitLabel={sector === null ? 'Add category' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Category name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
    </FormLayout>
  );
}
