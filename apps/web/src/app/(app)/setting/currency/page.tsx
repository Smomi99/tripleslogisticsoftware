'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CurrencyDto,
  type CurrencyInput,
  currencyInputSchema,
  type CurrencyRateInput,
  currencyRateInputSchema,
  type CurrencySortField,
  formatRate,
  isoCurrency,
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
 * Settings → Currency (CLAUDE.md §5).
 *
 * Shared currencies cannot be edited (§7A rule 7), so the way a workspace
 * expresses its own rate is "Set rate" — which writes currency_rate_history
 * rather than touching the shared row.
 */
const ENDPOINT = '/api/tenant/setting/currencies';

export default function CurrencyPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<CurrencyDto, CurrencySortField>(ENDPOINT, 'currency');

  /*
    What this workspace books in. Every rate on this screen is "units of THIS
    per one unit of that currency", and until the screen said so the numbers
    were unlabelled — a column of figures against a base nobody had named.
  */
  const baseIso = useMemo(
    () => list.rows.find((r) => r.isBase)?.currency ?? null,
    [list.rows],
  );
  const baseCode = baseIso === null ? null : isoCurrency(baseIso);
  const canSetBase = can('SETTING.CURRENCY.SET_BASE');

  const [editing, setEditing] = useState<CurrencyDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [rateFor, setRateFor] = useState<CurrencyDto | null>(null);
  const [toToggle, setToToggle] = useState<CurrencyDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<CurrencyDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);
  // CR-003. A shared row belongs to every workspace, so it cannot be
  // edited — this takes a copy that can be.
  const [toCustomise, setToCustomise] = useState<CurrencyDto | null>(null);
  const [isCustomising, setCustomising] = useState(false);
  /** The currency about to become the base — a change worth confirming. */
  const [toBase, setToBase] = useState<CurrencyDto | null>(null);
  const [isRebasing, setRebasing] = useState(false);

  const columns: DataTableColumn<CurrencyDto>[] = useMemo(
    () => [
      {
        id: 'currency',
        header: 'Currency',
        sortable: true,
        /*
          The base is marked here rather than in a column of its own: it is a
          fact about this currency, and one row in the table has it. §12 says a
          state is a dot and a label, not a coloured pill.
        */
        cell: (r) => (
          <span className="flex items-center gap-2">
            {r.currency}
            {r.isBase && (
              <span
                className="inline-flex items-center gap-1.5 text-cell text-verified"
                title="Every rate is expressed against this currency"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-verified" aria-hidden />
                Base
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'conversion',
        header: 'System Rate',
        sortable: true,
        align: 'right',
        numeric: true,
        /*
          The built-in default, which is expressed against the SYSTEM base —
          whichever shared currency sits at 1. Once a workspace has moved its
          base off that, this figure is in a different base entirely, and
          showing it beside the booking rate invites comparing two numbers that
          do not belong on the same axis. It is withheld rather than explained
          away; lib/currency-rate refuses to convert with it for the same
          reason.
        */
        cell: (r) =>
          r.systemRateComparable ? (
            formatRate(r.conversion)
          ) : (
            <span className="text-steel" title="In a different base to this workspace's, so not comparable">
              —
            </span>
          ),
      },
      {
        id: 'tenantRate',
        header: baseCode === null ? 'Your Rate' : `Your Rate (${baseCode})`,
        align: 'right',
        numeric: true,
        cell: (r) =>
          r.tenantRate === null ? (
            <span className="text-steel">—</span>
          ) : (
            formatRate(r.tenantRate)
          ),
      },
      {
        id: 'effectiveRate',
        header: baseCode === null ? 'Booking Rate' : `Booking Rate (${baseCode})`,
        align: 'right',
        numeric: true,
        cell: (r) =>
          r.effectiveRate === null ? (
            /*
              No rate this workspace can use. Said plainly, and in --alert,
              because nothing can be quoted in this currency until somebody
              sets one — the server refuses it, so a figure here would be a
              promise the API will not keep.
            */
            <span
              className="text-alert"
              title="Set a rate for this currency before quoting in it"
            >
              No rate
            </span>
          ) : (
            <span className="flex items-center justify-end gap-2">
              <span className="font-medium">{formatRate(r.effectiveRate)}</span>
              {r.usingSystemDefault && (
                <span
                  className="text-cell text-signal"
                  title="No rate set for this workspace — the built-in default is being used"
                >
                  default
                </span>
              )}
            </span>
          ),
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
    [baseCode],
  );

  async function submitCurrency(values: CurrencyInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest<CurrencyDto>(isEdit ? `${ENDPOINT}/${editing.id}` : ENDPOINT, {
      method: isEdit ? 'PATCH' : 'POST',
      body: values,
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Currency added');
    await list.reload();
  }

  async function submitRate(values: CurrencyRateInput): Promise<void> {
    if (rateFor === null) return;
    await authorizedRequest(`${ENDPOINT}/${rateFor.id}/rate`, { method: 'POST', body: values });
    setRateFor(null);
    toast.success('Rate set');
    await list.reload();
  }

  async function confirmBase(): Promise<void> {
    if (toBase === null) return;
    setRebasing(true);
    try {
      const result = await authorizedRequest<{ rebased: number; changed: boolean }>(
        `${ENDPOINT}/${toBase.id}/set-base`,
        { method: 'POST' },
      );
      toast.success(
        result.changed
          ? `Base is now ${toBase.currency} — ${result.rebased} rates re-expressed`
          : `${toBase.currency} was already the base`,
      );
      setToBase(null);
      await list.reload();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not change the base currency.',
      );
    } finally {
      setRebasing(false);
    }
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
      await authorizedRequest(`/api/tenant/setting/currencies/${toCustomise.id}/customise`, { method: 'POST' });
      toast.success('Currency is now yours to edit');
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
      await authorizedRequest(`/api/tenant/setting/currencies/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Currency deleted');
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
        title="Currency"
        description={
          baseCode === null
            ? 'No base currency set. Choose one with Make base — nothing can be priced until you do.'
            : `Every rate below is ${baseCode} per one unit of that currency. ${baseCode} is this workspace's base, so it sits at 1.`
        }
        action={
          can('SETTING.CURRENCY.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add currency
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            placeholder="Search currencies"
            aria-label="Search currencies"
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
            className="w-72"
          />
        </div>

        {/*
          The base, chosen here rather than from a row action (client request,
          2026-09-09). It belongs beside the filter because it governs the whole
          table — every figure below is expressed against it — rather than being
          a property of any one row.

          Still SET_BASE, not EDIT: this re-expresses every rate the workspace
          holds. Someone without it sees which currency is the base and cannot
          move it.
        */}
        <div className="flex flex-col gap-1">
          <span className="label-manifest">Base currency</span>
          <Select
            aria-label="Base currency"
            className="w-64"
            value={list.rows.find((r) => r.isBase)?.id ?? ''}
            disabled={!canSetBase}
            title={
              canSetBase
                ? 'Every rate is expressed against this'
                : 'Only an administrator can change the base currency'
            }
            onChange={(event) => {
              const next = list.rows.find((r) => r.id === event.target.value);
              if (next !== undefined && !next.isBase) setToBase(next);
            }}
          >
            {list.rows.find((r) => r.isBase) === undefined && (
              <option value="">Not set — choose one</option>
            )}
            {list.rows
              .filter((r) => r.isActive || r.isBase)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {isoCurrency(r.currency)}
                </option>
              ))}
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
        onSortChange={(by, order) => list.setSort(by as CurrencySortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {/*
              The base converts to itself at 1, so there is no rate to set on
              it — offering the control would invite somebody to break the one
              invariant the whole conversion rests on.
            */}
            {can('SETTING.CURRENCY.EDIT') && !row.isBase && (
              <Button variant="text" size="inline" onClick={() => setRateFor(row)}>
                Set rate
              </Button>
            )}

            {can('SETTING.CURRENCY.EDIT') && !row.isSystem && (
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
            {can('SETTING.CURRENCY.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('SETTING.CURRENCY.EDIT') && row.isSystem && (
              <Button variant="text" size="inline" onClick={() => setToCustomise(row)}>
                Customise
              </Button>
            )}
            {can('SETTING.CURRENCY.DELETE') && !row.isSystem && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No currencies match that search"
              description="Try a different code or name, or clear the search to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No currencies yet"
              description="Add a currency so quotations and invoices can be priced in it."
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
        title={editing === null ? 'Add currency' : `Edit ${editing.currency}`}
      >
        <CurrencyForm
          currency={editing}
          onSubmit={submitCurrency}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      </Modal>

      <Modal
        open={rateFor !== null}
        onOpenChange={(open) => {
          if (!open) setRateFor(null);
        }}
        title={rateFor === null ? 'Set rate' : `Set your rate for ${rateFor.currency}`}
        description="The rate currently in force is closed off rather than overwritten, so the history stays auditable."
      >
        <RateForm
          currency={rateFor}
          onSubmit={submitRate}
          onCancel={() => setRateFor(null)}
        />
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this currency?' : 'Activate this currency?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? toToggle.isSystem
                ? `${toToggle.currency} is shared. Deactivating hides it from your workspace only — other workspaces keep it.`
                : `${toToggle.currency} will stop appearing on new quotations and invoices.`
              : `${toToggle.currency} will be available again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />

      <ConfirmDialog
        open={toBase !== null}
        onOpenChange={(open) => {
          if (!open) setToBase(null);
        }}
        title="Make this the base currency?"
        message={
          toBase === null
            ? ''
            : `Every rate you hold will be re-expressed against ${toBase.currency}, so the numbers on this screen will change — but what each currency is worth relative to another will not. Quotations already sent keep the rate they were sent with.`
        }
        confirmLabel="Make base"
        isPending={isRebasing}
        onConfirm={() => void confirmBase()}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Delete this currency?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.currency} will be removed from the list for good. This is for a currency added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
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
        title="Make this currency your own?"
        message={
          toCustomise === null
            ? ''
            : `${toCustomise.currency} is shared with every workspace, so it cannot be edited here. This takes your own copy of it, moves your existing records onto the copy, and hides the shared currency from your list. Nobody else is affected.`
        }
        confirmLabel="Customise"
        isPending={isCustomising}
        onConfirm={() => void confirmCustomise()}
      />
    </div>
  );
}

function CurrencyForm({
  currency,
  onSubmit,
  onCancel,
}: {
  currency: CurrencyDto | null;
  onSubmit: (values: CurrencyInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CurrencyInput>({
    resolver: zodResolver(currencyInputSchema),
    defaultValues: {
      currency: currency?.currency ?? '',
      conversion: currency?.conversion ?? '1.0000',
    },
  });

  useEffect(() => {
    reset({
      currency: currency?.currency ?? '',
      conversion: currency?.conversion ?? '1.0000',
    });
    setFormError(null);
  }, [currency, reset]);

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
      submitLabel={currency === null ? 'Add currency' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field
        id="currency"
        label="Currency"
        required
        hint="ISO code and name, e.g. USD — US Dollar."
        error={errors.currency?.message}
      >
        <Input id="currency" autoFocus aria-invalid={errors.currency !== undefined} {...register('currency')} />
      </Field>

      <Field
        id="conversion"
        label="Rate against BDT"
        required
        hint="Up to 4 decimal places."
        error={errors.conversion?.message}
      >
        <Input
          id="conversion"
          numeric
          inputMode="decimal"
          aria-invalid={errors.conversion !== undefined}
          {...register('conversion')}
        />
      </Field>
    </FormLayout>
  );
}

function RateForm({
  currency,
  onSubmit,
  onCancel,
}: {
  currency: CurrencyDto | null;
  onSubmit: (values: CurrencyRateInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CurrencyRateInput>({
    resolver: zodResolver(currencyRateInputSchema),
    defaultValues: { rate: currency?.effectiveRate ?? '', effectiveFrom: today },
  });

  useEffect(() => {
    reset({ rate: currency?.effectiveRate ?? '', effectiveFrom: today });
    setFormError(null);
  }, [currency, reset, today]);

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
      submitLabel="Set rate"
      error={formError ?? undefined}
    >
      <Field
        id="rate"
        label="Your rate against BDT"
        required
        hint={
          currency === null
            ? undefined
            : `The shared system rate is ${currency.conversion}.`
        }
        error={errors.rate?.message}
      >
        <Input id="rate" numeric autoFocus inputMode="decimal" aria-invalid={errors.rate !== undefined} {...register('rate')} />
      </Field>

      <Field id="effectiveFrom" label="Effective from" required error={errors.effectiveFrom?.message}>
        <Input
          id="effectiveFrom"
          type="date"
          numeric
          aria-invalid={errors.effectiveFrom !== undefined}
          {...register('effectiveFrom')}
        />
      </Field>
    </FormLayout>
  );
}
