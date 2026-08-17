'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import type { LookupRowDto } from '@ff/shared';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { Field, Input } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';

/** A code-and-name form — TOS and Inquiry Source have nothing else to carry. */
export function SimpleLookupForm({
  row,
  schema,
  submitLabel,
  nameLabel,
  onSubmit,
  onCancel,
}: {
  row: LookupRowDto | null;
  schema: z.ZodType<{ code: string; name: string }, { code: string; name: string }>;
  submitLabel: string;
  nameLabel: string;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ code: string; name: string }>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', name: '' },
  });

  useEffect(() => {
    reset({ code: row?.code ?? '', name: row?.name ?? '' });
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
      submitLabel={row === null ? submitLabel : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="code" label="Code" required error={errors.code?.message}>
        <Input id="code" numeric autoFocus className="uppercase" {...register('code')} />
      </Field>
      <Field id="name" label={nameLabel} required error={errors.name?.message}>
        <Input id="name" {...register('name')} />
      </Field>
    </FormLayout>
  );
}
