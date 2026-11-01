'use client';

import {
  customerGroupCreateSchema,
  type CustomerGroupCustomerOption,
  type CustomerGroupDetailDto,
  type CustomerGroupDto,
  customerGroupUpdateSchema,
  type LookupOption,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { MultiSelect } from '@/components/ui/multi-select';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const ENDPOINT = '/api/tenant/crm/customer-groups';

type Errors = Partial<Record<'name' | 'customerIds', string>>;

/**
 * Create custom group / Edit group (owner, 2026-11-01). Two fields, so a
 * modal (§8): the name, and the customers in it — a searchable multi-select,
 * where adding is a click on a name and removing is the × on its chip.
 */
export function CustomerGroupForm({
  group,
  onClose,
  onSaved,
}: {
  /** Null to create one. */
  group: CustomerGroupDto | null;
  onClose: () => void;
  onSaved: (saved: CustomerGroupDto) => void;
}) {
  const { authorizedRequest } = useSession();
  const [customers, setCustomers] = useState<CustomerGroupCustomerOption[] | null>(null);
  const [name, setName] = useState(group?.name ?? '');
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  // Editing waits for the members before the picker can show them.
  const [loaded, setLoaded] = useState(group === null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const [options, detail] = await Promise.all([
        authorizedRequest<CustomerGroupCustomerOption[]>(`${ENDPOINT}/customers`),
        group === null ? Promise.resolve(null) : authorizedRequest<CustomerGroupDetailDto>(`${ENDPOINT}/${group.id}`),
      ]);
      if (!live) return;
      setCustomers(options);
      if (detail !== null) {
        setName(detail.name);
        setCustomerIds(detail.customerIds);
      }
      setLoaded(true);
    };
    load().catch((caught: unknown) => {
      if (live) setFormError(caught instanceof ApiError ? caught.message : 'Could not load the customers. Close this and try again.');
    });
    return () => {
      live = false;
    };
  }, [authorizedRequest, group]);

  // A deactivated customer can stay in a group, and says so; Bulk email skips it.
  const options = useMemo<LookupOption[]>(
    () => (customers ?? []).map((c) => ({ id: c.id, name: c.isActive ? c.name : `${c.name} — inactive` })),
    [customers],
  );

  async function submit(): Promise<void> {
    const parsed = (group === null ? customerGroupCreateSchema : customerGroupUpdateSchema).safeParse({ name, customerIds });
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Errors | undefined;
        if (key !== undefined && next[key] === undefined) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      const saved = await authorizedRequest<CustomerGroupDto>(group === null ? ENDPOINT : `${ENDPOINT}/${group.id}`, {
        method: group === null ? 'POST' : 'PUT',
        body: parsed.data,
      });
      toast.success(group === null ? `Group ${saved.name} created` : 'Saved');
      onSaved(saved);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not save the group. Please try again.');
    } finally {
      setPending(false);
    }
  }

  const ready = customers !== null && loaded;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={group === null ? 'Create custom group' : `Edit group — ${group.name}`}
      description="Name the group and choose its customers. It becomes a filter on the Customer list, and Bulk email writes to whoever the list shows."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="group-name" label="Group name" required error={errors.name}>
          <Input
            id="group-name"
            value={name}
            maxLength={100}
            placeholder="e.g. Key accounts"
            aria-invalid={errors.name !== undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          id="group-customers"
          label="Customers"
          required={group === null}
          error={errors.customerIds}
          hint={
            !ready
              ? 'Loading customers…'
              : `${customerIds.length} chosen. Type to find a customer; the × on a name takes it out.`
          }
        >
          <MultiSelect
            id="group-customers"
            options={options}
            value={customerIds}
            onChange={setCustomerIds}
            placeholder={ready ? 'Choose customers' : 'Loading customers…'}
            searchPlaceholder="Type a customer name or code"
            invalid={errors.customerIds !== undefined}
          />
        </Field>
        {formError !== null && (
          <p role="alert" className="text-cell text-alert">
            {formError}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending} className="max-sm:w-full">
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !ready} className="max-sm:w-full">
            {pending ? 'Saving…' : group === null ? 'Create group' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
