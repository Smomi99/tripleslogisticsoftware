'use client';

import {
  MOVEMENT_TYPE_LABEL,
  MOVEMENT_TYPES,
  type MovementType,
  TARIFF_TYPE_LABEL,
  TARIFF_TYPES,
  type TariffDto,
  type TariffOptionsDto,
  tariffSaveSchema,
  type TariffType,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The Tarrif sheet as a form: the header (row 4) — POL, Movement Type, Tariff
 * Type, with Country following the POL — and the charge grid (rows 8 and 12).
 * More than eight fields, so a page rather than a modal (§8).
 */

interface LineDraft {
  key: number;
  costHeadId: string;
  containerSizeId: string;
  costUnitId: string;
  unitPrice: string;
  currencyId: string;
}

let nextKey = 1;
const blankLine = (): LineDraft => ({ key: nextKey++, costHeadId: '', containerSizeId: '', costUnitId: '', unitPrice: '', currencyId: '' });

export function TariffForm({ tariff }: { tariff: TariffDto | null }) {
  const { authorizedRequest } = useSession();
  const router = useRouter();
  const [options, setOptions] = useState<TariffOptionsDto | null>(null);
  const [polId, setPolId] = useState(tariff?.polId ?? '');
  const [movementType, setMovementType] = useState<MovementType | ''>(tariff?.movementType ?? '');
  const [tariffType, setTariffType] = useState<TariffType | ''>(tariff?.tariffType ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    tariff === null
      ? [blankLine()]
      : tariff.lines.map((l) => ({
          key: nextKey++,
          costHeadId: l.costHeadId,
          containerSizeId: l.containerSizeId ?? '',
          costUnitId: l.costUnitId,
          unitPrice: l.unitPrice.replace(/\.?0+$/, ''),
          currencyId: l.currencyId,
        })),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<TariffOptionsDto>('/api/tenant/purchase/tariffs/options')
      .then((data) => {
        if (live) setOptions(data);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the lists.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest]);

  const country = useMemo(() => options?.ports.find((p) => p.id === polId)?.country ?? tariff?.country ?? '', [options, polId, tariff]);

  function edit(key: number, patch: Partial<LineDraft>): void {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function save(): Promise<void> {
    const parsed = tariffSaveSchema.safeParse({
      polId,
      movementType,
      tariffType,
      lines: lines.map(({ key: _key, ...line }) => line),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const row = issue?.path[0] === 'lines' && typeof issue.path[1] === 'number' ? ` (charge ${issue.path[1] + 1})` : '';
      setError(`${issue?.message ?? 'Check the form.'}${row}`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const saved = await authorizedRequest<TariffDto>(
        tariff === null ? '/api/tenant/purchase/tariffs' : `/api/tenant/purchase/tariffs/${tariff.id}`,
        { method: tariff === null ? 'POST' : 'PUT', body: parsed.data },
      );
      toast.success(tariff === null ? `${saved.code} saved` : 'Saved');
      router.push('/purchase/tariff' as Route);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the tariff.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link href={'/purchase/tariff' as Route} className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline">
          ← Back to list
        </Link>
        <h1 className="text-page-title text-hull">{tariff === null ? 'Add tariff' : `Tariff ${tariff.code}`}</h1>
      </div>

      <div className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field id="tariff-country" label="Country" hint="From the POL.">
            <Input id="tariff-country" value={country} disabled />
          </Field>
          <Field id="tariff-pol" label="POL" required>
            <Select id="tariff-pol" value={polId} onChange={(e) => setPolId(e.target.value)} disabled={options === null}>
              <option value="">Choose the port</option>
              {options?.ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="tariff-movement" label="Movement Type" required>
            <Select id="tariff-movement" value={movementType} onChange={(e) => setMovementType(e.target.value as MovementType | '')}>
              <option value="">Choose</option>
              {MOVEMENT_TYPES.map((m) => (
                <option key={m} value={m}>
                  {MOVEMENT_TYPE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="tariff-type" label="Tariff Type" required>
            <Select id="tariff-type" value={tariffType} onChange={(e) => setTariffType(e.target.value as TariffType | '')}>
              <option value="">Choose</option>
              {TARIFF_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TARIFF_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper text-left">
                {['Cost Head', 'Container Size', 'Unit', 'Unit Price', 'Currency', ''].map((h) => (
                  <th key={h} className={`label-manifest px-2 py-2 ${h === 'Unit Price' ? 'text-right' : ''}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key} className="border-b border-line">
                  <td className="px-2 py-1.5">
                    <Select aria-label={`Cost head, charge ${index + 1}`} value={line.costHeadId} onChange={(e) => edit(line.key, { costHeadId: e.target.value })}>
                      <option value="">Choose</option>
                      {options?.costHeads.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Select aria-label={`Container size, charge ${index + 1}`} value={line.containerSizeId} onChange={(e) => edit(line.key, { containerSizeId: e.target.value })}>
                      <option value="">Any / none</option>
                      {options?.containerSizes.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Select aria-label={`Unit, charge ${index + 1}`} value={line.costUnitId} onChange={(e) => edit(line.key, { costUnitId: e.target.value })}>
                      <option value="">Choose</option>
                      {options?.costUnits.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      aria-label={`Unit price, charge ${index + 1}`}
                      numeric
                      inputMode="decimal"
                      className="text-right"
                      value={line.unitPrice}
                      onChange={(e) => edit(line.key, { unitPrice: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Select aria-label={`Currency, charge ${index + 1}`} value={line.currencyId} onChange={(e) => edit(line.key, { currencyId: e.target.value })}>
                      <option value="">Choose</option>
                      {options?.currencies.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {lines.length > 1 && (
                      <Button variant="destructive" size="inline" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2">
            <Button variant="text" size="inline" onClick={() => setLines((prev) => [...prev, blankLine()])}>
              + Add charge
            </Button>
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="mt-3 text-cell text-alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex gap-3">
          <Button onClick={() => void save()} disabled={pending || options === null}>
            {pending ? 'Saving…' : tariff === null ? 'Save tariff' : 'Save changes'}
          </Button>
          <Button variant="secondary" asChild>
            <Link href={'/purchase/tariff' as Route}>Cancel</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
