'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type BankDto, type BankInput, bankInputSchema } from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Setting → Bank Set up — the client's `bank setup` sheet
 * (docs/MODULE_ACCOUNTS.md §14.3).
 *
 * One row per branch of a bank: Bank Name, Branch, Bank Address, Swift No,
 * Routing number, IBAN No. Account Set up picks a bank and then a branch from
 * these, and shows the rest from here.
 */
const ENDPOINT = '/api/tenant/accounts/banks';
const FIELDS = ['bankName', 'branch', 'bankAddress', 'swiftNo', 'routingNo', 'ibanNo'] as const;

export default function BankSetupPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<BankDto, 'bankName'>(ENDPOINT, 'bankName');
  const [editing, setEditing] = useState<BankDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<BankDto | null>(null);
  const [isToggling, setToggling] = useState(false);

  const columns: DataTableColumn<BankDto>[] = useMemo(
    () => [
      { id: 'bankName', header: 'Bank Name', sortable: true, cell: (r) => r.bankName },
      { id: 'branch', header: 'Branch', cell: (r) => r.branch },
      { id: 'bankAddress', header: 'Bank Address', cell: (r) => r.bankAddress ?? '—' },
      { id: 'swiftNo', header: 'Swift No', numeric: true, align: 'left', cell: (r) => r.swiftNo ?? '—' },
      { id: 'routingNo', header: 'Routing number', numeric: true, align: 'left', cell: (r) => r.routingNo ?? '—' },
      { id: 'ibanNo', header: 'IBAN No', numeric: true, align: 'left', cell: (r) => r.ibanNo ?? '—' },
      { id: 'isActive', header: 'Status', cell: (r) => <ActiveStatus isActive={r.isActive} /> },
    ],
    [],
  );

  async function submit(values: BankInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<BankDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Bank added');
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

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Bank Set up"
        description="The banks and branches the company keeps accounts with."
        action={can('ACCOUNTS.BANK_SETUP.CREATE') ? <Button onClick={openAdd}>+ Add bank</Button> : null}
      />

      <Input
        type="search"
        placeholder="Search banks"
        aria-label="Search banks"
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
        onSortChange={(by, order) => list.setSort(by as 'bankName', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('ACCOUNTS.BANK_SETUP.EDIT') && (
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
            {can('ACCOUNTS.BANK_SETUP.TOGGLE_STATUS') && (
              <Button variant={row.isActive ? 'destructive' : 'text'} size="inline" onClick={() => setToToggle(row)}>
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No banks match that search"
              description="Try a different name or branch, or clear the search."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No banks yet"
              description="Add the bank branch the company banks with, then set up its accounts on Account Set up."
              action={can('ACCOUNTS.BANK_SETUP.CREATE') ? <Button onClick={openAdd}>+ Add bank</Button> : null}
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
        title={editing === null ? 'Add bank' : `Edit ${editing.bankName}, ${editing.branch}`}
      >
        <BankForm
          bank={editing}
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
        title={toToggle?.isActive === true ? 'Deactivate this bank?' : 'Activate this bank?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.bankName}, ${toToggle.branch} will stop being offered on Account Set up. Accounts already set up there are unaffected.`
              : `${toToggle.bankName}, ${toToggle.branch} will be offered on Account Set up again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}

function BankForm({
  bank,
  onSubmit,
  onCancel,
}: {
  bank: BankDto | null;
  onSubmit: (values: BankInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const defaults = (b: BankDto | null): BankInput => ({
    bankName: b?.bankName ?? '',
    branch: b?.branch ?? '',
    bankAddress: b?.bankAddress ?? '',
    swiftNo: b?.swiftNo ?? '',
    routingNo: b?.routingNo ?? '',
    ibanNo: b?.ibanNo ?? '',
  });
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<BankInput>({ resolver: zodResolver(bankInputSchema), defaultValues: defaults(bank) });

  useEffect(() => {
    reset(defaults(bank));
    setFormError(null);
  }, [bank, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.fields !== undefined) {
          for (const [field, messages] of Object.entries(error.fields)) {
            if ((FIELDS as readonly string[]).includes(field)) {
              setError(field as (typeof FIELDS)[number], { message: messages[0] ?? 'Invalid value.' });
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
      submitLabel={bank === null ? 'Add bank' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="bankName" label="Bank Name" required error={errors.bankName?.message}>
        <Input id="bankName" autoFocus aria-invalid={errors.bankName !== undefined} {...register('bankName')} />
      </Field>
      <Field id="branch" label="Branch" required error={errors.branch?.message}>
        <Input id="branch" aria-invalid={errors.branch !== undefined} {...register('branch')} />
      </Field>
      <Field id="bankAddress" label="Bank Address" error={errors.bankAddress?.message}>
        <Input id="bankAddress" {...register('bankAddress')} />
      </Field>
      <Field id="swiftNo" label="Swift No" error={errors.swiftNo?.message}>
        <Input id="swiftNo" numeric {...register('swiftNo')} />
      </Field>
      <Field id="routingNo" label="Routing number" error={errors.routingNo?.message}>
        <Input id="routingNo" numeric {...register('routingNo')} />
      </Field>
      <Field id="ibanNo" label="IBAN No" error={errors.ibanNo?.message}>
        <Input id="ibanNo" numeric {...register('ibanNo')} />
      </Field>
    </FormLayout>
  );
}
