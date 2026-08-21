'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AGENT_TYPE_LABEL,
  AGENT_TYPES,
  type AgentDto,
  type AgentInput,
  agentInputSchema,
  type LookupOption,
} from '@ff/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Field, Input, Select } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout } from '@/components/ui/form-layout';
import { MultiSelect } from '@/components/ui/multi-select';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const ENDPOINT = '/api/tenant/crm/agents';

interface AgentOptions {
  expertAreas: LookupOption[];
  ports: LookupOption[];
  networks: LookupOption[];
}

/**
 * Agent form (CLAUDE.md §6).
 *
 * The three M:N fields use the §8 searchable multi-select. They post arrays of
 * ids; the route turns them into join rows.
 */
export function AgentForm({ agent }: { agent: AgentDto | null }) {
  const { authorizedRequest } = useSession();
  const router = useRouter();
  const [currencies, setCurrencies] = useState<LookupOption[]>([]);
  const [options, setOptions] = useState<AgentOptions>({
    expertAreas: [],
    ports: [],
    networks: [],
  });
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AgentInput>({
    resolver: zodResolver(agentInputSchema),
    defaultValues: {
      name: '',
      country: '',
      address: '',
      agentType: 'GENERAL',
      expertAreaIds: [],
      portCoverageIds: [],
      networkIds: [],
      weOwe: '',
      agentOwe: '',
      openingCurrencyId: '',
    },
  });

  useEffect(() => {
    void authorizedRequest<AgentOptions>(`${ENDPOINT}/options`)
      .then(setOptions)
      .catch(() => setOptions({ expertAreas: [], ports: [], networks: [] }));
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/currencies`)
      .then(setCurrencies)
      .catch(() => setCurrencies([]));
  }, [authorizedRequest]);

  useEffect(() => {
    if (agent === null) return;
    reset({
      name: agent.name,
      country: agent.country,
      address: agent.address ?? '',
      agentType: agent.agentType,
      expertAreaIds: agent.expertAreas.map((o) => o.id),
      portCoverageIds: agent.portCoverage.map((o) => o.id),
      networkIds: agent.networks.map((o) => o.id),
      weOwe: agent.weOwe ?? '',
      agentOwe: agent.agentOwe ?? '',
      openingCurrencyId: agent.openingCurrencyId ?? '',
    });
  }, [agent, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest<AgentDto>(
        agent === null ? ENDPOINT : `${ENDPOINT}/${agent.id}`,
        { method: agent === null ? 'POST' : 'PATCH', body: values },
      );
      toast.success(agent === null ? 'Agent added' : 'Saved');
      router.push('/crm/agent');
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
      onCancel={() => router.push('/crm/agent')}
      isPending={isSubmitting}
      submitLabel={agent === null ? 'Add agent' : 'Save changes'}
      error={formError ?? undefined}
      columns={2}
    >
      <Field id="name" label="Agent name" required error={errors.name?.message} wide>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>

      <Field id="country" label="Country" required error={errors.country?.message}>
        <CountrySelect id="country" aria-invalid={errors.country !== undefined} {...register('country')} />
      </Field>

      <Field id="agentType" label="Agent type" required error={errors.agentType?.message}>
        <Select id="agentType" {...register('agentType')}>
          {AGENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {AGENT_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="address" label="Address" error={errors.address?.message} wide>
        <Input id="address" {...register('address')} />
      </Field>

      <Field
        id="expertAreaIds"
        label="Expert areas"
        hint="What this agent handles well."
        error={errors.expertAreaIds?.message}
        wide
      >
        <Controller
          control={control}
          name="expertAreaIds"
          render={({ field }) => (
            <MultiSelect
              id="expertAreaIds"
              options={options.expertAreas}
              value={field.value ?? []}
              onChange={field.onChange}
              placeholder="Choose expert areas"
            />
          )}
        />
      </Field>

      <Field
        id="portCoverageIds"
        label="Port coverage"
        hint="The ports this agent can service."
        error={errors.portCoverageIds?.message}
        wide
      >
        <Controller
          control={control}
          name="portCoverageIds"
          render={({ field }) => (
            <MultiSelect
              id="portCoverageIds"
              options={options.ports}
              value={field.value ?? []}
              onChange={field.onChange}
              placeholder="Choose ports"
              searchPlaceholder="Type to filter ports"
            />
          )}
        />
      </Field>

      <Field
        id="networkIds"
        label="Network membership"
        hint="WCA, JCtrans, GLA, OLO."
        error={errors.networkIds?.message}
        wide
      >
        <Controller
          control={control}
          name="networkIds"
          render={({ field }) => (
            <MultiSelect
              id="networkIds"
              options={options.networks}
              value={field.value ?? []}
              onChange={field.onChange}
              placeholder="Choose networks"
            />
          )}
        />
      </Field>

      {/*
        Opening figures for the accounts ledger. Kept as two columns rather than
        one signed number because an agent can owe us on one account while we
        owe them on another, and netting the two loses which is which.
      */}
      <Field id="weOwe" label="We owe (Dr)" error={errors.weOwe?.message}>
        <Input id="weOwe" numeric inputMode="decimal" {...register('weOwe')} />
      </Field>

      <Field id="agentOwe" label="Agent owe (Cr)" error={errors.agentOwe?.message}>
        <Input id="agentOwe" numeric inputMode="decimal" {...register('agentOwe')} />
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
    </FormLayout>
  );
}
