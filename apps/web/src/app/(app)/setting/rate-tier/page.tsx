'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type LookupOption,
  MODE_UNIT,
  RATE_MODE_LABEL,
  RATE_MODES,
  RATE_TIER_UNIT_LABEL,
  type RateMode,
  type RateTierDto,
  type RateTierInput,
  rateTierInputSchema,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { LookupScreen } from '@/components/ui/lookup-screen';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Settings → Rate Tier (MODULE_PURCHASE_SALES §3.1, §2).
 *
 * The row that makes §2's normalized design work. Instead of four fixed price
 * columns, a rate line points at a tier: a 40HC container, a 100kg air weight
 * break, an LCL CBM band. Adding a 45ft box or a 2000kg break is a row here, not
 * a migration.
 */
const ENDPOINT = '/api/tenant/setting/rate-tiers';

function bounds(row: RateTierDto): string {
  if (row.minValue === null && row.maxValue === null) return '—';
  const unit = RATE_TIER_UNIT_LABEL[row.unit];
  if (row.maxValue === null) return `${row.minValue ?? '0'} ${unit} and above`;
  if (row.minValue === null) return `Up to ${row.maxValue} ${unit}`;
  return `${row.minValue} – ${row.maxValue} ${unit}`;
}

export default function RateTierPage() {
  const columns: DataTableColumn<RateTierDto>[] = [
    { id: 'name', header: 'Tier', sortable: true, cell: (r) => r.label },
    { id: 'mode', header: 'Mode', cell: (r) => RATE_MODE_LABEL[r.mode] },
    { id: 'unit', header: 'Unit', cell: (r) => RATE_TIER_UNIT_LABEL[r.unit] },
    { id: 'bounds', header: 'Range', numeric: true, cell: bounds },
    {
      id: 'containerSize',
      header: 'Container Size',
      cell: (r) => r.containerSizeName ?? '—',
    },
  ];

  return (
    <LookupScreen<RateTierDto>
      endpoint={ENDPOINT}
      feature="SETTING.RATE_TIER"
      title="Rate Tier"
      description="What a freight rate is priced per — a container size, a CBM band, or an air weight break."
      noun="rate tier"
      addLabel="+ Add rate tier"
      searchPlaceholder="Search rate tiers"
      columns={columns}
      emptyDescription="Add a rate tier so freight rates have something to be priced against."
      filters={(list) => (
        <Select
          aria-label="Filter by mode"
          value={list.filters.mode ?? ''}
          onChange={(event) => list.setFilter('mode', event.target.value)}
          className="w-44"
        >
          <option value="">All modes</option>
          {RATE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {RATE_MODE_LABEL[mode]}
            </option>
          ))}
        </Select>
      )}
      renderForm={({ row, onSubmit, onCancel }) => (
        <RateTierForm row={row} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function RateTierForm({
  row,
  onSubmit,
  onCancel,
}: {
  row: RateTierDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const { authorizedList } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const [containerOptions, setContainerOptions] = useState<LookupOption[]>([]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<RateTierInput>({
    resolver: zodResolver(rateTierInputSchema),
    defaultValues: {
      code: '',
      mode: 'SEA_FCL',
      label: '',
      unit: 'CONTAINER',
      minValue: '',
      maxValue: '',
      sortOrder: '',
      containerSizeId: '',
    },
  });

  const mode = watch('mode');

  useEffect(() => {
    reset({
      code: row?.code ?? '',
      mode: row?.mode ?? 'SEA_FCL',
      label: row?.label ?? '',
      unit: row?.unit ?? 'CONTAINER',
      minValue: row?.minValue ?? '',
      maxValue: row?.maxValue ?? '',
      sortOrder: row === null ? '' : String(row.sortOrder),
      containerSizeId: row?.containerSizeId ?? '',
    });
    setFormError(null);
  }, [row, reset]);

  // The unit is not a free choice — Sea FCL is per container, LCL per CBM, Air
  // per KG. It is shown so the form is self-explanatory, and kept in step with
  // the mode so the schema's refine can never fire on a value the user picked.
  useEffect(() => {
    setValue('unit', MODE_UNIT[mode as RateMode], { shouldValidate: false });
  }, [mode, setValue]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<LookupOption[]>(`${ENDPOINT}/container-options`);
        if (!cancelled) setContainerOptions(response.data);
      } catch {
        // A missing option list is not worth blocking the form for — the server
        // refuses a Sea FCL tier without a container size either way.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit({
        ...values,
        // Only Sea FCL carries a container size; the other modes must not.
        containerSizeId: values.mode === 'SEA_FCL' ? values.containerSizeId : undefined,
      });
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  const unitLabel = RATE_TIER_UNIT_LABEL[MODE_UNIT[mode as RateMode]];

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={row === null ? 'Add rate tier' : 'Save changes'}
      error={formError ?? undefined}
      columns={2}
    >
      <Field id="code" label="Code" required error={errors.code?.message}>
        <Input id="code" numeric autoFocus className="uppercase" {...register('code')} />
      </Field>
      <Field id="label" label="Label" required error={errors.label?.message}>
        <Input id="label" {...register('label')} />
      </Field>
      <Field id="mode" label="Mode" required error={errors.mode?.message}>
        <Select id="mode" {...register('mode')}>
          {RATE_MODES.map((value) => (
            <option key={value} value={value}>
              {RATE_MODE_LABEL[value]}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        id="unit"
        label="Priced per"
        hint="Set by the mode."
        error={errors.unit?.message}
      >
        <Input id="unit" value={unitLabel} readOnly disabled />
      </Field>

      {mode === 'SEA_FCL' ? (
        <Field
          id="containerSizeId"
          label="Container size"
          required
          hint="A Sea FCL tier prices one box size."
          error={errors.containerSizeId?.message}
          wide
        >
          <Select id="containerSizeId" {...register('containerSizeId')}>
            <option value="">Select a container size</option>
            {containerOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field
            id="minValue"
            label={`From (${unitLabel})`}
            hint="Leave blank for no lower bound."
            error={errors.minValue?.message}
          >
            <Input id="minValue" numeric inputMode="decimal" {...register('minValue')} />
          </Field>
          <Field
            id="maxValue"
            label={`Up to (${unitLabel})`}
            hint="Leave blank for the top band."
            error={errors.maxValue?.message}
          >
            <Input id="maxValue" numeric inputMode="decimal" {...register('maxValue')} />
          </Field>
        </>
      )}

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
