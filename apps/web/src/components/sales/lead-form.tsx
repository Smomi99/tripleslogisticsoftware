'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  FREIGHT_CONTROL_LABEL,
  FREIGHT_CONTROLS,
  isClosedLead,
  LEAD_SHIPMENT_MODE_LABEL,
  LEAD_SHIPMENT_MODES,
  LEAD_VOLUME_UNIT,
  type LeadShipmentMode,
  previewForecast,
  SALES_LEAD_BUSINESS_TYPE_LABEL,
  SALES_LEAD_BUSINESS_TYPES,
  SALES_LEAD_FREQUENCIES,
  SALES_LEAD_FREQUENCY_LABEL,
  SALES_LEAD_PRIORITIES,
  SALES_LEAD_PRIORITY_LABEL,
  SALES_LEAD_STATUS_LABEL,
  SALES_LEAD_STATUSES,
  type SalesLeadDto,
  type SalesLeadFormOptions,
  type SalesLeadInput,
  salesLeadInputSchema,
} from '@ff/shared';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { type DefaultValues, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { LeadProgress } from '@/components/sales/lead-progress';
import { CountrySelect } from '@/components/ui/country-select';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const ENDPOINT = '/api/tenant/sales/leads';
const LIST: Route = '/sales/sales-lead' as Route;

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-3 py-2 text-base text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour sm:px-2.5 sm:py-1.5 sm:text-body aria-[invalid=true]:border-alert';

const today = (): string => new Date().toISOString().slice(0, 10);

const EMPTY_OPTIONS: SalesLeadFormOptions = {
  sources: [],
  owners: [],
  customers: [],
  agents: [],
  commodities: [],
  seaPorts: [],
  airPorts: [],
  containerSizes: [],
  carriers: [],
  defaultOwnerId: null,
  currency: null,
};

const usd = (value: number | null): string =>
  value === null
    ? '—'
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Blank selects start blank: an unchosen enum must fail validation, not default. */
function valuesOf(lead: SalesLeadDto | null): DefaultValues<SalesLeadInput> {
  return {
    leadDate: lead?.leadDate ?? today(),
    sourceId: lead?.sourceId ?? '',
    ownerId: lead?.ownerId ?? '',
    businessType: lead?.businessType ?? undefined,
    priority: lead?.priority ?? '',
    name: lead?.name ?? '',
    customerId: lead?.customerId ?? '',
    exporterContact: lead?.exporterContact ?? '',
    exporterMobile: lead?.exporterMobile ?? '',
    exporterEmail: lead?.exporterEmail ?? '',
    factoryLocation: lead?.factoryLocation ?? '',
    buyerName: lead?.buyerName ?? '',
    buyerCustomerId: lead?.buyerCustomerId ?? '',
    buyerCountry: lead?.buyerCountry ?? '',
    buyingHouse: lead?.buyingHouse ?? '',
    agentName: lead?.agentName ?? '',
    agentId: lead?.agentId ?? '',
    agentCountry: lead?.agentCountry ?? '',
    agentContact: lead?.agentContact ?? '',
    commodityItemId: lead?.commodityItemId ?? '',
    shipmentMode: lead?.shipmentMode ?? undefined,
    polId: lead?.polId ?? '',
    podId: lead?.podId ?? '',
    containerSizeId: lead?.containerSizeId ?? '',
    monthlyVolume: lead?.monthlyVolume ?? '',
    shipmentFrequency: lead?.shipmentFrequency ?? '',
    firstShipmentDate: lead?.firstShipmentDate ?? '',
    incumbentForwarder: lead?.incumbentForwarder ?? '',
    currentCarrierId: lead?.currentCarrierId ?? '',
    requirements: lead?.requirements ?? '',
    freightControl: lead?.freightControl ?? '',
    status: lead?.status ?? 'NEW',
    revenuePerUnit: lead?.revenuePerUnit ?? '',
    profitPerUnit: lead?.profitPerUnit ?? '',
    marketRatePerUnit: lead?.marketRatePerUnit ?? '',
    marketRateSource: lead?.marketRateSource ?? '',
    winProbability: lead?.winProbability?.toString() ?? '',
    nextFollowupDate: lead?.nextFollowupDate ?? '',
    outcomeReason: lead?.outcomeReason ?? '',
  };
}

/** A section heading inside the two-column grid (§1–§4 of the client's form). */
function Section({ number, title, children }: { number: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-2 pt-2 first:pt-0 md:col-span-2">
      <h2 className="text-section text-hull">
        <span className="mr-2 font-mono tabular-nums text-steel">{number}</span>
        {title}
      </h2>
      {children !== undefined && <p className="text-cell text-steel">{children}</p>}
    </div>
  );
}

/**
 * The FOB Sales Lead form (docs/SALES_LEAD_FOB.md §1–§4), for a new lead or an
 * existing one. Some forty fields, so §8 gives it a full page; shared by the
 * new and edit routes so the two cannot drift.
 *
 * Each of the three parties is a typed name with an optional link to the
 * master: picking a record fills the name and contact boxes, which stay
 * editable, and leaving it blank keeps a prospect a prospect.
 */
export function LeadForm({ lead }: { lead: SalesLeadDto | null }) {
  const { authorizedRequest } = useSession();
  const router = useRouter();
  const [options, setOptions] = useState<SalesLeadFormOptions>(EMPTY_OPTIONS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SalesLeadInput>({
    resolver: zodResolver(salesLeadInputSchema),
    defaultValues: valuesOf(lead),
  });

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<SalesLeadFormOptions>('/api/tenant/sales/lead-form-options')
      .then((data) => {
        if (cancelled) return;
        setOptions(data);
        // A new lead belongs to whoever is raising it, until they say otherwise.
        if (lead === null && data.defaultOwnerId !== null && getValues('ownerId') === '') {
          setValue('ownerId', data.defaultOwnerId);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof ApiError ? error.message : 'Could not load the form.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, getValues, lead, setValue]);

  // Blank until chosen, whatever the input type says about a submitted form.
  const shipmentMode = (watch('shipmentMode') as LeadShipmentMode | '' | undefined) ?? '';
  const status = watch('status');
  const ownerId = watch('ownerId');
  const containerSizeId = watch('containerSizeId');
  const unit = shipmentMode === '' ? LEAD_VOLUME_UNIT.SEA_FCL : LEAD_VOLUME_UNIT[shipmentMode];
  const currency = options.currency ?? 'USD';
  const ports = shipmentMode === 'AIR' ? options.airPorts : options.seaPorts;

  const forecast = previewForecast({
    shipmentMode,
    monthlyVolume: watch('monthlyVolume') ?? '',
    revenuePerUnit: watch('revenuePerUnit') ?? '',
    profitPerUnit: watch('profitPerUnit') ?? '',
    winProbability: watch('winProbability') ?? '',
    teuFactor: options.containerSizes.find((c) => c.id === containerSizeId)?.teuFactor ?? null,
  });

  const ownerDepartment = options.owners.find((o) => o.id === ownerId)?.department ?? null;

  /** Fills a box from the master only if the user has not typed in it. */
  function fillIfEmpty(field: keyof SalesLeadInput, value: string | null | undefined): void {
    if (value === null || value === undefined || value === '') return;
    if ((getValues(field) ?? '') === '') setValue(field, value, { shouldDirty: true });
  }

  function linkCustomer(id: string): void {
    setValue('customerId', id, { shouldDirty: true, shouldValidate: errors.customerId !== undefined });
    const customer = options.customers.find((c) => c.id === id);
    if (customer === undefined) return;
    // The record IS the exporter, so its name replaces whatever was typed.
    setValue('name', customer.name, { shouldDirty: true, shouldValidate: true });
    fillIfEmpty('factoryLocation', customer.address);
    fillIfEmpty('exporterContact', customer.contact?.name);
    fillIfEmpty('exporterMobile', customer.contact?.mobile);
    fillIfEmpty('exporterEmail', customer.contact?.email);
  }

  function linkBuyer(id: string): void {
    setValue('buyerCustomerId', id, { shouldDirty: true });
    const buyer = options.customers.find((c) => c.id === id);
    if (buyer === undefined) return;
    setValue('buyerName', buyer.name, { shouldDirty: true });
    setValue('buyerCountry', buyer.country, { shouldDirty: true });
  }

  function linkAgent(id: string): void {
    setValue('agentId', id, { shouldDirty: true });
    const agent = options.agents.find((a) => a.id === id);
    if (agent === undefined) return;
    setValue('agentName', agent.name, { shouldDirty: true });
    setValue('agentCountry', agent.country, { shouldDirty: true });
    fillIfEmpty(
      'agentContact',
      agent.contact === null
        ? null
        : [agent.contact.name, agent.contact.email].filter((v) => v !== null && v !== '').join(' · '),
    );
  }

  /**
   * Sea and air ports are different lists, and only FCL names equipment — so
   * changing the mode clears what no longer fits rather than sending it.
   */
  function changeMode(next: LeadShipmentMode | ''): void {
    const wasAir = shipmentMode === 'AIR';
    setValue('shipmentMode', next as SalesLeadInput['shipmentMode'], { shouldDirty: true, shouldValidate: true });
    if (wasAir !== (next === 'AIR')) {
      setValue('polId', '');
      setValue('podId', '');
    }
    if (next !== 'SEA_FCL') setValue('containerSizeId', '');
  }

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest<SalesLeadDto>(lead === null ? ENDPOINT : `${ENDPOINT}/${lead.id}`, {
        method: lead === null ? 'POST' : 'PATCH',
        body: values,
      });
      toast.success(lead === null ? 'Lead added' : 'Saved');
      router.push(LIST);
    } catch (error) {
      if (error instanceof ApiError && error.fields !== undefined) {
        for (const [field, messages] of Object.entries(error.fields)) {
          if (field in values) {
            setError(field as keyof SalesLeadInput, { message: messages[0] ?? 'Invalid value.' });
          }
        }
        setFormError('Some fields need attention — see the messages beside them.');
        return;
      }
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  const invalid = (field: keyof SalesLeadInput) => errors[field] !== undefined;

  return (
    <div className="flex flex-col gap-5">
      <LeadProgress status={status} />

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      <FormLayout
        onSubmit={submit}
        onCancel={() => router.push(LIST)}
        isPending={isSubmitting}
        submitLabel={lead === null ? 'Add lead' : 'Save changes'}
        error={formError ?? undefined}
        columns={2}
      >
        {/* ---------------------------------------------------------- §1 */}
        <Section number="01" title="Lead identification" />

        <Field id="code" label="Lead ID" hint={lead === null ? 'Assigned on save, e.g. FOB-2026-0001.' : undefined}>
          <Input id="code" numeric readOnly disabled value={lead?.code ?? 'Auto-generated'} />
        </Field>
        <Field id="leadDate" label="Lead date" required error={errors.leadDate?.message}>
          <Input id="leadDate" type="date" numeric aria-invalid={invalid('leadDate')} {...register('leadDate')} />
        </Field>
        <Field
          id="sourceId"
          label="Lead source"
          required
          error={errors.sourceId?.message}
          hint="The Inquiry Source list, under Setting."
        >
          <Select id="sourceId" aria-invalid={invalid('sourceId')} {...register('sourceId')}>
            <option value="">Choose a source</option>
            {options.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id="ownerId"
          label="Lead owner / Salesperson"
          required
          error={errors.ownerId?.message}
          hint={ownerDepartment === null ? undefined : `Department: ${ownerDepartment}`}
        >
          <Select id="ownerId" aria-invalid={invalid('ownerId')} {...register('ownerId')}>
            <option value="">Choose a salesperson</option>
            {options.owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="businessType" label="Business type" required error={errors.businessType?.message}>
          <Select id="businessType" aria-invalid={invalid('businessType')} {...register('businessType')}>
            <option value="">Choose a type</option>
            {SALES_LEAD_BUSINESS_TYPES.map((t) => (
              <option key={t} value={t}>
                {SALES_LEAD_BUSINESS_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="priority" label="Lead priority" error={errors.priority?.message}>
          <Select id="priority" {...register('priority')}>
            <option value="">—</option>
            {SALES_LEAD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {SALES_LEAD_PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>

        {/* ---------------------------------------------------------- §2 */}
        <Section number="02" title="Customer and commercial parties">
          The exporter, the overseas buyer and the nominated agent may be three different companies.
          Link each to its master record when there is one; leave the link blank for a prospect.
        </Section>

        <Field
          id="customerId"
          label="Exporter customer record"
          error={errors.customerId?.message}
          hint="Linking fills the boxes below. Required before the lead is marked Won."
        >
          <Select
            id="customerId"
            aria-invalid={invalid('customerId')}
            value={watch('customerId') ?? ''}
            onChange={(e) => linkCustomer(e.target.value)}
          >
            <option value="">Not a customer yet</option>
            {options.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="name" label="Exporter / Factory name" required error={errors.name?.message}>
          <Input id="name" autoFocus={lead === null} aria-invalid={invalid('name')} {...register('name')} />
        </Field>
        <Field id="exporterContact" label="Exporter contact person" error={errors.exporterContact?.message}>
          <Input id="exporterContact" {...register('exporterContact')} />
        </Field>
        <Field id="exporterMobile" label="Mobile / WhatsApp" error={errors.exporterMobile?.message}>
          <Input id="exporterMobile" type="tel" numeric {...register('exporterMobile')} />
        </Field>
        <Field id="exporterEmail" label="Exporter email" error={errors.exporterEmail?.message}>
          <Input id="exporterEmail" type="email" aria-invalid={invalid('exporterEmail')} {...register('exporterEmail')} />
        </Field>
        <Field id="factoryLocation" label="Factory location" error={errors.factoryLocation?.message}>
          <Input id="factoryLocation" {...register('factoryLocation')} />
        </Field>

        <Field id="buyerCustomerId" label="Buyer customer record" hint="Optional. Linking fills the name and country.">
          <Select id="buyerCustomerId" value={watch('buyerCustomerId') ?? ''} onChange={(e) => linkBuyer(e.target.value)}>
            <option value="">Not on file</option>
            {options.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="buyerName" label="Overseas buyer / Importer" error={errors.buyerName?.message}>
          <Input id="buyerName" {...register('buyerName')} />
        </Field>
        <Field id="buyerCountry" label="Buyer country" error={errors.buyerCountry?.message}>
          <CountrySelect id="buyerCountry" placeholder="—" {...register('buyerCountry')} />
        </Field>
        <Field id="buyingHouse" label="Buying house" error={errors.buyingHouse?.message}>
          <Input id="buyingHouse" {...register('buyingHouse')} />
        </Field>

        <Field id="agentId" label="Agent record" hint="Optional. Linking fills the name, country and contact.">
          <Select id="agentId" value={watch('agentId') ?? ''} onChange={(e) => linkAgent(e.target.value)}>
            <option value="">Not on file</option>
            {options.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="agentName" label="Overseas nominated agent / Forwarder" error={errors.agentName?.message}>
          <Input id="agentName" {...register('agentName')} />
        </Field>
        <Field id="agentCountry" label="Agent country" error={errors.agentCountry?.message}>
          <CountrySelect id="agentCountry" placeholder="—" {...register('agentCountry')} />
        </Field>
        <Field id="agentContact" label="Agent contact / Email" error={errors.agentContact?.message}>
          <Input id="agentContact" {...register('agentContact')} />
        </Field>

        {/* ---------------------------------------------------------- §3 */}
        <Section number="03" title="Shipment opportunity details" />

        <Field id="commodityItemId" label="Commodity / Product" required error={errors.commodityItemId?.message}>
          <Select id="commodityItemId" aria-invalid={invalid('commodityItemId')} {...register('commodityItemId')}>
            <option value="">Choose a commodity</option>
            {options.commodities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.hsCode === null ? c.name : `${c.name} — HS ${c.hsCode}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="shipmentMode" label="Shipment mode" required error={errors.shipmentMode?.message}>
          <Select
            id="shipmentMode"
            aria-invalid={invalid('shipmentMode')}
            value={shipmentMode}
            onChange={(e) => changeMode(e.target.value as LeadShipmentMode | '')}
          >
            <option value="">Choose a mode</option>
            {LEAD_SHIPMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {LEAD_SHIPMENT_MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="polId" label="Port of loading (POL)" required error={errors.polId?.message}>
          <Select id="polId" aria-invalid={invalid('polId')} {...register('polId')}>
            <option value="">{shipmentMode === '' ? 'Choose the mode first' : 'Choose a port'}</option>
            {ports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="podId" label="Port of discharge (POD)" required error={errors.podId?.message}>
          <Select id="podId" aria-invalid={invalid('podId')} {...register('podId')}>
            <option value="">{shipmentMode === '' ? 'Choose the mode first' : 'Choose a port'}</option>
            {ports.map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.name} (${p.country})`}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id="containerSizeId"
          label="Equipment type"
          error={errors.containerSizeId?.message}
          hint={shipmentMode === 'SEA_FCL' ? undefined : 'Sea FCL only.'}
        >
          <Select id="containerSizeId" disabled={shipmentMode !== 'SEA_FCL'} {...register('containerSizeId')}>
            <option value="">—</option>
            {options.containerSizes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id="monthlyVolume"
          label={`Estimated volume (${unit.plural} / month)`}
          error={errors.monthlyVolume?.message}
        >
          <Input
            id="monthlyVolume"
            numeric
            inputMode="decimal"
            className="text-right"
            aria-invalid={invalid('monthlyVolume')}
            {...register('monthlyVolume')}
          />
        </Field>
        <Field id="shipmentFrequency" label="Expected shipment frequency" error={errors.shipmentFrequency?.message}>
          <Select id="shipmentFrequency" {...register('shipmentFrequency')}>
            <option value="">—</option>
            {SALES_LEAD_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {SALES_LEAD_FREQUENCY_LABEL[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="firstShipmentDate" label="Expected first shipment" error={errors.firstShipmentDate?.message}>
          <Input id="firstShipmentDate" type="date" numeric {...register('firstShipmentDate')} />
        </Field>
        <Field id="incumbentForwarder" label="Incumbent forwarder" error={errors.incumbentForwarder?.message}>
          <Input id="incumbentForwarder" {...register('incumbentForwarder')} />
        </Field>
        <Field id="currentCarrierId" label="Current shipping line" error={errors.currentCarrierId?.message}>
          <Select id="currentCarrierId" {...register('currentCarrierId')}>
            <option value="">—</option>
            {options.carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="requirements" label="Shipment / Business requirements" error={errors.requirements?.message} wide>
          <textarea id="requirements" rows={3} className={TEXTAREA} {...register('requirements')} />
        </Field>

        {/* ---------------------------------------------------------- §4 */}
        <Section number="04" title="Revenue potential and sales qualification">
          Not every FOB lead is open to us: a factory may export 100 containers a month that the
          buyer&apos;s nominated forwarder controls entirely. Freight control says which this is.
        </Section>

        <Field id="freightControl" label="Freight control" error={errors.freightControl?.message}>
          <Select id="freightControl" {...register('freightControl')}>
            <option value="">—</option>
            {FREIGHT_CONTROLS.map((f) => (
              <option key={f} value={f}>
                {FREIGHT_CONTROL_LABEL[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="status" label="Lead status" required error={errors.status?.message}>
          <Select id="status" aria-invalid={invalid('status')} {...register('status')}>
            {SALES_LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SALES_LEAD_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id="revenuePerUnit"
          label={`Est. freight revenue / ${unit.singular} (${currency})`}
          error={errors.revenuePerUnit?.message}
        >
          <Input
            id="revenuePerUnit"
            numeric
            inputMode="decimal"
            className="text-right"
            aria-invalid={invalid('revenuePerUnit')}
            {...register('revenuePerUnit')}
          />
        </Field>
        <Field
          id="profitPerUnit"
          label={`Est. net profit / ${unit.singular} (${currency})`}
          error={errors.profitPerUnit?.message}
        >
          <Input
            id="profitPerUnit"
            numeric
            inputMode="decimal"
            className="text-right"
            aria-invalid={invalid('profitPerUnit')}
            {...register('profitPerUnit')}
          />
        </Field>
        <Field id="winProbability" label="Win probability (%)" error={errors.winProbability?.message}>
          <Input
            id="winProbability"
            numeric
            inputMode="numeric"
            className="text-right"
            aria-invalid={invalid('winProbability')}
            {...register('winProbability')}
          />
        </Field>
        <Field id="nextFollowupDate" label="Next follow-up date" error={errors.nextFollowupDate?.message}>
          <Input id="nextFollowupDate" type="date" numeric {...register('nextFollowupDate')} />
        </Field>
        <Field
          id="marketRatePerUnit"
          label={`Market rate heard / ${unit.singular} (${currency})`}
          error={errors.marketRatePerUnit?.message}
          hint="Competitor intelligence: what the incumbent is charging."
        >
          <Input
            id="marketRatePerUnit"
            numeric
            inputMode="decimal"
            className="text-right"
            aria-invalid={invalid('marketRatePerUnit')}
            {...register('marketRatePerUnit')}
          />
        </Field>
        <Field id="marketRateSource" label="Market rate source" error={errors.marketRateSource?.message}>
          <Input id="marketRateSource" {...register('marketRateSource')} />
        </Field>

        <section
          aria-label="Calculated opportunity value"
          className="rounded-card border border-line bg-module-soft p-3 md:col-span-2"
        >
          <p className="label-manifest">Calculated opportunity value</p>
          <dl className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Figure label={`Monthly freight revenue (${currency})`} value={usd(forecast.monthlyRevenue)} />
            <Figure label={`Monthly net profit (${currency})`} value={usd(forecast.monthlyProfit)} />
            <Figure label={`Weighted by probability (${currency})`} value={usd(forecast.weightedProfit)} />
            <Figure label="Monthly TEU" value={forecast.monthlyTeu === null ? '—' : forecast.monthlyTeu.toFixed(2)} />
          </dl>
          <p className="mt-2 text-cell text-steel">
            Estimates assume the volume is monthly and the profit is net profit per {unit.singular}. For mixed
            equipment, record each lane or equipment as its own lead.
          </p>
        </section>

        <Field
          id="outcomeReason"
          label="Reason for win / loss"
          required={isClosedLead(status)}
          error={errors.outcomeReason?.message}
          wide
        >
          <textarea
            id="outcomeReason"
            rows={2}
            className={TEXTAREA}
            aria-invalid={invalid('outcomeReason')}
            {...register('outcomeReason')}
          />
        </Field>
      </FormLayout>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-cell text-steel">{label}</dt>
      <dd className="font-mono text-section tabular-nums text-hull">{value}</dd>
    </div>
  );
}
