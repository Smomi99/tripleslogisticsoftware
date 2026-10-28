'use client';

import {
  TRADE_LANE_DIRECTION_LABEL,
  TRADE_LANE_DIRECTIONS,
  TRADE_LANE_SIDES,
  type TradeLaneDirection,
  type TradeLaneDto,
  type TradeLaneOptionsDto,
  tradeLaneSaveSchema,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { MultiSelect } from '@/components/ui/multi-select';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

type Errors = Partial<Record<'name' | 'movementType' | 'portId' | 'portIds', string>>;

/**
 * The sheet's lane row (5–6 outbound, 26–27 inbound): the single port, the
 * many ports, and Trade lane name, then `add`. Four fields, so a modal (§8).
 */
export function TradeLaneForm({
  lane,
  direction,
  onClose,
  onSaved,
}: {
  lane: TradeLaneDto | null;
  direction: TradeLaneDirection;
  onClose: () => void;
  onSaved: (saved: TradeLaneDto) => void;
}) {
  const { authorizedRequest } = useSession();
  const [options, setOptions] = useState<TradeLaneOptionsDto | null>(null);
  const [name, setName] = useState(lane?.name ?? '');
  const [movementType, setMovementType] = useState<TradeLaneDirection>(lane?.movementType ?? direction);
  const [portId, setPortId] = useState(lane?.port.id ?? '');
  const [portIds, setPortIds] = useState<string[]>(lane?.ports.map((p) => p.id) ?? []);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    authorizedRequest<TradeLaneOptionsDto>('/api/tenant/sales/business-matrix/options')
      .then((data) => {
        if (live) setOptions(data);
      })
      .catch(() => {
        if (live) setFormError('Could not load the ports. Close this and try again.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest]);

  const sides = TRADE_LANE_SIDES[movementType];
  const singleType = options?.ports.find((p) => p.id === portId)?.type;
  // A lane is all seaports or all airports (§6 Q3), and a port is on one side only.
  const manyOptions = useMemo(
    () => (options?.ports ?? []).filter((p) => p.id !== portId && (singleType === undefined || p.type === singleType)),
    [options, portId, singleType],
  );

  async function submit(): Promise<void> {
    const input = { name, movementType, portId, portIds };
    const parsed = tradeLaneSaveSchema.safeParse(input);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Errors | undefined;
        if (key !== undefined && next[key] === undefined) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      const saved = await authorizedRequest<TradeLaneDto>(
        lane === null ? '/api/tenant/sales/business-matrix' : `/api/tenant/sales/business-matrix/${lane.id}`,
        { method: lane === null ? 'POST' : 'PUT', body: parsed.data },
      );
      toast.success(lane === null ? `Trade lane ${saved.name} added` : 'Saved');
      onSaved(saved);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not save the trade lane. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={lane === null ? 'Add trade lane' : `Edit trade lane — ${lane.code}`}
      description={
        movementType === 'OUTBOUND'
          ? 'One POL and the PODs it serves. Each POD is a row of the matrix.'
          : 'The POLs that feed one POD. Each POL is a row of the matrix.'
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="lane-direction" label="Section" required error={errors.movementType}>
          <Select
            id="lane-direction"
            value={movementType}
            onChange={(e) => {
              setMovementType(e.target.value as TradeLaneDirection);
              // The single side changes meaning with the direction, so start the ports again.
              setPortId('');
              setPortIds([]);
            }}
          >
            {TRADE_LANE_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {TRADE_LANE_DIRECTION_LABEL[d]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="lane-name" label="Trade lane name" required error={errors.name}>
          <Input id="lane-name" value={name} maxLength={200} placeholder="e.g. EU Base port" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          id="lane-port"
          label={sides.single === 'POL' ? 'POL (single)' : 'POD (single)'}
          required
          error={errors.portId}
        >
          <Select
            id="lane-port"
            value={portId}
            disabled={options === null}
            onChange={(e) => {
              const next = e.target.value;
              const type = options?.ports.find((p) => p.id === next)?.type;
              setPortId(next);
              setPortIds((prev) => prev.filter((id) => id !== next && options?.ports.find((p) => p.id === id)?.type === type));
            }}
          >
            <option value="">{options === null ? 'Loading ports…' : `Choose the ${sides.single}`}</option>
            {(options?.ports ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id="lane-ports"
          label={sides.many === 'POD' ? 'PODs (multiple)' : 'POLs (multiple)'}
          required
          error={errors.portIds}
          hint={portId === '' ? `Choose the ${sides.single} first.` : 'The matrix lists them in the order you choose them.'}
        >
          <MultiSelect
            id="lane-ports"
            options={manyOptions}
            value={portIds}
            onChange={setPortIds}
            placeholder={`Choose the ${sides.many}s`}
            searchPlaceholder="Type a port name or code"
            invalid={errors.portIds !== undefined}
          />
        </Field>
        {formError !== null && (
          <p role="alert" className="text-cell text-alert">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || options === null}>
            {pending ? 'Saving…' : lane === null ? 'Add trade lane' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
