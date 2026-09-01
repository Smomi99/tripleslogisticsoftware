'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CustomerPicDto, type CustomerPicInput, customerPicInputSchema } from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ChildScreen } from '@/components/ui/child-screen';
import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';

/** CRM → Customer → PIC (CLAUDE.md §6 Table_Customer_PIC, §8 child screen). */
export default function CustomerPicPage() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;

  const columns: DataTableColumn<CustomerPicDto>[] = [
    { id: 'name', header: 'Name', sortable: true, cell: (r) => r.name },
    { id: 'department', header: 'Department', cell: (r) => r.department ?? '—' },
    { id: 'designation', header: 'Designation', cell: (r) => r.designation ?? '—' },
    { id: 'mobile', header: 'Mobile', numeric: true, cell: (r) => r.mobile ?? '—' },
    { id: 'email', header: 'Email', cell: (r) => r.email ?? '—' },
  ];

  return (
    <ChildScreen<CustomerPicDto>
      parentEndpoint={`/api/tenant/crm/customers/${customerId}`}
      childEndpoint={`/api/tenant/crm/customers/${customerId}/pics`}
      backHref={'/crm/customer' as Route}
      parentLabel="Customer"
      title="Contacts (PIC)"
      feature="CRM.CUSTOMER"
      columns={columns}
      searchPlaceholder="Search contacts"
      addLabel="+ Add PIC"
      noun="contact"
      emptyTitle="No contacts yet"
      emptyDescription="Add the people you deal with at this customer, so inquiries and quotations can reach them."
      describeRow={(r) => r.name}
      deletable
      renderForm={({ row, onSubmit, onCancel }) => (
        <CustomerPicForm pic={row} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function CustomerPicForm({
  pic,
  onSubmit,
  onCancel,
}: {
  pic: CustomerPicDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CustomerPicInput>({
    resolver: zodResolver(customerPicInputSchema),
    defaultValues: { name: '', department: '', designation: '', mobile: '', email: '' },
  });

  useEffect(() => {
    reset({
      name: pic?.name ?? '',
      department: pic?.department ?? '',
      designation: pic?.designation ?? '',
      mobile: pic?.mobile ?? '',
      email: pic?.email ?? '',
    });
    setFormError(null);
  }, [pic, reset]);

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
      submitLabel={pic === null ? 'Add PIC' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
      <Field id="department" label="Department" error={errors.department?.message}>
        <Input id="department" {...register('department')} />
      </Field>
      <Field id="designation" label="Designation" error={errors.designation?.message}>
        <Input id="designation" {...register('designation')} />
      </Field>
      <Field id="mobile" label="Mobile" error={errors.mobile?.message}>
        <Input id="mobile" numeric {...register('mobile')} />
      </Field>
      <Field id="email" label="Email" error={errors.email?.message}>
        <Input id="email" type="email" {...register('email')} />
      </Field>
    </FormLayout>
  );
}
