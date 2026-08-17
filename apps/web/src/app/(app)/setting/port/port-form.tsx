'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type PortDto,
  type PortInput,
  portInputSchema,
  PORT_TYPE_LABEL,
  PORT_TYPES,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Field, Input, Select } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';

/**
 * Add / Edit port. Four fields, so §8 puts it in a modal.
 *
 * The Zod schema is the shared one the API validates with, so a rule cannot
 * drift between the two sides (CLAUDE.md §2).
 */
export function PortForm({
  port,
  onSubmit,
  onCancel,
}: {
  port: PortDto | null;
  onSubmit: (values: PortInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PortInput>({
    resolver: zodResolver(portInputSchema),
    defaultValues: {
      name: port?.name ?? '',
      portCode: port?.portCode ?? '',
      country: port?.country ?? '',
      type: port?.type ?? 'SEAPORT',
    },
  });

  useEffect(() => {
    reset({
      name: port?.name ?? '',
      portCode: port?.portCode ?? '',
      country: port?.country ?? '',
      type: port?.type ?? 'SEAPORT',
    });
    setFormError(null);
  }, [port, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiError) {
        // Map the §9 envelope's field errors back onto the form.
        if (error.fields !== undefined) {
          for (const [field, messages] of Object.entries(error.fields)) {
            if (field === 'name' || field === 'portCode' || field === 'country' || field === 'type') {
              setError(field, { message: messages[0] ?? 'Invalid value.' });
            }
          }
          return;
        }
        setFormError(error.message);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  });

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={port === null ? 'Add port' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Port name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>

      <Field
        id="portCode"
        label="Port code"
        required
        hint="UN/LOCODE for a seaport (BDCGP), IATA for an airport (DAC)."
        error={errors.portCode?.message}
      >
        <Input
          id="portCode"
          numeric
          className="uppercase"
          aria-invalid={errors.portCode !== undefined}
          {...register('portCode')}
        />
      </Field>

      <Field id="country" label="Country" required error={errors.country?.message}>
        <CountrySelect id="country" aria-invalid={errors.country !== undefined} {...register('country')} />
      </Field>

      <Field id="type" label="Type" required error={errors.type?.message}>
        <Select id="type" aria-invalid={errors.type !== undefined} {...register('type')}>
          {PORT_TYPES.map((type) => (
            <option key={type} value={type}>
              {PORT_TYPE_LABEL[type]}
            </option>
          ))}
        </Select>
      </Field>
    </FormLayout>
  );
}
