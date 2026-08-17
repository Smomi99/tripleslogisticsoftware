'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CarrierPicDto, type CarrierPicInput, carrierPicInputSchema } from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ChildScreen } from '@/components/ui/child-screen';
import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';

/** Carrier → PIC (CLAUDE.md §5 Table_Carrier_PIC, §8 child screen). */
export default function CarrierPicPage() {
  // Next 16 made route params async on the server; a client component reads
  // them through useParams instead.
  const params = useParams<{ id: string }>();
  const carrierId = params.id;

  const columns: DataTableColumn<CarrierPicDto>[] = [
    { id: 'name', header: 'Name', sortable: true, cell: (r) => r.name },
    { id: 'department', header: 'Department', cell: (r) => r.department ?? '—' },
    { id: 'designation', header: 'Designation', cell: (r) => r.designation ?? '—' },
    { id: 'telNo', header: 'Tel', numeric: true, cell: (r) => r.telNo ?? '—' },
    { id: 'mobileNo', header: 'Mobile', numeric: true, cell: (r) => r.mobileNo ?? '—' },
    { id: 'email', header: 'Email', cell: (r) => r.email ?? '—' },
    { id: 'country', header: 'Country', cell: (r) => r.country ?? '—' },
  ];

  return (
    <ChildScreen<CarrierPicDto>
      parentEndpoint={`/api/tenant/setting/carriers/${carrierId}`}
      childEndpoint={`/api/tenant/setting/carriers/${carrierId}/pics`}
      backHref={'/setting/carrier' as Route}
      parentLabel="Carrier"
      title="Contacts (PIC)"
      feature="SETTING.CARRIER"
      columns={columns}
      searchPlaceholder="Search contacts"
      addLabel="+ Add PIC"
      noun="contact"
      emptyTitle="No contacts yet"
      emptyDescription="Add the people you deal with at this carrier, so bookings and quotations can reach them."
      describeRow={(r) => r.name}
      renderForm={({ row, onSubmit, onCancel }) => (
        <CarrierPicForm pic={row} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function CarrierPicForm({
  pic,
  onSubmit,
  onCancel,
}: {
  pic: CarrierPicDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const empty: CarrierPicInput = {
    name: '',
    department: '',
    designation: '',
    telNo: '',
    mobileNo: '',
    email: '',
    country: '',
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CarrierPicInput>({
    resolver: zodResolver(carrierPicInputSchema),
    defaultValues: empty,
  });

  useEffect(() => {
    reset(
      pic === null
        ? empty
        : {
            name: pic.name,
            department: pic.department ?? '',
            designation: pic.designation ?? '',
            telNo: pic.telNo ?? '',
            mobileNo: pic.mobileNo ?? '',
            email: pic.email ?? '',
            country: pic.country ?? '',
          },
    );
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      columns={2}
    >
      <Field id="name" label="Name" required error={errors.name?.message} wide>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
      <Field id="department" label="Department" error={errors.department?.message}>
        <Input id="department" {...register('department')} />
      </Field>
      <Field id="designation" label="Designation" error={errors.designation?.message}>
        <Input id="designation" {...register('designation')} />
      </Field>
      <Field id="telNo" label="Telephone" error={errors.telNo?.message}>
        <Input id="telNo" numeric {...register('telNo')} />
      </Field>
      <Field id="mobileNo" label="Mobile" error={errors.mobileNo?.message}>
        <Input id="mobileNo" numeric {...register('mobileNo')} />
      </Field>
      <Field id="email" label="Email" error={errors.email?.message}>
        <Input id="email" type="email" {...register('email')} />
      </Field>
      <Field id="country" label="Country" error={errors.country?.message}>
        <CountrySelect id="country" placeholder="—" {...register('country')} />
      </Field>
    </FormLayout>
  );
}
