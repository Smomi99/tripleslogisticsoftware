'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type GoodsTypeDto, type GoodsTypeInput, goodsTypeInputSchema } from '@ff/shared';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { LookupScreen } from '@/components/ui/lookup-screen';
import { ApiError } from '@/lib/api-client';

/**
 * Settings → Goods Type (MODULE_PURCHASE_SALES §3.1).
 *
 * How the cargo must be handled — distinct from Commodity Category, which says
 * what the customer ships. A reefer rate and a DG rate differ regardless of
 * whether the box holds garments or pharmaceuticals.
 */
const ENDPOINT = '/api/tenant/setting/goods-types';

export default function GoodsTypePage() {
  const columns: DataTableColumn<GoodsTypeDto>[] = [
    { id: 'name', header: 'Goods Type', sortable: true, cell: (r) => r.name },
    { id: 'description', header: 'Description', cell: (r) => r.description ?? '—' },
  ];

  return (
    <LookupScreen<GoodsTypeDto>
      endpoint={ENDPOINT}
      feature="SETTING.GOODS_TYPE"
      title="Goods Type"
      description="How the cargo is handled — general, dangerous, reefer, project. Rates are bought per goods type."
      noun="goods type"
      addLabel="+ Add goods type"
      searchPlaceholder="Search goods types"
      columns={columns}
      emptyDescription="Add a goods type so freight rates can be bought against it."
      renderForm={({ row, onSubmit, onCancel }) => (
        <GoodsTypeForm row={row} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function GoodsTypeForm({
  row,
  onSubmit,
  onCancel,
}: {
  row: GoodsTypeDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<GoodsTypeInput>({
    resolver: zodResolver(goodsTypeInputSchema),
    defaultValues: { code: '', name: '', description: '' },
  });

  useEffect(() => {
    reset({ code: row?.code ?? '', name: row?.name ?? '', description: row?.description ?? '' });
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
      submitLabel={row === null ? 'Add goods type' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="code" label="Code" required error={errors.code?.message}>
        <Input id="code" numeric autoFocus className="uppercase" {...register('code')} />
      </Field>
      <Field id="name" label="Name" required error={errors.name?.message}>
        <Input id="name" {...register('name')} />
      </Field>
      <Field id="description" label="Description" error={errors.description?.message}>
        <Input id="description" {...register('description')} />
      </Field>
    </FormLayout>
  );
}
