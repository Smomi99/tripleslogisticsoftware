'use client';

import { type SalesLeadDto, type SalesLeadInput, salesLeadInputSchema } from '@ff/shared';
import { zodResolver } from '@hookform/resolvers/zod';
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
 * Sales → New Sales Lead (CLAUDE.md §3, MODULE_PURCHASE_SALES §9 Q12).
 *
 * A lead is a conversation before there is a lane. The record carries only a
 * name and notes because neither lead screen has a wireframe (§11) — the fields
 * a client's version would add are not guessed at here.
 *
 * Standard §8 master screen otherwise, with a child link to the follow-up
 * history and a count of the inquiries this lead has produced.
 */
export default function SalesLeadPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<SalesLeadDto, 'name'>('/api/tenant/sales/leads', 'name');

  const [editing, setEditing] = useState<SalesLeadDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<SalesLeadDto | null>(null);
  const [isToggling, setToggling] = useState(false);

  const columns: DataTableColumn<SalesLeadDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Lead', sortable: true, cell: (r) => r.name },
      {
        id: 'notes',
        header: 'Notes',
        cell: (r) =>
          r.notes === null ? (
            <span className="text-steel">—</span>
          ) : (
            <span title={r.notes}>
              {r.notes.length > 60 ? `${r.notes.slice(0, 60)}…` : r.notes}
            </span>
          ),
      },
      {
        id: 'followups',
        header: 'Follow-ups',
        numeric: true,
        cell: (r) => (
          <>
            <div>{r.followupCount}</div>
            {r.nextFollowupDate !== null && (
              <div className="text-steel">next {r.nextFollowupDate}</div>
            )}
          </>
        ),
      },
      {
        id: 'inquiries',
        header: 'Inquiries',
        numeric: true,
        cell: (r) => (r.inquiryCount === 0 ? <span className="text-steel">—</span> : r.inquiryCount),
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

  async function submit(values: SalesLeadInput): Promise<void> {
    const isEdit = editing !== null;
    await authorizedRequest(
      isEdit ? `/api/tenant/sales/leads/${editing.id}` : '/api/tenant/sales/leads',
      { method: isEdit ? 'PATCH' : 'POST', body: values },
    );
    setFormOpen(false);
    setEditing(null);
    toast.success(isEdit ? 'Saved' : 'Lead added');
    await list.reload();
  }

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`/api/tenant/sales/leads/${toToggle.id}/toggle-status`, {
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sales Lead"
        description="Conversations that have not become an inquiry yet."
        action={
          can('SALES.NEW_SALES_LEAD.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add lead
            </Button>
          ) : null
        }
      />

      <Input
        type="search"
        placeholder="Search leads"
        aria-label="Search leads"
        value={list.searchInput}
        onChange={(event) => list.setSearchInput(event.target.value)}
        className="w-72"
      />

      {list.error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
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
        onSortChange={(by, order) => list.setSort(by as 'name', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SALES.NEW_SALES_LEAD.EDIT') && (
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
            {can('SALES.SALES_LEAD_FOLLOWUP.VIEW') && (
              <Link
                href={{ pathname: `/sales/sales-lead/${row.id}/followup` }}
                className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
              >
                Follow-up
              </Link>
            )}
            {can('SALES.NEW_SALES_LEAD.TOGGLE_STATUS') && (
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
              title="No leads match that search"
              description="Try a different name, or clear the search to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No leads yet"
              description="Add the first conversation you are working, then raise an inquiry from it once there is a lane."
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
        title={editing === null ? 'Add lead' : `Edit ${editing.name}`}
      >
        <LeadForm
          lead={editing}
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
        title={toToggle?.isActive === true ? 'Deactivate this lead?' : 'Activate this lead?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing when raising an inquiry. Its follow-up history is kept.`
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

function LeadForm({
  lead,
  onSubmit,
  onCancel,
}: {
  lead: SalesLeadDto | null;
  onSubmit: (values: SalesLeadInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SalesLeadInput>({
    resolver: zodResolver(salesLeadInputSchema),
    defaultValues: { name: '', notes: '' },
  });

  useEffect(() => {
    reset({ name: lead?.name ?? '', notes: lead?.notes ?? '' });
    setFormError(null);
  }, [lead, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not save the lead. Try again.',
      );
    }
  });

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={lead === null ? 'Add lead' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field
        id="name"
        label="Who is this lead with?"
        required
        hint="A company or a person — whatever you have so far."
        error={errors.name?.message}
      >
        <Input id="name" autoFocus {...register('name')} />
      </Field>
      <Field id="notes" label="Notes" error={errors.notes?.message}>
        <Input id="notes" {...register('notes')} />
      </Field>
    </FormLayout>
  );
}
