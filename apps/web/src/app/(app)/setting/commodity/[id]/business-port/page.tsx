'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  BUSINESS_PORT_ONE_SIDE,
  businessPortShape,
  type CommodityBusinessPortDto,
  type CommodityBusinessPortInput,
  commodityBusinessPortInputSchema,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ChildScreen } from '@/components/ui/child-screen';
import type { DataTableColumn } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

interface PortOption {
  id: string;
  name: string;
  portCode: string | null;
}

/**
 * Commodity Category → Business Port (client, 2026-09-12).
 *
 * The lanes a category is actually traded on. One rule shapes the whole set:
 * many loading ports into one discharge port, or one loading port out to many,
 * never both. The form enforces it by fixing whichever side is already
 * committed rather than by letting the choice be made and then refused — the
 * API still checks, because a disabled control is a courtesy.
 */
export default function CommodityBusinessPortPage() {
  const params = useParams<{ id: string }>();
  const sectorId = params.id;

  const columns: DataTableColumn<CommodityBusinessPortDto>[] = [
    {
      id: 'pol',
      header: 'POL',
      cell: (r) => (
        <span>
          {r.polCode !== null && (
            <span className="mr-1.5 font-mono text-cell tabular-nums text-steel">{r.polCode}</span>
          )}
          {r.polName}
        </span>
      ),
    },
    {
      id: 'pod',
      header: 'POD',
      cell: (r) => (
        <span>
          {r.podCode !== null && (
            <span className="mr-1.5 font-mono text-cell tabular-nums text-steel">{r.podCode}</span>
          )}
          {r.podName}
        </span>
      ),
    },
  ];

  return (
    <ChildScreen<CommodityBusinessPortDto>
      parentEndpoint={`/api/tenant/setting/commodity-categories/${sectorId}`}
      childEndpoint={`/api/tenant/setting/commodity-categories/${sectorId}/business-ports`}
      backHref={'/setting/commodity' as Route}
      parentLabel="Commodity category"
      title="Business Port"
      feature="SETTING.COMMODITY_CATEGORY"
      columns={columns}
      searchPlaceholder="Search ports"
      addLabel="+ Add business port"
      noun="business port"
      emptyTitle="No business ports yet"
      emptyDescription="Add the lane this category trades on — several loading ports into one discharge port, or one loading port out to several."
      describeRow={(r) => `${r.polName} → ${r.podName}`}
      deletable
      renderForm={({ row, onSubmit, onCancel }) => (
        <BusinessPortForm
          sectorId={sectorId}
          existing={row}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    />
  );
}

function BusinessPortForm({
  sectorId,
  existing,
  onSubmit,
  onCancel,
}: {
  sectorId: string;
  existing: CommodityBusinessPortDto | null;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [ports, setPorts] = useState<PortOption[]>([]);
  const [rows, setRows] = useState<CommodityBusinessPortDto[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  /*
    Both loaded when the form opens rather than held by the page, so the rule
    is judged against what is on file right now — including whatever the last
    save added.
  */
  useEffect(() => {
    void authorizedRequest<{ ports: PortOption[] }>(
      '/api/tenant/setting/commodity-categories/business-port-options',
    )
      .then((data) => setPorts(data.ports))
      .catch(() => setPorts([]));
    void authorizedRequest<CommodityBusinessPortDto[]>(
      `/api/tenant/setting/commodity-categories/${sectorId}/business-ports`,
    )
      .then(setRows)
      .catch(() => setRows([]));
  }, [authorizedRequest, sectorId]);

  // An edit is not judged against itself.
  const others = rows.filter((r) => r.id !== existing?.id);
  const { shape, fixedPolId, fixedPodId } = businessPortShape(others);
  const polLocked = shape === 'FANS_OUT' && fixedPolId !== null;
  const podLocked = shape === 'FANS_IN' && fixedPodId !== null;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CommodityBusinessPortInput>({
    resolver: zodResolver(commodityBusinessPortInputSchema),
    defaultValues: {
      polId: existing?.polId ?? '',
      podId: existing?.podId ?? '',
    },
  });

  useEffect(() => {
    reset({
      polId: existing?.polId ?? (polLocked ? fixedPolId ?? '' : ''),
      podId: existing?.podId ?? (podLocked ? fixedPodId ?? '' : ''),
    });
  }, [existing, fixedPolId, fixedPodId, polLocked, podLocked, reset]);

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

  const label = (p: PortOption): string =>
    p.portCode === null ? p.name : `${p.portCode} — ${p.name}`;

  /*
    A fixed side offers exactly the one port rather than a disabled control.
    Disabling a field registered with react-hook-form makes its value ambiguous
    on submit; narrowing the options keeps the value real and still leaves
    nothing else to choose.
  */
  const polChoices = polLocked ? ports.filter((p) => p.id === fixedPolId) : ports;
  const podChoices = podLocked ? ports.filter((p) => p.id === fixedPodId) : ports;

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={existing === null ? 'Add business port' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field
        id="polId"
        label="POL"
        required
        hint={
          polLocked
            ? 'Fixed: this category already runs out of one loading port to several discharge ports.'
            : undefined
        }
        error={errors.polId?.message}
      >
        <Select id="polId" {...register('polId')}>
          {!polLocked && <option value="">Choose a loading port</option>}
          {polChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="podId"
        label="POD"
        required
        hint={
          podLocked
            ? 'Fixed: this category already runs several loading ports into one discharge port.'
            : undefined
        }
        error={errors.podId?.message}
      >
        <Select id="podId" {...register('podId')}>
          {!podLocked && <option value="">Choose a discharge port</option>}
          {podChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p)}
            </option>
          ))}
        </Select>
      </Field>

      <p className="text-cell text-steel">{BUSINESS_PORT_ONE_SIDE}</p>
    </FormLayout>
  );
}
