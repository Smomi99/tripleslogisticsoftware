'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CommodityItemDto,
  type CommodityItemInput,
  commodityItemInputSchema,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ChildScreen } from '@/components/ui/child-screen';
import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';

/** Category → Item (CLAUDE.md §5 Table_Industry_Sector_Item_List, §8). */
export default function CommodityItemPage() {
  const params = useParams<{ id: string }>();
  const sectorId = params.id;

  const columns: DataTableColumn<CommodityItemDto>[] = [
    { id: 'name', header: 'Item', sortable: true, cell: (r) => r.name },
    { id: 'hsCode', header: 'HS Code', numeric: true, cell: (r) => r.hsCode ?? '—' },
  ];

  return (
    <ChildScreen<CommodityItemDto>
      parentEndpoint={`/api/tenant/setting/commodity-categories/${sectorId}`}
      childEndpoint={`/api/tenant/setting/commodity-categories/${sectorId}/items`}
      backHref={'/setting/commodity' as Route}
      parentLabel="Commodity category"
      title="Items"
      feature="SETTING.COMMODITY_CATEGORY"
      columns={columns}
      searchPlaceholder="Search items or HS codes"
      addLabel="+ Add item"
      noun="item"
      emptyTitle="No items yet"
      emptyDescription="List what ships under this category, with the HS code customs will want."
      describeRow={(r) => r.name}
      renderForm={({ row, onSubmit, onCancel }) => (
        <CommodityItemForm item={row} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function CommodityItemForm({
  item,
  onSubmit,
  onCancel,
}: {
  item: CommodityItemDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CommodityItemInput>({
    resolver: zodResolver(commodityItemInputSchema),
    defaultValues: { name: '', hsCode: '' },
  });

  useEffect(() => {
    reset({ name: item?.name ?? '', hsCode: item?.hsCode ?? '' });
    setFormError(null);
  }, [item, reset]);

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
      submitLabel={item === null ? 'Add item' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Item name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
      <Field
        id="hsCode"
        label="HS code"
        hint="Harmonised System code, e.g. 6109.10."
        error={errors.hsCode?.message}
      >
        <Input id="hsCode" numeric inputMode="decimal" {...register('hsCode')} />
      </Field>
    </FormLayout>
  );
}
