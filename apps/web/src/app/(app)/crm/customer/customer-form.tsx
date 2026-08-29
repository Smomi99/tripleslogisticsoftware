'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  BUSINESS_AREA_LABEL,
  BUSINESS_AREAS,
  CUSTOMER_TYPE_LABEL,
  CUSTOMER_TYPES,
  type CustomerDto,
  type CustomerInput,
  customerInputSchema,
  type LookupOption,
} from '@ff/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Field, Input, Select } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const ENDPOINT = '/api/tenant/crm/customers';

/**
 * Customer form (CLAUDE.md §6).
 *
 * Ten fields, so §8 puts it on a full page rather than in a modal — shared by
 * the new and edit routes so the two cannot drift.
 */
export function CustomerForm({ customer }: { customer: CustomerDto | null }) {
  const { authorizedRequest } = useSession();
  const router = useRouter();
  const [sectors, setSectors] = useState<LookupOption[]>([]);
  const [currencies, setCurrencies] = useState<LookupOption[]>([]);
  const [salesmen, setSalesmen] = useState<LookupOption[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CustomerInput>({
    resolver: zodResolver(customerInputSchema),
    defaultValues: {
      name: '',
      country: '',
      address: '',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: '',
      exSeaVolumeTeuMonth: '',
      exAirVolumeKgMonth: '',
      imSeaVolumeTeuMonth: '',
      imAirVolumeKgMonth: '',
      openingBalance: '',
      openingCurrencyId: '',
      notes: '',
      salesmanId: '',
    },
  });

  useEffect(() => {
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/sectors`)
      .then(setSectors)
      .catch(() => setSectors([]));
      void authorizedRequest<LookupOption[]>('/api/tenant/crm/customers/currencies')
      .then(setCurrencies)
      .catch(() => setCurrencies([]));
    void authorizedRequest<LookupOption[]>('/api/tenant/crm/customers/salesmen')
      .then(setSalesmen)
      .catch(() => setSalesmen([]));
  }, [authorizedRequest]);

  useEffect(() => {
    if (customer === null) return;
    reset({
      name: customer.name,
      country: customer.country,
      address: customer.address ?? '',
      customerType: customer.customerType,
      businessArea: customer.businessArea,
      industrySectorId: customer.industrySectorId,
      exSeaVolumeTeuMonth: customer.exSeaVolumeTeuMonth ?? '',
      exAirVolumeKgMonth: customer.exAirVolumeKgMonth ?? '',
      imSeaVolumeTeuMonth: customer.imSeaVolumeTeuMonth ?? '',
      imAirVolumeKgMonth: customer.imAirVolumeKgMonth ?? '',
      openingBalance: customer.openingBalance ?? '',
      openingCurrencyId: customer.openingCurrencyId ?? '',
      notes: customer.notes ?? '',
      salesmanId: customer.salesmanId ?? '',
    });
  }, [customer, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest<CustomerDto>(
        customer === null ? ENDPOINT : `${ENDPOINT}/${customer.id}`,
        { method: customer === null ? 'POST' : 'PATCH', body: values },
      );
      toast.success(customer === null ? 'Customer added' : 'Saved');
      router.push('/crm/customer');
    } catch (error) {
      if (error instanceof ApiError && error.fields !== undefined) {
        for (const [field, messages] of Object.entries(error.fields)) {
          if (field in values) {
            setError(field as keyof CustomerInput, {
              message: messages[0] ?? 'Invalid value.',
            });
          }
        }
        return;
      }
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
      onCancel={() => router.push('/crm/customer')}
      isPending={isSubmitting}
      submitLabel={customer === null ? 'Add customer' : 'Save changes'}
      error={formError ?? undefined}
      columns={2}
    >
      <Field id="name" label="Customer name" required error={errors.name?.message} wide>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>

      <Field id="country" label="Country" required error={errors.country?.message}>
        <CountrySelect id="country" aria-invalid={errors.country !== undefined} {...register('country')} />
      </Field>

      <Field
        id="industrySectorId"
        label="Commodity category"
        required
        error={errors.industrySectorId?.message}
      >
        <Select
          id="industrySectorId"
          aria-invalid={errors.industrySectorId !== undefined}
          {...register('industrySectorId')}
        >
          <option value="">Choose a category</option>
          {sectors.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="customerType" label="Customer type" required error={errors.customerType?.message}>
        <Select id="customerType" {...register('customerType')}>
          {CUSTOMER_TYPES.map((t) => (
            <option key={t} value={t}>
              {CUSTOMER_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="businessArea" label="Business area" required error={errors.businessArea?.message}>
        <Select id="businessArea" {...register('businessArea')}>
          {BUSINESS_AREAS.map((a) => (
            <option key={a} value={a}>
              {BUSINESS_AREA_LABEL[a]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="address" label="Address" error={errors.address?.message} wide>
        <Input id="address" {...register('address')} />
      </Field>

      <Field
        id="exSeaVolumeTeuMonth"
        label="Export sea volume (TEU / month)"
        error={errors.exSeaVolumeTeuMonth?.message}
      >
        <Input id="exSeaVolumeTeuMonth" numeric inputMode="decimal" {...register('exSeaVolumeTeuMonth')} />
      </Field>

      <Field
        id="exAirVolumeKgMonth"
        label="Export air volume (KG / month)"
        error={errors.exAirVolumeKgMonth?.message}
      >
        <Input id="exAirVolumeKgMonth" numeric inputMode="decimal" {...register('exAirVolumeKgMonth')} />
      </Field>

      <Field
        id="imSeaVolumeTeuMonth"
        label="Import sea volume (TEU / month)"
        error={errors.imSeaVolumeTeuMonth?.message}
      >
        <Input id="imSeaVolumeTeuMonth" numeric inputMode="decimal" {...register('imSeaVolumeTeuMonth')} />
      </Field>

      <Field
        id="imAirVolumeKgMonth"
        label="Import air volume (KG / month)"
        error={errors.imAirVolumeKgMonth?.message}
      >
        <Input id="imAirVolumeKgMonth" numeric inputMode="decimal" {...register('imAirVolumeKgMonth')} />
      </Field>

      {/* Opening figures for the accounts ledger. */}
      <Field id="openingBalance" label="Opening balance" error={errors.openingBalance?.message}>
        <Input id="openingBalance" numeric inputMode="decimal" {...register('openingBalance')} />
      </Field>

      <Field id="openingCurrencyId" label="Currency" error={errors.openingCurrencyId?.message}>
        <Select id="openingCurrencyId" {...register('openingCurrencyId')}>
          <option value="">Select a currency</option>
          {currencies.map((currency) => (
            <option key={currency.id} value={currency.id}>
              {currency.name}
            </option>
          ))}
        </Select>
      </Field>

      {/* Asked for by the client on 2026-08-29. */}
      <Field
        id="salesmanId"
        label="Assigned salesman"
        hint="Who owns this account. Their inquiries already name a salesman; this says whose customer it is."
        error={errors.salesmanId?.message}
      >
        <Select id="salesmanId" {...register('salesmanId')}>
          <option value="">Unassigned</option>
          {salesmen.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="notes"
        label="Notes"
        hint="Anything about the account the rest of the form has no room for."
        error={errors.notes?.message}
        wide
      >
        <textarea
          id="notes"
          rows={4}
          {...register('notes')}
          className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
        />
      </Field>
    </FormLayout>
  );
}
