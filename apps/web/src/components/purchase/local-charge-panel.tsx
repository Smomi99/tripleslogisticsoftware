'use client';

import {
  CHARGE_SIDES,
  type ChargeSide,
  isoCurrency,
  type LocalChargeInput,
  type LookupOption,
} from '@ff/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';

/**
 * §5.1: "POL Local Charges opens a small side panel to add cost-head lines;
 * the cell displays the total with a line count beneath it."
 *
 * Charges are held in the parent's draft state and saved with the rate, so a
 * half-entered rate never leaves rows behind. Each line carries its own
 * currency (§9 Q2) — local charges are commonly BDT while the freight is USD.
 */
export function LocalChargePanel({
  open,
  onOpenChange,
  charges,
  costHeads,
  containerSizes,
  currencies,
  defaultCurrencyId,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  charges: LocalChargeInput[];
  costHeads: LookupOption[];
  containerSizes: LookupOption[];
  currencies: LookupOption[];
  defaultCurrencyId: string;
  onChange: (next: LocalChargeInput[]) => void;
}) {
  const [costHeadId, setCostHeadId] = useState('');
  const [side, setSide] = useState<ChargeSide>('POL');
  const [containerSizeId, setContainerSizeId] = useState('');
  const [amount, setAmount] = useState('');
  const [currencyId, setCurrencyId] = useState(defaultCurrencyId);
  const [error, setError] = useState<string | null>(null);

  function add(): void {
    if (costHeadId === '') {
      setError('Choose a cost head.');
      return;
    }
    if (!/^\d{1,14}(\.\d{1,4})?$/.test(amount.trim())) {
      setError('Enter an amount, e.g. 45 or 45.50.');
      return;
    }
    // Container size is part of the key: THC on a 20ft and THC on a 40ft are
    // two legitimate lines, not a duplicate.
    if (
      charges.some(
        (c) =>
          c.costHeadId === costHeadId &&
          c.side === side &&
          (c.containerSizeId ?? '') === containerSizeId,
      )
    ) {
      setError(
        containerSizeId === ''
          ? 'That cost head is already on this side.'
          : 'That cost head is already on this side for that container size.',
      );
      return;
    }
    onChange([
      ...charges,
      {
        costHeadId,
        side,
        containerSizeId,
        amount: amount.trim(),
        currencyId: currencyId || defaultCurrencyId,
      },
    ]);
    setCostHeadId('');
    setContainerSizeId('');
    setAmount('');
    setError(null);
  }

  const nameOf = (id: string): string => costHeads.find((h) => h.id === id)?.name ?? id;
  /** The shared rule: the ISO code is the head of the currency name. */
  const codeOf = (id: string): string =>
    isoCurrency(currencies.find((c) => c.id === id)?.name ?? '');

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Local charges"
      description="Broken down by cost head. Each line carries its own currency."
    >
      <div className="flex flex-col gap-4">
        {charges.length === 0 ? (
          <p className="text-body text-steel">
            No local charges yet. Add the cost heads this rate covers.
          </p>
        ) : (
          <table className="w-full text-cell">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="label-manifest py-1.5">Cost head</th>
                <th className="label-manifest py-1.5">Side</th>
                <th className="label-manifest py-1.5">Container</th>
                <th className="label-manifest py-1.5 text-right">Amount</th>
                <th className="sr-only">Remove</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((charge, index) => (
                <tr
                  key={`${charge.costHeadId}-${charge.side}-${charge.containerSizeId ?? ''}`}
                  className="border-b border-line"
                >
                  <td className="py-1.5">{nameOf(charge.costHeadId)}</td>
                  <td className="py-1.5 text-steel">{charge.side}</td>
                  <td className="py-1.5 font-mono text-steel">
                    {charge.containerSizeId === undefined || charge.containerSizeId === ''
                      ? 'All'
                      : (containerSizes.find((t) => t.id === charge.containerSizeId)?.name ?? '—')}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {charge.amount} {codeOf(charge.currencyId)}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button
                      variant="destructive"
                      size="inline"
                      onClick={() => onChange(charges.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="grid grid-cols-1 gap-3 border-t border-line pt-4 md:grid-cols-2">
          {/* Blank means the charge applies whatever the equipment. */}
          <Field id="lc-container" label="Container size" hint="Leave blank if it applies to all.">
            <Select
              id="lc-container"
              value={containerSizeId}
              onChange={(e) => setContainerSizeId(e.target.value)}
            >
              <option value="">All container sizes</option>
              {containerSizes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="lc-cost-head" label="Cost head" required>
            <Select
              id="lc-cost-head"
              value={costHeadId}
              onChange={(e) => setCostHeadId(e.target.value)}
            >
              <option value="">Select a cost head</option>
              {costHeads.map((head) => (
                <option key={head.id} value={head.id}>
                  {head.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lc-side" label="Side" required>
            <Select
              id="lc-side"
              value={side}
              onChange={(e) => setSide(e.target.value as ChargeSide)}
            >
              {CHARGE_SIDES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lc-amount" label="Amount" required>
            <Input
              id="lc-amount"
              numeric
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </Field>
          <Field id="lc-currency" label="Currency" required>
            <Select
              id="lc-currency"
              value={currencyId}
              onChange={(e) => setCurrencyId(e.target.value)}
            >
              {currencies.map((currency) => (
                <option key={currency.id} value={currency.id}>
                  {currency.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 border-t border-line pt-4">
          <Button type="button" onClick={add}>
            Add charge
          </Button>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
