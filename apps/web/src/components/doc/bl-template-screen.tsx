'use client';

import type { BlTemplateDto } from '@ff/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * BL templates — docs/MODULE_DOCUMENTATION.md §3.5.
 *
 * `Make Templet` saves one from a draft; this is where they are renamed,
 * corrected and retired. Not on the client's menu (their sheets have the two
 * buttons and no third screen), so it is reached from the BL Draft tab and
 * carries a Back link, the way §8 asks of every child screen.
 *
 * Retired, never deleted: a BL drafted from a template copied its text, and the
 * trail should still say where that text came from.
 */

interface Editing {
  id: string | null;
  name: string;
  customerId: string;
  shipperText: string;
  consigneeText: string;
  notifyText: string;
  alsoNotifyText: string;
  freightPayableAt: string;
  originalBlCount: string;
}

const EMPTY: Editing = {
  id: null,
  name: '',
  customerId: '',
  shipperText: '',
  consigneeText: '',
  notifyText: '',
  alsoNotifyText: '',
  freightPayableAt: '',
  originalBlCount: '',
};

function editingFrom(row: BlTemplateDto): Editing {
  return {
    id: row.id,
    name: row.name,
    customerId: row.customerId ?? '',
    shipperText: row.shipperText ?? '',
    consigneeText: row.consigneeText ?? '',
    notifyText: row.notifyText ?? '',
    alsoNotifyText: row.alsoNotifyText ?? '',
    freightPayableAt: row.freightPayableAt ?? '',
    originalBlCount: row.originalBlCount === null ? '' : String(row.originalBlCount),
  };
}

function Block({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field id={id} label={label}>
      <textarea
        id={id}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-manifest border border-line bg-surface px-3 py-2 text-body text-hull outline-none transition-colors duration-120 ease-out focus:ring-2 focus:ring-harbour"
      />
    </Field>
  );
}

export function BlTemplateScreen() {
  const { authorizedRequest, authorizedList, can } = useSession();

  const [rows, setRows] = useState<BlTemplateDto[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [isPending, setPending] = useState(false);
  const [listPending, setListPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListPending(true);
    try {
      const data = await authorizedRequest<BlTemplateDto[]>(
        '/api/tenant/documentation/bl-templates?includeInactive=1',
      );
      setRows(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the templates.');
    } finally {
      setListPending(false);
    }
  }, [authorizedRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void authorizedList<{ id: string; name: string }[]>('/api/tenant/crm/customers?limit=300')
      .then((r) => setCustomers(r.data))
      .catch(() => setCustomers([]));
  }, [authorizedList]);

  async function run(fn: () => Promise<void>, done: string): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await fn();
      toast.success(done);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<BlTemplateDto>[] = [
    { id: 'name', header: 'Name', cell: (r) => r.name },
    {
      id: 'customer',
      header: 'Customer',
      // A template with no customer is offered on every draft.
      cell: (r) => r.customerName ?? 'Every customer',
    },
    {
      id: 'agent',
      header: 'Delivery agent',
      cell: (r) => r.deliveryAgentName ?? '—',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Status tone={r.isActive ? 'active' : 'inactive'}>
          {r.isActive ? 'Active' : 'Inactive'}
        </Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Link href="/documentation/bl-draft" className="self-start text-body text-harbour hover:underline">
        ← Back to BL drafts
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="BL templates"
          description="The party blocks a bill of lading repeats for the same customer, saved once."
        />
        {can('DOCUMENTATION.BL_TEMPLATE.CREATE') && (
          <Button onClick={() => setEditing({ ...EMPTY })}>Add template</Button>
        )}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={rows.length}
        page={1}
        limit={rows.length === 0 ? 25 : rows.length}
        sortOrder="asc"
        onSortChange={() => undefined}
        onPageChange={() => undefined}
        isPending={listPending}
        empty={
          <EmptyState
            title="No templates yet"
            description="Save one from a BL draft with Make Templet, and it will be offered on the next."
          />
        }
        actions={(row) => (
          <>
            {can('DOCUMENTATION.BL_TEMPLATE.EDIT') && (
              <button
                type="button"
                className="text-body text-harbour hover:underline"
                onClick={() => setEditing(editingFrom(row))}
              >
                Edit
              </button>
            )}
            {row.isActive && can('DOCUMENTATION.BL_TEMPLATE.TOGGLE_STATUS') && (
              <button
                type="button"
                className="text-body text-alert hover:underline"
                onClick={() => {
                  void run(
                    () =>
                      authorizedRequest(
                        `/api/tenant/documentation/bl-templates/${row.id}/deactivate`,
                        { method: 'POST', body: {} },
                      ),
                    'Template retired',
                  );
                }}
              >
                Deactivate
              </button>
            )}
          </>
        )}
      />

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        size="wide"
        title={editing?.id === null ? 'New BL template' : 'Edit BL template'}
      >
        {editing !== null && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field id="tplName" label="Name" required>
                <Input
                  id="tplName"
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </Field>
              <Field
                id="tplCustomer"
                label="Customer"
                hint="Leave empty to offer it on every customer's draft."
              >
                <Select
                  id="tplCustomer"
                  value={editing.customerId}
                  onChange={(e) => setEditing({ ...editing, customerId: e.target.value })}
                >
                  <option value="">Every customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Block
                id="tplShipper"
                label="Shipper"
                value={editing.shipperText}
                onChange={(v) => setEditing({ ...editing, shipperText: v })}
              />
              <Block
                id="tplConsignee"
                label="Consignee"
                value={editing.consigneeText}
                onChange={(v) => setEditing({ ...editing, consigneeText: v })}
              />
              <Block
                id="tplNotify"
                label="Notify Party"
                value={editing.notifyText}
                onChange={(v) => setEditing({ ...editing, notifyText: v })}
              />
              <Block
                id="tplAlsoNotify"
                label="Also Notify Party"
                value={editing.alsoNotifyText}
                onChange={(v) => setEditing({ ...editing, alsoNotifyText: v })}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field id="tplFreight" label="Freight Payable at">
                <Input
                  id="tplFreight"
                  value={editing.freightPayableAt}
                  onChange={(e) => setEditing({ ...editing, freightPayableAt: e.target.value })}
                />
              </Field>
              <Field id="tplOriginals" label="No. of Original BL">
                <Input
                  id="tplOriginals"
                  numeric
                  inputMode="numeric"
                  value={editing.originalBlCount}
                  onChange={(e) => setEditing({ ...editing, originalBlCount: e.target.value })}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Back
              </Button>
              <Button
                disabled={isPending || editing.name.trim() === ''}
                onClick={() => {
                  const body = {
                    name: editing.name.trim(),
                    customerId: editing.customerId === '' ? null : editing.customerId,
                    shipperText: editing.shipperText === '' ? null : editing.shipperText,
                    consigneeText: editing.consigneeText === '' ? null : editing.consigneeText,
                    notifyText: editing.notifyText === '' ? null : editing.notifyText,
                    alsoNotifyText:
                      editing.alsoNotifyText === '' ? null : editing.alsoNotifyText,
                    freightPayableAt:
                      editing.freightPayableAt === '' ? null : editing.freightPayableAt,
                    originalBlCount:
                      editing.originalBlCount === '' ? null : Number(editing.originalBlCount),
                  };
                  void run(
                    () =>
                      editing.id === null
                        ? authorizedRequest('/api/tenant/documentation/bl-templates', {
                            method: 'POST',
                            body,
                          })
                        : authorizedRequest(
                            `/api/tenant/documentation/bl-templates/${editing.id}`,
                            { method: 'PATCH', body },
                          ),
                    'Saved',
                  );
                }}
              >
                {isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
