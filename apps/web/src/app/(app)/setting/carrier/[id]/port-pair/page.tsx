'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CarrierLanePortOption,
  type CarrierLanePorts,
  type CarrierPortPairDto,
  type CarrierPortPairInput,
  carrierPortPairInputSchema,
  portLabel,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ChildScreen } from '@/components/ui/child-screen';
import type { DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Carrier → Port Pair (CR-001 §5, client: Table_Carrier_Service_Port_pairing).
 *
 * The lane and this workspace's rank of the carrier on it. §5 draws the entry
 * fields as a row across the top of the wireframe; CLAUDE.md §8 still governs
 * screen patterns and puts five fields in a modal, so the field ORDER is the
 * client's and the container is the product's.
 */
export default function CarrierPortPairPage() {
  const params = useParams<{ id: string }>();
  const carrierId = params.id;
  const { authorizedRequest } = useSession();
  const [lanePorts, setLanePorts] = useState<CarrierLanePorts>({
    ports: [],
    excludedByType: 0,
    requiredPortType: null,
  });
  const ports: CarrierLanePortOption[] = lanePorts.ports;

  useEffect(() => {
    void authorizedRequest<CarrierLanePorts>(
      `/api/tenant/setting/carriers/${carrierId}/lane-ports`,
    )
      .then(setLanePorts)
      .catch(() => setLanePorts({ ports: [], excludedByType: 0, requiredPortType: null }));
  }, [authorizedRequest, carrierId]);

  const columns: DataTableColumn<CarrierPortPairDto>[] = [
    { id: 'pol', header: 'POL', sortable: true, cell: (r) => `${r.polCode} — ${r.polName}` },
    { id: 'pod', header: 'POD', cell: (r) => `${r.podCode} — ${r.podName}` },
    {
      id: 'lowPricePosition',
      header: 'Low pricewise position',
      align: 'right',
      numeric: true,
      sortable: true,
      // §5: an unranked lane shows an em dash in --steel, never 0. A blank rank
      // and a rank of zero are different claims about the carrier.
      cell: (r) =>
        r.lowPricePosition === null ? (
          <span className="text-steel">—</span>
        ) : (
          r.lowPricePosition
        ),
    },
    {
      id: 'servicePosition',
      header: 'Servicewise Position',
      align: 'right',
      numeric: true,
      sortable: true,
      cell: (r) =>
        r.servicePosition === null ? <span className="text-steel">—</span> : r.servicePosition,
    },
    { id: 'remarks', header: 'Remarks', cell: (r) => r.remarks ?? '—' },
  ];

  return (
    <ChildScreen<CarrierPortPairDto>
      parentEndpoint={`/api/tenant/setting/carriers/${carrierId}`}
      childEndpoint={`/api/tenant/setting/carriers/${carrierId}/port-pairs`}
      backHref={'/setting/carrier' as Route}
      parentLabel="Carrier"
      title="Port pairs"
      feature="SETTING.CARRIER_PORT_PAIR"
      columns={columns}
      defaultSort="lowPricePosition"
      searchPlaceholder="Search lanes"
      addLabel="+ Add port pair"
      noun="port pair"
      emptyTitle="No lanes paired yet"
      emptyDescription="Add a POL and POD pair to rank this carrier by price or service."
      describeRow={(r) => `${r.polCode} → ${r.podCode}`}
      conflictOpensRow={(error) => error.fields?.['existingId']?.[0] ?? null}
      renderForm={({ row, onSubmit, onCancel }) =>
        ports.length === 0 ? (
          <EmptyState {...noPortsMessage(lanePorts)} />
        ) : (
          <PortPairForm pair={row} ports={ports} onSubmit={onSubmit} onCancel={onCancel} />
        )
      }
    />
  );
}

/**
 * A lane needs two ports of the right kind, and there are two ways to have
 * none. Sending someone to the Service Port screen when the port is already
 * there is a dead end — reproduced with Maersk Line, whose only service port
 * was an airport.
 */
function noPortsMessage(lane: CarrierLanePorts): { title: string; description: string } {
  if (lane.excludedByType === 0) {
    return {
      title: 'No service ports to pair',
      description:
        'A lane can only use ports this carrier already serves. Add them on the Service Port screen first.',
    };
  }
  const flies = lane.requiredPortType === 'AIRPORT';
  const wanted = flies ? 'airports' : 'seaports';
  const count =
    lane.excludedByType === 1
      ? `its one service port is ${flies ? 'a seaport' : 'an airport'}`
      : `all ${lane.excludedByType} of its service ports are ${flies ? 'seaports' : 'airports'}`;
  return {
    title: 'No usable service ports',
    description: `This carrier's lanes run between ${wanted}, and ${count}. Add one on the Service Port screen, or correct what is there.`,
  };
}

function PortPairForm({
  pair,
  ports,
  onSubmit,
  onCancel,
}: {
  pair: CarrierPortPairDto | null;
  ports: CarrierLanePortOption[];
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CarrierPortPairInput>({
    resolver: zodResolver(carrierPortPairInputSchema),
    defaultValues: {
      polId: '',
      podId: '',
      lowPricePosition: '',
      servicePosition: '',
      remarks: '',
    },
  });

  useEffect(() => {
    reset({
      polId: pair?.polId ?? '',
      podId: pair?.podId ?? '',
      lowPricePosition: pair?.lowPricePosition ?? '',
      servicePosition: pair?.servicePosition ?? '',
      remarks: pair?.remarks ?? '',
    });
    setFormError(null);
  }, [pair, reset]);

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

  const portOptions = ports.map((p) => (
    <option key={p.id} value={p.id}>
      {portLabel(p)}, {p.country}
    </option>
  ));

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={pair === null ? 'Add port pair' : 'Save changes'}
      error={formError ?? undefined}
    >
      {/* Field order is the client's, from the §5 wireframe. */}
      <Field id="polId" label="POL" required error={errors.polId?.message}>
        <Select id="polId" autoFocus aria-invalid={errors.polId !== undefined} {...register('polId')}>
          <option value="">Choose a port of loading</option>
          {portOptions}
        </Select>
      </Field>

      <Field id="podId" label="POD" required error={errors.podId?.message}>
        <Select id="podId" aria-invalid={errors.podId !== undefined} {...register('podId')}>
          <option value="">Choose a port of discharge</option>
          {portOptions}
        </Select>
      </Field>

      <Field
        id="lowPricePosition"
        label="Low pricewise position"
        hint="1 is cheapest. Decimals are allowed — 1.5 slots in between ranks."
        error={errors.lowPricePosition?.message}
      >
        <Input
          id="lowPricePosition"
          numeric
          inputMode="decimal"
          className="text-right"
          {...register('lowPricePosition')}
        />
      </Field>

      <Field
        id="servicePosition"
        label="Servicewise Position"
        hint="1 is best on service quality."
        error={errors.servicePosition?.message}
      >
        <Input
          id="servicePosition"
          numeric
          inputMode="decimal"
          className="text-right"
          {...register('servicePosition')}
        />
      </Field>

      <Field id="remarks" label="Remark" error={errors.remarks?.message}>
        <Input id="remarks" {...register('remarks')} />
      </Field>
    </FormLayout>
  );
}
