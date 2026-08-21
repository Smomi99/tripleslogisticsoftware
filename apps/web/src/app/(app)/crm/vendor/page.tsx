'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type LookupOption,
  type VendorDto,
  type VendorInput,
  vendorInputSchema,
  type VendorSortField,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/** Settings → Vendor (CLAUDE.md §5 Table_Vendor). Tenant-owned throughout. */
const ENDPOINT = '/api/tenant/crm/vendors';

export default function VendorPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<VendorDto, VendorSortField>(ENDPOINT, 'name');

  const [types, setTypes] = useState<LookupOption[]>([]);
  const [currencies, setCurrencies] = useState<LookupOption[]>([]);
  const [editing, setEditing] = useState<VendorDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<VendorDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<VendorDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  useEffect(() => {
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/types`)
      .then(setTypes)
      .catch(() => setTypes([]));
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/currencies`)
      .then(setCurrencies)
      .catch(() => setCurrencies([]));
  }, [authorizedRequest]);

  const columns: DataTableColumn<VendorDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Vendor', sortable: true, cell: (r) => r.name },
      { id: 'vendorType', header: 'Type', cell: (r) => r.vendorTypeName },
      { id: 'country', header: 'Country', sortable: true, cell: (r) => r.country },
      { id: 'tinNo', header: 'TIN', numeric: true, cell: (r) => r.tinNo ?? '—' },
      { id: 'vatNo', header: 'VAT / BIN', numeric: true, cell: (r) => r.vatNo ?? '—' },
      {
        id: 'picCount',
        header: 'Contacts',
        align: 'right',
        numeric: true,
        cell: (r) => String(r.picCount),
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

  async function submit(values: VendorInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<VendorDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Vendor added');
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
      await authorizedRequest(`/api/tenant/crm/vendors/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Vendor deleted');
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
        title="Vendor"
        description="Suppliers this workspace buys from — coloaders, transporters, agents."
        action={
          can('CRM.VENDOR.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add vendor
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search vendors"
          aria-label="Search vendors"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by type"
          value={list.filters['vendorTypeId'] ?? ''}
          onChange={(event) => list.setFilter('vendorTypeId', event.target.value)}
          className="w-56"
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
        onSortChange={(by, order) => list.setSort(by as VendorSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('CRM.VENDOR.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/vendor/${row.id}/pic`}>Contacts</Link>
              </Button>
            )}
            {can('CRM.VENDOR.EDIT') && (
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
            {can('CRM.VENDOR.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('CRM.VENDOR.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No vendors match those filters"
              description="Try a different name, country or type, or clear the filters."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No vendors yet"
              description="Add your first vendor so purchases and payables have someone to bill against."
              action={
                can('CRM.VENDOR.CREATE') ? (
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setFormOpen(true);
                    }}
                  >
                    + Add vendor
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
        title={editing === null ? 'Add vendor' : `Edit ${editing.name}`}
      >
        <VendorForm
          vendor={editing}
          types={types}
          currencies={currencies}
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
        title={toToggle?.isActive === true ? 'Deactivate this vendor?' : 'Activate this vendor?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing on new purchases. Existing records are unaffected.`
              : `${toToggle.name} will be available again on new purchases.`
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
        title="Delete this vendor?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a vendor added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function VendorForm({
  vendor,
  types,
  currencies,
  onSubmit,
  onCancel,
}: {
  vendor: VendorDto | null;
  types: LookupOption[];
  currencies: LookupOption[];
  onSubmit: (values: VendorInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<VendorInput>({
    resolver: zodResolver(vendorInputSchema),
    defaultValues: {
      name: '',
      country: '',
      address: '',
      serviceDescription: '',
      vendorTypeId: '',
      bankDetails: '',
      tinNo: '',
      vatNo: '',
      openingBalance: '',
      openingCurrencyId: '',
    },
  });

  useEffect(() => {
    reset({
      name: vendor?.name ?? '',
      country: vendor?.country ?? '',
      address: vendor?.address ?? '',
      serviceDescription: vendor?.serviceDescription ?? '',
      vendorTypeId: vendor?.vendorTypeId ?? types[0]?.id ?? '',
      bankDetails: vendor?.bankDetails ?? '',
      tinNo: vendor?.tinNo ?? '',
      vatNo: vendor?.vatNo ?? '',
      openingBalance: vendor?.openingBalance ?? '',
      openingCurrencyId: vendor?.openingCurrencyId ?? '',
    });
    setFormError(null);
  }, [vendor, types, reset]);

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
      submitLabel={vendor === null ? 'Add vendor' : 'Save changes'}
      error={formError ?? undefined}
      // Eight fields would be a very tall single column inside a modal.
      columns={2}
    >
      <Field id="name" label="Vendor name" required error={errors.name?.message} wide>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
      <Field id="vendorTypeId" label="Vendor type" required error={errors.vendorTypeId?.message}>
        <Select id="vendorTypeId" aria-invalid={errors.vendorTypeId !== undefined} {...register('vendorTypeId')}>
          <option value="">Choose a type</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="country" label="Country" required error={errors.country?.message}>
        <CountrySelect id="country" aria-invalid={errors.country !== undefined} {...register('country')} />
      </Field>
      <Field id="address" label="Address" error={errors.address?.message} wide>
        <Input id="address" {...register('address')} />
      </Field>
      <Field
        id="serviceDescription"
        label="Service description"
        error={errors.serviceDescription?.message}
        wide
      >
        <Input id="serviceDescription" {...register('serviceDescription')} />
      </Field>
      <Field id="tinNo" label="TIN" error={errors.tinNo?.message}>
        <Input id="tinNo" numeric {...register('tinNo')} />
      </Field>
      <Field id="vatNo" label="VAT / BIN" error={errors.vatNo?.message}>
        <Input id="vatNo" numeric {...register('vatNo')} />
      </Field>
      {/* Opening figures for the accounts ledger. */}
      <Field
        id="openingBalance"
        label="Opening balance"
        error={errors.openingBalance?.message}
      >
        <Input id="openingBalance" numeric inputMode="decimal" {...register('openingBalance')} />
      </Field>

      <Field
        id="openingCurrencyId"
        label="Currency"
        error={errors.openingCurrencyId?.message}
      >
        <Select id="openingCurrencyId" {...register('openingCurrencyId')}>
          <option value="">Select a currency</option>
          {currencies.map((currency) => (
            <option key={currency.id} value={currency.id}>
              {currency.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="bankDetails" label="Bank details" error={errors.bankDetails?.message} wide>
        <Input id="bankDetails" {...register('bankDetails')} />
      </Field>
    </FormLayout>
  );
}
