import type { AgentQuoteLineDto, AgentQuoteOptionDto, AgentQuoteTotalDto } from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { isoCurrency } from './currency-label';

/**
 * Reading the offers on an agent quote.
 *
 * Shared by the two screens that show them: the agent's own form, and the
 * forwarder's drawer on the inquiry. The same rows have to read identically to
 * both sides — if the totals a supplier sees ever differ from the totals the
 * buyer sees, the argument that follows is not one anybody wins.
 */

/**
 * One charge row, with the label for every id on it.
 *
 * The four lookups joined here — carrier, cost head, container size, cost
 * unit — are the tables this feature opened to agents. Nothing priced is among
 * them.
 */
export const LINE_SELECT = {
  id: true,
  position: true,
  carrierId: true,
  costHeadId: true,
  containerSizeId: true,
  costUnitId: true,
  quantity: true,
  unitPrice: true,
  currencyId: true,
  totalAmount: true,
  remarks: true,
  carrier: { select: { name: true } },
  costHead: { select: { name: true } },
  containerSize: { select: { name: true } },
  costUnit: { select: { name: true } },
  currency: { select: { currency: true } },
} as const;

export const OPTION_SELECT = {
  id: true,
  position: true,
  carrierId: true,
  transitDays: true,
  via: true,
  podFreeDays: true,
  validUntil: true,
  etd: true,
  eta: true,
  remarks: true,
  carrier: { select: { name: true } },
  lines: {
    where: { deletedAt: null },
    orderBy: { position: 'asc' },
    select: LINE_SELECT,
  },
} as const;

/** Live options, newest generation only, in the agent's own order. */
export const OPTIONS_INCLUDE = {
  where: { deletedAt: null },
  orderBy: { position: 'asc' },
  select: OPTION_SELECT,
} as const;

export interface LineRow {
  id: bigint;
  position: number;
  carrierId: bigint | null;
  costHeadId: bigint;
  containerSizeId: bigint | null;
  costUnitId: bigint | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  currencyId: bigint;
  totalAmount: Prisma.Decimal | null;
  remarks: string | null;
  carrier: { name: string } | null;
  costHead: { name: string } | null;
  containerSize: { name: string } | null;
  costUnit: { name: string } | null;
  currency: { currency: string } | null;
}

export interface OptionRow {
  id: bigint;
  position: number;
  carrierId: bigint | null;
  transitDays: number | null;
  via: string | null;
  podFreeDays: number | null;
  validUntil: Date | null;
  etd: Date | null;
  eta: Date | null;
  remarks: string | null;
  carrier: { name: string } | null;
  lines: LineRow[];
}

export const day = (d: Date | null): string | null => d?.toISOString().slice(0, 10) ?? null;

export function lineToDto(row: LineRow): AgentQuoteLineDto {
  return {
    id: row.id.toString(),
    position: row.position,
    carrierId: row.carrierId?.toString() ?? null,
    carrierName: row.carrier?.name ?? null,
    costHeadId: row.costHeadId.toString(),
    costHeadName: row.costHead?.name ?? '',
    containerSizeId: row.containerSizeId?.toString() ?? null,
    containerSizeName: row.containerSize?.name ?? null,
    costUnitId: row.costUnitId?.toString() ?? null,
    costUnitName: row.costUnit?.name ?? null,
    quantity: row.quantity.toString(),
    unitPrice: row.unitPrice.toString(),
    currencyId: row.currencyId.toString(),
    currencyCode: row.currency === null ? null : isoCurrency(row.currency.currency),
    // Read back from the generated column, so what either side is shown is the
    // number the database will hold us to.
    totalAmount: row.totalAmount?.toString() ?? '0',
    remarks: row.remarks,
  };
}

/**
 * One subtotal per currency the option uses.
 *
 * Not a single figure, because ocean freight in USD beside local charges in BDT
 * is the ordinary case and adding them would invent a rate nobody quoted. The
 * forwarder converts when they build their own quotation, using their own
 * rate — which is exactly where that decision belongs.
 */
export function totalsFor(lines: LineRow[]): AgentQuoteTotalDto[] {
  const byCurrency = new Map<string, { code: string | null; amount: Prisma.Decimal }>();
  for (const line of lines) {
    const key = line.currencyId.toString();
    const running = byCurrency.get(key);
    const amount = line.totalAmount ?? new Prisma.Decimal(0);
    byCurrency.set(key, {
      code: running?.code ?? (line.currency === null ? null : isoCurrency(line.currency.currency)),
      amount: running === undefined ? amount : running.amount.add(amount),
    });
  }
  return [...byCurrency.entries()].map(([currencyId, value]) => ({
    currencyId,
    currencyCode: value.code,
    amount: value.amount.toString(),
  }));
}

export function optionToDto(row: OptionRow): AgentQuoteOptionDto {
  return {
    id: row.id.toString(),
    position: row.position,
    carrierId: row.carrierId?.toString() ?? null,
    carrierName: row.carrier?.name ?? null,
    transitDays: row.transitDays,
    via: row.via,
    podFreeDays: row.podFreeDays,
    validUntil: day(row.validUntil),
    etd: day(row.etd),
    eta: day(row.eta),
    remarks: row.remarks,
    lines: row.lines.map(lineToDto),
    totals: totalsFor(row.lines),
  };
}
