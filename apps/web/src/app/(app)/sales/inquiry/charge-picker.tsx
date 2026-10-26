'use client';

import {
  type InquiryChargeOptionsDto,
  type InquiryExtraChargeInput,
  type InquiryRateChargeDto,
  inquiryExtraChargeSchema,
  type LocalChargeDto,
} from '@ff/shared';

import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';

export interface ExtraDraft {
  /** Stable React key; a saved extra's id is not enough, a new one has none. */
  key: string;
  id?: string;
  costHeadId: string;
  currencyId: string;
  amount: string;
}

/** What one container carries while it is being chosen. */
export interface ChargeDraft {
  localChargeIds: ReadonlySet<string>;
  extras: ExtraDraft[];
}

let extraKeys = 0;
const nextKey = (): string => `extra-${(extraKeys += 1)}`;

/** A saved 45.5000 is edited as 45.5. */
const trimAmount = (value: string): string => value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** Ticking a container: every charge the rate carries for it starts in. */
export function draftFromRate(available: LocalChargeDto[]): ChargeDraft {
  return { localChargeIds: new Set(available.map((c) => c.id)), extras: [] };
}

/** Reopening an attached container: exactly what it carries now. */
export function draftFromAttached(charges: InquiryRateChargeDto[]): ChargeDraft {
  return {
    localChargeIds: new Set(charges.flatMap((c) => (c.localChargeId === null ? [] : [c.localChargeId]))),
    extras: charges
      .filter((c) => c.localChargeId === null)
      .map((c) => ({
        key: nextKey(),
        id: c.id,
        costHeadId: c.costHeadId,
        currencyId: c.currencyId,
        amount: trimAmount(c.amount),
      })),
  };
}

/** The request body for a draft. */
export function draftToInput(draft: ChargeDraft): {
  localChargeIds: string[];
  extras: InquiryExtraChargeInput[];
} {
  return {
    localChargeIds: [...draft.localChargeIds],
    extras: draft.extras.map((e) => ({
      ...(e.id === undefined ? {} : { id: e.id }),
      costHeadId: e.costHeadId,
      currencyId: e.currencyId,
      amount: e.amount.trim(),
    })),
  };
}

/** Each extra's first problem, by key. Empty when the draft can be sent. */
export function validateDraft(draft: ChargeDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const extra of draft.extras) {
    const parsed = inquiryExtraChargeSchema.safeParse(extra);
    if (!parsed.success) errors[extra.key] = parsed.error.issues[0]?.message ?? 'Check this charge.';
  }
  return errors;
}

// Money is added as integer ten-thousandths, never as a float (§4 rule 6).
const SCALE = BigInt(10000);
function toUnits(value: string): bigint | null {
  const match = /^(\d{1,14})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (match === null) return null;
  return BigInt(match[1]!) * SCALE + BigInt((match[2] ?? '').padEnd(4, '0'));
}
function fromUnits(units: bigint): string {
  const digits = units.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/**
 * The charges a container carries (client, 2026-10-26): the purchase rate's
 * local charges for that box, ticked in or out, and any extras typed here.
 *
 * Controlled — the drawer owns the draft — so the same picker serves a box
 * being attached and one already attached being corrected.
 */
export function ChargePicker({
  idPrefix,
  available,
  carried = [],
  value,
  onChange,
  options,
  freight,
  errors,
  disabled,
}: {
  /** Keeps the checkbox ids unique when two boxes offer the same charge. */
  idPrefix: string;
  /** The rate's local charges for this box, as they stand now. */
  available: LocalChargeDto[];
  /** On an attached box: what it carries, at the amounts it was quoted at. */
  carried?: InquiryRateChargeDto[];
  value: ChargeDraft;
  onChange: (next: ChargeDraft) => void;
  options: InquiryChargeOptionsDto;
  /** The freight figure the charges sit on, for the running total. */
  freight: { currencyCode: string; price: string };
  errors: Record<string, string>;
  disabled: boolean;
}) {
  const quotedAt = new Map(
    carried.flatMap((c) => (c.localChargeId === null ? [] : [[c.localChargeId, c] as const])),
  );
  // A charge since taken off the rate still shows while the box carries it,
  // so unticking it is possible.
  const gone = carried.filter(
    (c) => c.localChargeId !== null && !available.some((a) => a.id === c.localChargeId),
  );
  const rows = [
    ...available.map((c) => {
      const kept = quotedAt.get(c.id);
      return {
        id: c.id,
        name: c.costHeadName,
        side: c.side as string | null,
        // Already carried: the figure it was quoted at, which is what counts.
        currencyCode: kept?.currencyCode ?? c.currencyCode,
        amount: kept?.amount ?? c.amount,
        note: c.costUnitName === null ? null : `per ${c.costUnitName}`,
      };
    }),
    ...gone.map((c) => ({
      id: c.localChargeId!,
      name: c.costHeadName,
      side: c.side as string | null,
      currencyCode: c.currencyCode,
      amount: c.amount,
      note: 'no longer on the rate',
    })),
  ];

  const defaultCurrencyId =
    options.defaultCurrencyId ??
    options.currencies.find((c) => c.code === freight.currencyCode)?.id ??
    '';
  const codeOf = (currencyId: string): string =>
    options.currencies.find((c) => c.id === currencyId)?.code ??
    carried.find((c) => c.currencyId === currencyId)?.currencyCode ??
    '';

  function toggle(id: string, on: boolean): void {
    const next = new Set(value.localChargeIds);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ ...value, localChargeIds: next });
  }
  function setExtra(key: string, patch: Partial<ExtraDraft>): void {
    onChange({ ...value, extras: value.extras.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
  }
  function addExtra(): void {
    const last = value.extras[value.extras.length - 1];
    onChange({
      ...value,
      extras: [
        ...value.extras,
        // Extras come in runs, usually in one currency: start on the last one's.
        { key: nextKey(), costHeadId: '', currencyId: last?.currencyId ?? defaultCurrencyId, amount: '' },
      ],
    });
  }

  // The running total, exact, while everything is in the freight's currency.
  // Anything else is converted by the server on save, at the rate in force.
  const included = [
    ...rows.filter((r) => value.localChargeIds.has(r.id)).map((r) => [r.currencyCode, r.amount]),
    ...value.extras.map((e) => [codeOf(e.currencyId), e.amount]),
  ] as [string, string][];
  let total = toUnits(freight.price);
  for (const [code, amount] of included) {
    const units = toUnits(amount);
    total = total === null || units === null || code !== freight.currencyCode ? null : total + units;
  }
  const converts = included.some(([code]) => code !== freight.currencyCode && code !== '');

  return (
    <div className="flex flex-col gap-1.5 rounded-manifest border border-line bg-paper px-3 py-2">
      {rows.length === 0 ? (
        <p className="text-cell text-steel">This rate carries no local charges for this container.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 text-cell">
              <input
                type="checkbox"
                id={`${idPrefix}-charge-${row.id}`}
                className="size-3.5 accent-harbour"
                disabled={disabled}
                checked={value.localChargeIds.has(row.id)}
                onChange={(event) => toggle(row.id, event.target.checked)}
              />
              <label htmlFor={`${idPrefix}-charge-${row.id}`} className="flex flex-1 items-center gap-2">
                <span className="text-hull">{row.name}</span>
                {row.side !== null && <span className="text-steel">{row.side}</span>}
                {row.note !== null && <span className="text-steel">{row.note}</span>}
              </label>
              <span className="font-mono text-hull">
                {row.currencyCode} {row.amount}
              </span>
            </li>
          ))}
        </ul>
      )}

      {value.extras.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_7rem_3.5rem] gap-2">
            <span className="label-manifest">
              Extra charge<span className="ml-1 text-alert" aria-hidden="true">*</span>
            </span>
            <span className="label-manifest">
              Currency<span className="ml-1 text-alert" aria-hidden="true">*</span>
            </span>
            <span className="label-manifest text-right">
              Amount<span className="ml-1 text-alert" aria-hidden="true">*</span>
            </span>
            <span className="sr-only">Actions</span>
          </div>
          {value.extras.map((extra, index) => {
            const error = errors[extra.key];
            const unit = options.costHeads.find((h) => h.id === extra.costHeadId)?.unitName;
            return (
              <div key={extra.key} className="flex flex-col gap-0.5">
                <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_7rem_3.5rem] items-center gap-2">
                  <Select
                    aria-label={`Extra charge, line ${index + 1}`}
                    aria-invalid={error !== undefined}
                    value={extra.costHeadId}
                    disabled={disabled}
                    onChange={(e) => setExtra(extra.key, { costHeadId: e.target.value })}
                  >
                    <option value="">Select a cost head</option>
                    {options.costHeads.map((head) => (
                      <option key={head.id} value={head.id}>
                        {head.label}
                      </option>
                    ))}
                    {/* A head switched off since keeps showing on the extra that has it. */}
                    {extra.costHeadId !== '' &&
                      !options.costHeads.some((h) => h.id === extra.costHeadId) && (
                        <option value={extra.costHeadId}>
                          {carried.find((c) => c.costHeadId === extra.costHeadId)?.costHeadName ??
                            'Inactive cost head'}
                        </option>
                      )}
                  </Select>
                  <Select
                    aria-label={`Currency, line ${index + 1}`}
                    value={extra.currencyId}
                    disabled={disabled}
                    onChange={(e) => setExtra(extra.key, { currencyId: e.target.value })}
                  >
                    <option value="">—</option>
                    {options.currencies.map((currency) => (
                      <option key={currency.id} value={currency.id}>
                        {currency.code}
                      </option>
                    ))}
                    {extra.currencyId !== '' &&
                      !options.currencies.some((c) => c.id === extra.currencyId) && (
                        <option value={extra.currencyId}>{codeOf(extra.currencyId) || 'Inactive'}</option>
                      )}
                  </Select>
                  <Input
                    aria-label={`Amount, line ${index + 1}`}
                    aria-invalid={error !== undefined}
                    numeric
                    inputMode="decimal"
                    className="text-right"
                    value={extra.amount}
                    disabled={disabled}
                    onChange={(e) => setExtra(extra.key, { amount: e.target.value })}
                  />
                  <Button
                    variant="destructive"
                    size="inline"
                    disabled={disabled}
                    onClick={() =>
                      onChange({ ...value, extras: value.extras.filter((e) => e.key !== extra.key) })
                    }
                  >
                    Remove
                  </Button>
                </div>
                {error !== undefined ? (
                  <p role="alert" className="text-cell text-alert">
                    {error}
                  </p>
                ) : (
                  unit !== undefined && <p className="text-cell text-steel">per {unit}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line pt-1.5">
        <Button variant="text" size="inline" disabled={disabled} onClick={addExtra}>
          Add charge
        </Button>
        <span className="text-cell text-steel">
          Quoted{' '}
          {total !== null ? (
            <span className="font-mono text-hull">
              {freight.currencyCode} {fromUnits(total)}
            </span>
          ) : converts ? (
            'with charges converted to ' + freight.currencyCode + ' on save'
          ) : (
            '— check the amounts'
          )}
        </span>
      </div>
    </div>
  );
}
