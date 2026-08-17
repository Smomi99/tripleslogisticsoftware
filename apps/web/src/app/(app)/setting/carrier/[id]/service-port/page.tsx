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
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Carrier → Service Port (CLAUDE.md §5 Table_Carrier_Service_Port).
 *
 * Since CR-001 §2 this is a plain list of the ports a carrier serves. Ranking
 * moved to Port Pair, where a rank has a POD to be cheap to; country is read
 * off the chosen port rather than typed.
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
      emptyDescription="Add the ports this carrier serves. Once they are here you can pair them into lanes and rank the carrier on each one."
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
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CarrierServicePortInput>({
    resolver: zodResolver(carrierServicePortInputSchema),
    defaultValues: { portId: '' },
  });

  useEffect(() => {
    reset({ portId: servicePort?.portId ?? ports[0]?.id ?? '' });
    setFormError(null);
  }, [servicePort, ports, reset]);

  // The server derives country from the port; this only shows what it will save.
  const selectedPort = ports.find((p) => p.id === watch('portId'));

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
        <Select
          id="portId"
          autoFocus
          aria-invalid={errors.portId !== undefined}
          {...register('portId')}
        >
          <option value="">Choose a port</option>
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.portCode} — {p.name}, {p.country}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="country" label="Country" hint="Taken from the port.">
        <Input
          id="country"
          disabled
          value={selectedPort?.country ?? servicePort?.country ?? '—'}
          readOnly
        />
      </Field>
    </FormLayout>
  );
}
