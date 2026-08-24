'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ContainerSizeDto,
  type ContainerSizeInput,
  containerSizeInputSchema,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { LookupScreen } from '@/components/ui/lookup-screen';
import { ApiError } from '@/lib/api-client';

/**
 * Settings → Container Size (MODULE_PURCHASE_SALES §3.1).
 *
 * Every Sea FCL rate tier names one of these, and the TEU factor is what turns
 * a mixed box count into the TEU figure the reports quote.
 */
const ENDPOINT = '/api/tenant/setting/container-sizes';

export default function ContainerSizePage() {
  const columns: DataTableColumn<ContainerSizeDto>[] = [
    { id: 'name', header: 'Container Size', sortable: true, cell: (r) => r.name },
    {
      id: 'teuFactor',
      header: 'TEU Factor',
      numeric: true,
      cell: (r) => r.teuFactor,
    },
    { id: 'sortOrder', header: 'Order', numeric: true, cell: (r) => String(r.sortOrder) },
  ];

  return (
    <LookupScreen<ContainerSizeDto>
      endpoint={ENDPOINT}
      feature="SETTING.CONTAINER_SIZE"
      title="Container Size"
      description="The box sizes this workspace quotes. The TEU factor converts a box count into TEU for reporting."
      noun="container size"
      addLabel="+ Add container size"
      searchPlaceholder="Search container sizes"
      columns={columns}
      emptyDescription="Add a container size so Sea FCL rate tiers have something to point at."
      renderForm={({ row, onSubmit, onCancel }) => (
        <ContainerSizeForm row={row} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function ContainerSizeForm({
  row,
  onSubmit,
  onCancel,
}: {
  row: ContainerSizeDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ContainerSizeInput>({
    resolver: zodResolver(containerSizeInputSchema),
    defaultValues: { code: '', name: '', teuFactor: '1', sortOrder: '' },
  });

  useEffect(() => {
    reset({
      code: row?.code ?? '',
      name: row?.name ?? '',
      teuFactor: row?.teuFactor ?? '1',
      sortOrder: row === null ? '' : String(row.sortOrder),
    });
    setFormError(null);
  }, [row, reset]);

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
      submitLabel={row === null ? 'Add container size' : 'Save changes'}
      error={formError ?? undefined}
      columns={2}
    >
      <Field id="code" label="Code" required error={errors.code?.message}>
        <Input id="code" numeric autoFocus className="uppercase" {...register('code')} />
      </Field>
      <Field id="name" label="Name" required error={errors.name?.message}>
        <Input id="name" {...register('name')} />
      </Field>
      <Field
        id="teuFactor"
        label="TEU factor"
        required
        hint="20ft = 1, 40ft = 2, 45ft = 2.25"
        error={errors.teuFactor?.message}
      >
        <Input id="teuFactor" numeric inputMode="decimal" {...register('teuFactor')} />
      </Field>
      <Field
        id="sortOrder"
        label="Display order"
        hint="Lower numbers appear first."
        error={errors.sortOrder?.message}
      >
        <Input id="sortOrder" numeric inputMode="numeric" {...register('sortOrder')} />
      </Field>
    </FormLayout>
  );
}
