'use client';

import {
  type CostOptionsDto,
  type InvoiceLineSource,
  type QuotationCostLineSource,
  SUPPLIER_PARTY_LABEL,
  SUPPLIER_PARTY_TYPES,
  type SupplierPartyType,
} from '@ff/shared';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

import { amount, fmt, previewLine } from './format';

/**
 * Cost Details — the "Buying from Carrier / Agent / Vendor" blocks and the
 * charge grid they and the Selling Price share.
 *
 * Drawn on the debit invoice (the client's `Awaiting Debit Note` sheet, rows
 * 19–46) and, since 2026-10-18, on the quotation, whose costs the invoice then
 * starts from. One component, so the two cannot drift: what the client asked
 * for was "the same functionality".
 *
 * The figures shown while typing are a preview. Every save is recomputed by
 * the server — line amounts are GENERATED columns — and the form rebuilt from
 * what it stored.
 */

/** Where a cost row came from, across both documents. */
export type CostLineSource = InvoiceLineSource | QuotationCostLineSource;

export interface LineDraft {
  key: string;
  costHeadId: string;
  containerSizeId: string;
  costUnitId: string;
  quantity: string;
  unitPrice: string;
  source: CostLineSource;
}

export interface BlockDraft {
  key: string;
  /** A saved debit invoice block keeps its id, so its uploaded bill stays attached. */
  id: string | null;
  partyType: SupplierPartyType;
  partyId: string;
  /** Debit invoice only: the supplier's own invoice number. */
  supplierInvoiceNo: string;
  currencyId: string;
  conversionRate: string;
  lines: LineDraft[];
  fileName: string | null;
}

let keySeq = 0;
export const nextKey = (): string => `k${(keySeq += 1)}`;

export function lineFrom(l: {
  costHeadId: string;
  containerSizeId?: string | null | undefined;
  costUnitId?: string | null | undefined;
  quantity: string;
  unitPrice: string;
  source?: CostLineSource | undefined;
}): LineDraft {
  return {
    key: nextKey(),
    costHeadId: l.costHeadId,
    containerSizeId: l.containerSizeId ?? '',
    costUnitId: l.costUnitId ?? '',
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    source: l.source ?? 'MANUAL',
  };
}

export const blankLine = (line: LineDraft): boolean =>
  line.costHeadId === '' && line.quantity.trim() === '' && line.unitPrice.trim() === '';

export function emptyBlock(type: SupplierPartyType, options: CostOptionsDto): BlockDraft {
  const base = options.baseCurrencyId ?? options.currencies[0]?.id ?? '';
  return {
    key: nextKey(),
    id: null,
    partyType: type,
    partyId: '',
    supplierInvoiceNo: '',
    currencyId: base,
    conversionRate: '1',
    lines: [],
    fileName: null,
  };
}

/** One block of each type is always drawn, in the sheet's order (B21, B30, B38). */
export function withEveryType(blocks: BlockDraft[], options: CostOptionsDto): BlockDraft[] {
  const out = [...blocks];
  for (const type of SUPPLIER_PARTY_TYPES) {
    if (!out.some((b) => b.partyType === type)) out.push(emptyBlock(type, options));
  }
  return out.sort(
    (a, b) => SUPPLIER_PARTY_TYPES.indexOf(a.partyType) - SUPPLIER_PARTY_TYPES.indexOf(b.partyType),
  );
}

/** Each block's preview total, in its own currency and in base, and the grand total in base. */
export function costTotals(blocks: BlockDraft[]): { blocks: { total: number; base: number }[]; grandBase: number } {
  const totals = blocks.map((block) => {
    let total = 0;
    let base = 0;
    for (const line of block.lines) {
      const p = previewLine(line.quantity, line.unitPrice, block.conversionRate);
      total += p.amount ?? 0;
      base += p.base ?? 0;
    }
    return { total, base };
  });
  return { blocks: totals, grandBase: totals.reduce((sum, t) => sum + t.base, 0) };
}

/** A grid row as a save sends it. */
export function lineBody<S extends string>(l: LineDraft, source: S) {
  return {
    costHeadId: l.costHeadId,
    containerSizeId: l.containerSizeId === '' ? null : l.containerSizeId,
    costUnitId: l.costUnitId === '' ? null : l.costUnitId,
    quantity: l.quantity.trim(),
    unitPrice: l.unitPrice.trim(),
    source,
  };
}

const SOURCE_LABEL: Record<CostLineSource, { text: string; title: string }> = {
  QUOTATION: { text: 'from quotation', title: 'Pulled from the quotation' },
  LOAD_PLAN: { text: 'from load plan', title: 'The carrier cost the load plan allocated to this booking' },
  AUTO: { text: 'from price list', title: 'The buying price on the price list, or the agent’s own quote' },
  MANUAL: { text: 'typed', title: 'Typed by hand' },
};

// ===========================================================================
// The blocks
// ===========================================================================

export function CostBlocksEditor({
  blocks,
  onChange,
  options,
  editable,
  description,
  invoiceNo = false,
  footer,
}: {
  blocks: BlockDraft[];
  onChange: (next: BlockDraft[]) => void;
  options: CostOptionsDto;
  editable: boolean;
  description: string;
  /** The debit invoice's "Invoice no" box — a supplier's actual bill. */
  invoiceNo?: boolean;
  /** Anything a document adds under a block (the invoice's upload and payment status). */
  footer?: (block: BlockDraft) => ReactNode;
}) {
  const baseCode = options.baseCurrencyCode ?? '';
  const currency = (id: string) => options.currencies.find((c) => c.id === id);
  const isBase = (id: string) => id !== '' && id === options.baseCurrencyId;
  /** Changing a block's currency takes today's rate for it — 1 for the base (§3.4). */
  const rateFor = (id: string): string => (isBase(id) ? '1' : (currency(id)?.rate ?? ''));
  const totals = costTotals(blocks);
  const patchBlock = (key: string, patch: Partial<BlockDraft>) =>
    onChange(blocks.map((b) => (b.key === key ? { ...b, ...patch } : b)));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-section text-hull">Cost Details</h3>
        <p className="text-cell text-steel">{description}</p>
      </div>

      {blocks.map((block, index) => {
        const parties =
          block.partyType === 'CARRIER'
            ? options.carriers
            : block.partyType === 'AGENT'
              ? options.agents
              : options.vendors;
        const blockCode = currency(block.currencyId)?.code ?? '';
        const t = totals.blocks[index] ?? { total: 0, base: 0 };
        const label = SUPPLIER_PARTY_LABEL[block.partyType];
        return (
          <div key={block.key} className="rounded-manifest border border-line bg-surface shadow-manifest">
            <div className="grid gap-3 border-b border-line px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id={`party-${block.key}`} label={`Buying from ${label}`}>
                <Select
                  id={`party-${block.key}`}
                  value={block.partyId}
                  disabled={!editable}
                  onChange={(e) => patchBlock(block.key, { partyId: e.target.value })}
                >
                  <option value="">
                    {block.partyType === 'AGENT' ? 'Choose an agent' : `Choose a ${label.toLowerCase()}`}
                  </option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`cur-${block.key}`} label="Currency">
                <Select
                  id={`cur-${block.key}`}
                  value={block.currencyId}
                  disabled={!editable}
                  onChange={(e) =>
                    patchBlock(block.key, { currencyId: e.target.value, conversionRate: rateFor(e.target.value) })
                  }
                >
                  {options.currencies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`rate-${block.key}`} label={`Conversion rate (${baseCode || 'base'})`}>
                <Input
                  id={`rate-${block.key}`}
                  numeric
                  inputMode="decimal"
                  value={block.conversionRate}
                  disabled={!editable || isBase(block.currencyId)}
                  onChange={(e) => patchBlock(block.key, { conversionRate: e.target.value })}
                />
              </Field>
              {invoiceNo && (
                <Field id={`inv-${block.key}`} label="Invoice no">
                  <Input
                    id={`inv-${block.key}`}
                    value={block.supplierInvoiceNo}
                    disabled={!editable}
                    placeholder="As the supplier printed it"
                    onChange={(e) => patchBlock(block.key, { supplierInvoiceNo: e.target.value })}
                  />
                </Field>
              )}
            </div>

            <LineGrid
              lines={block.lines}
              priceLabel="Buying price"
              currencyCode={blockCode}
              rate={block.conversionRate}
              baseCode={baseCode}
              editable={editable}
              options={options}
              onChange={(next) => patchBlock(block.key, { lines: next })}
            />

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-4 py-2">
              <div className="flex flex-wrap items-center gap-3 text-cell">{footer?.(block)}</div>
              <p className="font-mono text-body tabular-nums text-hull">
                <span className="label-manifest mr-2">Total Cost =</span>
                {fmt(t.total)} {blockCode}
                {!isBase(block.currencyId) && (
                  <span className="text-steel">
                    {' '}
                    · {fmt(t.base)} {baseCode}
                  </span>
                )}
              </p>
            </div>
          </div>
        );
      })}

      <p className="text-right font-mono text-section tabular-nums text-hull">
        <span className="label-manifest mr-2">Grand total cost =</span>
        {fmt(totals.grandBase)} {baseCode}
      </p>
    </section>
  );
}

// ===========================================================================
// The grid
// ===========================================================================

/**
 * One grid, as the sheet draws all four of them: Cost head · Container size ·
 * unit · QTY · price · Currency · Total Amount · Conversion Rate · Total
 * Amount (base). The currency and rate are the grid's own (§3.3), shown on
 * every row the way the sheet shows them.
 */
export function LineGrid({
  lines,
  priceLabel,
  currencyCode,
  rate,
  baseCode,
  editable,
  options,
  onChange,
}: {
  lines: LineDraft[];
  priceLabel: string;
  currencyCode: string;
  rate: string;
  baseCode: string;
  editable: boolean;
  options: CostOptionsDto;
  onChange: (next: LineDraft[]) => void;
}) {
  const patch = (key: string, next: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...next } : l)));

  return (
    <div>
      {lines.length === 0 ? (
        <p className="px-4 py-4 text-cell text-steel">
          No lines yet.{editable ? ' Add one below.' : ''}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-250 border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Cost head</th>
                <th className="label-manifest px-3 py-2 text-left">Container size</th>
                <th className="label-manifest px-3 py-2 text-left">Unit</th>
                <th className="label-manifest px-3 py-2 text-right">Qty</th>
                <th className="label-manifest px-3 py-2 text-right">{priceLabel}</th>
                <th className="label-manifest px-3 py-2 text-left">Currency</th>
                <th className="label-manifest px-3 py-2 text-right">Total Amount</th>
                <th className="label-manifest px-3 py-2 text-right">Conversion Rate</th>
                <th className="label-manifest px-3 py-2 text-right">Total Amount ({baseCode || 'base'})</th>
                {editable && <th className="label-manifest px-3 py-2 text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const p = previewLine(line.quantity, line.unitPrice, rate);
                const source = SOURCE_LABEL[line.source];
                return (
                  <tr key={line.key} className="border-b border-line last:border-0">
                    <td className="px-3 py-1.5">
                      {editable ? (
                        <Select
                          aria-label="Cost head"
                          value={line.costHeadId}
                          className="min-w-44"
                          onChange={(e) => {
                            const head = options.costHeads.find((h) => h.id === e.target.value);
                            patch(line.key, { costHeadId: e.target.value, costUnitId: head?.unitId ?? '' });
                          }}
                        >
                          <option value="">Choose</option>
                          {options.costHeads.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-cell text-hull">
                          {options.costHeads.find((h) => h.id === line.costHeadId)?.label ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable ? (
                        <Select
                          aria-label="Container size"
                          value={line.containerSizeId}
                          className="min-w-28"
                          onChange={(e) => patch(line.key, { containerSizeId: e.target.value })}
                        >
                          <option value="">No size</option>
                          {options.containerSizes.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-cell text-steel">
                          {options.containerSizes.find((s) => s.id === line.containerSizeId)?.label ?? 'No size'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-cell text-steel">
                      {options.costUnits.find((u) => u.id === line.costUnitId)?.label ??
                        options.costHeads.find((h) => h.id === line.costHeadId)?.unitName ??
                        '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {editable ? (
                        <Input
                          aria-label="Quantity"
                          inputMode="decimal"
                          value={line.quantity}
                          className="w-20 text-right font-mono tabular-nums"
                          onChange={(e) => patch(line.key, { quantity: e.target.value })}
                        />
                      ) : (
                        <span className="font-mono text-cell tabular-nums">{line.quantity}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {editable ? (
                        <Input
                          aria-label={priceLabel}
                          inputMode="decimal"
                          value={line.unitPrice}
                          className="w-28 text-right font-mono tabular-nums"
                          onChange={(e) => patch(line.key, { unitPrice: e.target.value, source: 'MANUAL' })}
                        />
                      ) : (
                        <span className="font-mono text-cell tabular-nums">{amount(line.unitPrice)}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-cell text-steel">{currencyCode || '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                      {fmt(p.amount)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-steel">
                      {rate === '' ? '—' : rate}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                      {fmt(p.base)}
                    </td>
                    {editable && (
                      <td className="px-3 py-1.5 text-right">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className={line.source === 'MANUAL' ? 'text-cell text-signal' : 'text-cell text-steel'}
                            title={source.title}
                          >
                            {source.text}
                          </span>
                          <Button
                            variant="destructive"
                            size="inline"
                            onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                          >
                            Remove
                          </Button>
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <div className="border-t border-line px-4 py-2">
          <Button
            variant="text"
            size="inline"
            onClick={() =>
              onChange([
                ...lines,
                {
                  key: nextKey(),
                  costHeadId: '',
                  containerSizeId: '',
                  costUnitId: '',
                  quantity: '1',
                  unitPrice: '',
                  source: 'MANUAL',
                },
              ])
            }
          >
            + Add
          </Button>
        </div>
      )}
    </div>
  );
}
