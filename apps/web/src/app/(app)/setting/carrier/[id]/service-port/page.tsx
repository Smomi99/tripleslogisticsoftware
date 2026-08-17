'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CarrierServicePortDto,
  type CarrierServicePortInput,
  carrierServicePortInputSchema,
  type PortDto,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ChildScreen } from '@/components/ui/child-screen';
import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Input, Select } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Carrier → Service Port (CLAUDE.md §5 Table_Carrier_Service_Port).
 *
 * low_price_position and service_position are this workspace's own ranking of
 * the carrier on that lane — 1 is best — which is why these rows are
 * tenant-owned even though the carrier itself is shared.
 */
export default function CarrierServicePortPage() {
  const params = useParams<{ id: string }>();
  const carrierId = params.id;
  const { authorizedList } = useSession();
  const [ports, setPorts] = useState<PortDto[]>([]);

  useEffect(() => {
    void authorizedList<PortDto[]>('/api/tenant/setting/ports?limit=100&isActive=true')
      .then((response) => setPorts(response.data))
      .catch(() => setPorts([]));
  }, [authorizedList]);

  const columns: DataTableColumn<CarrierServicePortDto>[] = [
    { id: 'port', header: 'Port', sortable: true, cell: (r) => r.portName },
    { id: 'portCode', header: 'Port Code', numeric: true, cell: (r) => r.portCode },
    { id: 'country', header: 'Country', cell: (r) => r.country ?? '—' },
    {
      id: 'lowPricePosition',
      header: 'Price Rank',
      align: 'right',
      numeric: true,
      cell: (r) => (r.lowPricePosition === null ? '—' : String(r.lowPricePosition)),
    },
    {
      id: 'servicePosition',
      header: 'Service Rank',
      align: 'right',
      numeric: true,
      cell: (r) => (r.servicePosition === null ? '—' : String(r.servicePosition)),
    },
  ];

  return (
    <ChildScreen<CarrierServicePortDto>
      parentEndpoint={`/api/tenant/setting/carriers/${carrierId}`}
      childEndpoint={`/api/tenant/setting/carriers/${carrierId}/service-ports`}
      backHref={'/setting/carrier' as Route}
      parentLabel="Carrier"
      title="Service ports"
      feature="SETTING.CARRIER"
      columns={columns}
      searchPlaceholder="Search ports"
      addLabel="+ Add service port"
      noun="service port"
      emptyTitle="No service ports yet"
      emptyDescription="Add the lanes this carrier serves, and rank it on price and service against the others."
      describeRow={(r) => r.portName}
      renderForm={({ row, onSubmit, onCancel }) => (
        <ServicePortForm servicePort={row} ports={ports} onSubmit={onSubmit} onCancel={onCancel} />
      )}
    />
  );
}

function ServicePortForm({
  servicePort,
  ports,
  onSubmit,
  onCancel,
}: {
  servicePort: CarrierServicePortDto | null;
  ports: PortDto[];
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CarrierServicePortInput>({
    resolver: zodResolver(carrierServicePortInputSchema),
    defaultValues: { portId: '', country: '', lowPricePosition: '', servicePosition: '' },
  });

  useEffect(() => {
    reset({
      portId: servicePort?.portId ?? ports[0]?.id ?? '',
      country: servicePort?.country ?? '',
      lowPricePosition:
        servicePort?.lowPricePosition === null || servicePort?.lowPricePosition === undefined
          ? ''
          : String(servicePort.lowPricePosition),
      servicePosition:
        servicePort?.servicePosition === null || servicePort?.servicePosition === undefined
          ? ''
          : String(servicePort.servicePosition),
    });
    setFormError(null);
  }, [servicePort, ports, reset]);

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
      submitLabel={servicePort === null ? 'Add service port' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="portId" label="Port" required error={errors.portId?.message}>
        <Select id="portId" autoFocus aria-invalid={errors.portId !== undefined} {...register('portId')}>
          <option value="">Choose a port</option>
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.portCode})
            </option>
          ))}
        </Select>
      </Field>

      <Field id="country" label="Country" error={errors.country?.message}>
        <CountrySelect id="country" placeholder="—" {...register('country')} />
      </Field>

      <Field
        id="lowPricePosition"
        label="Price rank"
        hint="Where this carrier sits on price for this lane. 1 is cheapest."
        error={errors.lowPricePosition?.message}
      >
        <Input id="lowPricePosition" numeric inputMode="numeric" {...register('lowPricePosition')} />
      </Field>

      <Field
        id="servicePosition"
        label="Service rank"
        hint="Where it sits on service quality. 1 is best."
        error={errors.servicePosition?.message}
      >
        <Input id="servicePosition" numeric inputMode="numeric" {...register('servicePosition')} />
      </Field>
    </FormLayout>
  );
}
