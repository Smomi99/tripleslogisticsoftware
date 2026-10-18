import {
  type QuotationCostData,
  type QuotationCostDraftDto,
  type QuotationCostDto,
  SUPPLIER_PARTY_LABEL,
  type SupplierPartyType,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { isoCurrency } from './currency-label';
import { type BaseCurrency, resolveRate } from './currency-rate';
import { currencyOf, dec, isoOf, money, partyIsVisible, rateFor, resolveLines, toBase } from './debit-invoice';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * The quotation's Cost Details (client, 2026-10-18) — the debit invoice's
 * "Buying from Carrier / Agent / Vendor" blocks, on a quotation.
 *
 * What the forwarder expects to pay for the job it is quoting. The debit
 * invoice made from the booking starts its own cost blocks from these
 * (lib/debit-invoice.ts, prefillFor). Never printed, never sent: nothing in
 * quotation-pdf.ts or the send route reads these tables.
 */

const ZERO = new Prisma.Decimal(0);

export const QUOTATION_COST_SELECT = {
  id: true,
  partyType: true,
  carrierId: true,
  agentId: true,
  vendorId: true,
  currencyId: true,
  currencyCode: true,
  conversionRate: true,
  totalAmount: true,
  totalAmountBase: true,
  carrier: { select: { name: true } },
  agent: { select: { name: true } },
  vendor: { select: { name: true } },
  lines: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      source: true,
      costHeadId: true,
      costHeadName: true,
      containerSizeId: true,
      containerSizeName: true,
      costUnitId: true,
      unitName: true,
      quantity: true,
      unitPrice: true,
      amount: true,
    },
  },
} satisfies Prisma.QuotationCostSelect;

export type QuotationCostRow = Prisma.QuotationCostGetPayload<{ select: typeof QUOTATION_COST_SELECT }>;

export function loadQuotationCosts(db: TenantDb, quotationId: bigint): Promise<QuotationCostRow[]> {
  return db.quotationCost.findMany({
    where: { quotationId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: QUOTATION_COST_SELECT,
  });
}

export function partyOfCost(row: Pick<QuotationCostRow, 'partyType' | 'carrierId' | 'agentId' | 'vendorId' | 'carrier' | 'agent' | 'vendor'>): {
  id: bigint | null;
  name: string;
} {
  if (row.partyType === 'CARRIER') return { id: row.carrierId, name: row.carrier?.name ?? '—' };
  if (row.partyType === 'AGENT') return { id: row.agentId, name: row.agent?.name ?? '—' };
  return { id: row.vendorId, name: row.vendor?.name ?? '—' };
}

export function quotationCostDto(row: QuotationCostRow): QuotationCostDto {
  const party = partyOfCost(row);
  return {
    id: row.id.toString(),
    partyType: row.partyType,
    partyId: party.id?.toString() ?? '',
    partyName: party.name,
    currencyId: row.currencyId.toString(),
    currencyCode: row.currencyCode,
    conversionRate: row.conversionRate.toString(),
    totalAmount: money(row.totalAmount),
    totalAmountBase: money(row.totalAmountBase),
    lines: row.lines.map((l) => {
      const amount = dec(l.amount);
      return {
        id: l.id.toString(),
        source: l.source,
        costHeadId: l.costHeadId.toString(),
        costHeadName: l.costHeadName,
        containerSizeId: l.containerSizeId?.toString() ?? null,
        containerSizeName: l.containerSizeName,
        costUnitId: l.costUnitId?.toString() ?? null,
        unitName: l.unitName,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        amount: money(amount),
        amountBase: money(toBase(amount, row.conversionRate)),
      };
    }),
  };
}

// ---------------------------------------------------------------- writes

/** A block's "Total Cost =", read back from the GENERATED line amounts. */
async function retotalQuotationCost(db: TenantDb, costId: bigint, rate: Prisma.Decimal): Promise<void> {
  const lines = await db.quotationCostLine.findMany({
    where: { quotationCostId: costId, deletedAt: null },
    select: { amount: true },
  });
  await db.quotationCost.update({
    where: { id: costId },
    data: {
      totalAmount: lines.reduce((sum, l) => sum.plus(dec(l.amount)), ZERO),
      totalAmountBase: lines.reduce((sum, l) => sum.plus(toBase(dec(l.amount), rate)), ZERO),
    },
  });
}

/**
 * Replace the cost side. Every block and line before it is soft-deleted, so
 * the audit trail keeps each version; an empty block naming nobody is simply
 * not written. Nothing pays against a quotation's costs, so — unlike the debit
 * invoice's — there is no block that has to keep its identity.
 */
export async function writeQuotationCosts(
  db: TenantDb,
  args: { tenantId: bigint; userId: bigint; quotationId: bigint; costs: QuotationCostData[]; base: BaseCurrency },
): Promise<void> {
  const { tenantId, userId, quotationId, costs, base } = args;
  const gone = { deletedAt: new Date(), isActive: false, updatedBy: userId };

  const old = (await db.quotationCost.findMany({ where: { quotationId, deletedAt: null }, select: { id: true } })).map(
    (c) => c.id,
  );
  if (old.length > 0) {
    await db.quotationCostLine.updateMany({ where: { quotationCostId: { in: old }, deletedAt: null }, data: gone });
    await db.quotationCost.updateMany({ where: { id: { in: old } }, data: gone });
  }

  for (const [index, block] of costs.entries()) {
    if (block.partyId === null && block.lines.length === 0) continue;
    const label = SUPPLIER_PARTY_LABEL[block.partyType].toLowerCase();
    if (block.partyId === null) throw HttpError.badRequest(`Choose the ${label} this cost is owed to.`);

    const partyId = BigInt(block.partyId);
    if (!(await partyIsVisible(db, block.partyType, partyId))) {
      throw HttpError.badRequest(`That ${label} is not available.`);
    }

    const currencyId = BigInt(block.currencyId);
    const rate = rateFor(currencyId, block.conversionRate, base);
    const lines = await resolveLines(db, block.lines);

    const made = await db.quotationCost.create({
      data: {
        tenantId,
        quotationId,
        sortOrder: index,
        partyType: block.partyType,
        carrierId: block.partyType === 'CARRIER' ? partyId : null,
        agentId: block.partyType === 'AGENT' ? partyId : null,
        vendorId: block.partyType === 'VENDOR' ? partyId : null,
        currencyId,
        currencyCode: await currencyOf(db, currencyId),
        conversionRate: rate,
        createdBy: userId,
        updatedBy: userId,
      },
      select: { id: true },
    });
    if (lines.length > 0) {
      await db.quotationCostLine.createMany({
        data: lines.map((line, lineIndex) => ({
          tenantId,
          quotationCostId: made.id,
          sortOrder: lineIndex,
          ...line,
          createdBy: userId,
          updatedBy: userId,
        })),
      });
    }
    await retotalQuotationCost(db, made.id, rate);
  }
}

/**
 * A revision carries its cost side over, as it carries its lines: issuing the
 * customer a new revision changes nothing about what the job costs.
 */
export async function copyQuotationCosts(
  db: TenantDb,
  args: { tenantId: bigint; userId: bigint; fromQuotationId: bigint; toQuotationId: bigint },
): Promise<void> {
  const blocks = await loadQuotationCosts(db, args.fromQuotationId);
  for (const [index, block] of blocks.entries()) {
    const made = await db.quotationCost.create({
      data: {
        tenantId: args.tenantId,
        quotationId: args.toQuotationId,
        sortOrder: index,
        partyType: block.partyType,
        carrierId: block.carrierId,
        agentId: block.agentId,
        vendorId: block.vendorId,
        currencyId: block.currencyId,
        currencyCode: block.currencyCode,
        conversionRate: block.conversionRate,
        totalAmount: block.totalAmount,
        totalAmountBase: block.totalAmountBase,
        createdBy: args.userId,
        updatedBy: args.userId,
      },
      select: { id: true },
    });
    if (block.lines.length > 0) {
      await db.quotationCostLine.createMany({
        data: block.lines.map((l, lineIndex) => ({
          tenantId: args.tenantId,
          quotationCostId: made.id,
          sortOrder: lineIndex,
          source: l.source,
          costHeadId: l.costHeadId,
          costHeadName: l.costHeadName,
          containerSizeId: l.containerSizeId,
          containerSizeName: l.containerSizeName,
          costUnitId: l.costUnitId,
          unitName: l.unitName,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          createdBy: args.userId,
          updatedBy: args.userId,
        })),
      });
    }
  }
}

// --------------------------------------------------------------- prefill

/**
 * Where an unsaved cost side starts. Nothing here is saved.
 *
 *   Carrier, vendor or agent  the buy price of every freight line the quotation
 *                             pulled from the price list, owed to whoever the
 *                             rate was bought from (freight_rate's purchase
 *                             source), in the rate's currency
 *   Agent                     the agent's own prices, when the quotation was
 *                             made from an agent's quote — the option for the
 *                             quotation's carrier, or its only option
 *
 * One block of each kind is always offered, named where the quotation already
 * says who (its carrier; the agent it was won through). Local charges carry no
 * buy price in the price list, so they are left to be typed.
 */
export async function quotationCostPrefill(
  db: TenantDb,
  args: { tenantId: bigint; quotationId: bigint; base: BaseCurrency; today: Date },
): Promise<{ blocks: QuotationCostDraftDto[]; notes: string[] }> {
  const { tenantId, quotationId, base, today } = args;
  const q = await db.quotation.findFirst({
    where: { id: quotationId },
    select: {
      carrierId: true,
      carrier: { select: { name: true } },
      conversionRate: true,
      inquiry: { select: { wonAgentId: true, wonAgent: { select: { name: true } } } },
      sourceAgentQuote: {
        select: {
          agentId: true,
          agent: { select: { name: true } },
          options: {
            where: { deletedAt: null, isActive: true },
            orderBy: { position: 'asc' },
            select: {
              carrierId: true,
              lines: {
                where: { deletedAt: null, isActive: true },
                orderBy: { position: 'asc' },
                select: {
                  costHeadId: true,
                  costHead: { select: { name: true } },
                  containerSizeId: true,
                  containerSize: { select: { name: true } },
                  costUnitId: true,
                  costUnit: { select: { name: true } },
                  quantity: true,
                  unitPrice: true,
                  currencyId: true,
                  currency: { select: { currency: true } },
                },
              },
            },
          },
        },
      },
      lines: {
        where: { deletedAt: null },
        orderBy: [{ lineGroup: 'asc' }, { sortOrder: 'asc' }],
        select: {
          costHeadId: true,
          costHeadName: true,
          containerSizeId: true,
          containerSizeName: true,
          costUnitId: true,
          unitName: true,
          quantity: true,
          currencyId: true,
          currencyCode: true,
          source: true,
          priceSourceRateLineId: true,
        },
      },
    },
  });
  if (q === null) throw HttpError.notFound('Quotation not found.');

  const notes: string[] = [];
  // The quotation's one currency (§5.4), whose rate it froze.
  const quotedCurrencyId = q.lines[0]?.currencyId ?? null;
  const rateCache = new Map<string, string>();

  async function rateOf(currencyId: bigint, code: string): Promise<string> {
    const key = currencyId.toString();
    const known = rateCache.get(key);
    if (known !== undefined) return known;
    let rate = '';
    if (currencyId === base.id) rate = '1';
    else if (currencyId === quotedCurrencyId) rate = q!.conversionRate.toString();
    else {
      try {
        rate = (await resolveRate(db, tenantId, currencyId, today)).rate.toString();
      } catch {
        notes.push(`No ${code} rate is on file for today. Enter the rate before saving.`);
      }
    }
    rateCache.set(key, rate);
    return rate;
  }

  type Draft = QuotationCostDraftDto;
  const blocks = new Map<string, Draft>();
  async function blockFor(
    partyType: SupplierPartyType,
    partyId: bigint | null,
    partyName: string | null,
    currencyId: bigint,
    currencyCode: string,
  ): Promise<Draft> {
    const key = `${partyType}:${partyId ?? ''}:${currencyId}`;
    let block = blocks.get(key);
    if (block === undefined) {
      block = {
        partyType,
        partyId: partyId?.toString() ?? null,
        partyName,
        currencyId: currencyId.toString(),
        conversionRate: await rateOf(currencyId, currencyCode),
        lines: [],
      };
      blocks.set(key, block);
    }
    return block;
  }

  // ------------------------------------------- the price list's buy prices
  const rateLineIds = q.lines.flatMap((l) => (l.priceSourceRateLineId === null ? [] : [l.priceSourceRateLineId]));
  const rateLines =
    rateLineIds.length === 0
      ? []
      : await db.freightRateLine.findMany({
          where: { id: { in: rateLineIds } },
          select: {
            id: true,
            buyPrice: true,
            rate: {
              select: {
                currencyId: true,
                currency: { select: { currency: true } },
                carrierId: true,
                carrier: { select: { name: true } },
                purchaseSourceType: true,
                purchaseCarrierId: true,
                purchaseCarrier: { select: { name: true } },
                purchaseVendorId: true,
                purchaseVendor: { select: { name: true } },
                purchaseAgentId: true,
                purchaseAgent: { select: { name: true } },
              },
            },
          },
        });
  const rateLineById = new Map(rateLines.map((r) => [r.id.toString(), r]));

  for (const line of q.lines) {
    if (line.priceSourceRateLineId === null) continue;
    const bought = rateLineById.get(line.priceSourceRateLineId.toString());
    if (bought === undefined) continue;
    const r = bought.rate;
    const [partyType, partyId, partyName]: [SupplierPartyType, bigint | null, string | null] =
      r.purchaseSourceType === 'VENDOR'
        ? ['VENDOR', r.purchaseVendorId, r.purchaseVendor?.name ?? null]
        : r.purchaseSourceType === 'AGENT'
          ? ['AGENT', r.purchaseAgentId, r.purchaseAgent?.name ?? null]
          : ['CARRIER', r.purchaseCarrierId ?? r.carrierId, r.purchaseCarrier?.name ?? r.carrier.name];
    const block = await blockFor(partyType, partyId, partyName, r.currencyId, isoCurrency(r.currency.currency));
    block.lines.push({
      costHeadId: line.costHeadId.toString(),
      costHeadName: line.costHeadName,
      containerSizeId: line.containerSizeId?.toString() ?? null,
      containerSizeName: line.containerSizeName,
      costUnitId: line.costUnitId?.toString() ?? null,
      unitName: line.unitName,
      quantity: line.quantity.toString(),
      unitPrice: bought.buyPrice.toString(),
      source: 'AUTO',
    });
  }
  if (q.lines.some((l) => l.source === 'AUTO' && l.priceSourceRateLineId === null)) {
    notes.push('The price list holds no buying price for the local charges, so add what each supplier charges for them.');
  }

  // ------------------------------------------------- the agent's own quote
  const agentQuote = q.sourceAgentQuote;
  if (agentQuote !== null) {
    const option =
      agentQuote.options.find((o) => o.carrierId === q.carrierId) ??
      (agentQuote.options.length === 1 ? agentQuote.options[0] : undefined);
    if (option === undefined && agentQuote.options.length > 0) {
      notes.push(`${agentQuote.agent.name}'s quote has several options and none for this carrier, so its prices were not pulled.`);
    }
    for (const line of option?.lines ?? []) {
      const block = await blockFor(
        'AGENT',
        agentQuote.agentId,
        agentQuote.agent.name,
        line.currencyId,
        isoCurrency(line.currency.currency),
      );
      block.lines.push({
        costHeadId: line.costHeadId.toString(),
        costHeadName: line.costHead.name,
        containerSizeId: line.containerSizeId?.toString() ?? null,
        containerSizeName: line.containerSize?.name ?? null,
        costUnitId: line.costUnitId?.toString() ?? null,
        unitName: line.costUnit?.name ?? null,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice.toString(),
        source: 'AUTO',
      });
    }
  }

  // ------------------------------------------- one block of each, named
  const quotedCode = q.lines[0]?.currencyCode ?? isoOf(base);
  const defaultCurrency = quotedCurrencyId ?? base.id;
  const out = [...blocks.values()];
  if (!out.some((b) => b.partyType === 'CARRIER')) {
    out.push(await blockFor('CARRIER', q.carrierId, q.carrier.name, defaultCurrency, quotedCode));
  }
  if (!out.some((b) => b.partyType === 'AGENT')) {
    const agentId = agentQuote?.agentId ?? q.inquiry.wonAgentId ?? null;
    const agentName = agentQuote?.agent.name ?? q.inquiry.wonAgent?.name ?? null;
    out.push(await blockFor('AGENT', agentId, agentName, defaultCurrency, quotedCode));
  }
  if (!out.some((b) => b.partyType === 'VENDOR')) {
    out.push(await blockFor('VENDOR', null, null, base.id, isoOf(base)));
  }

  const order: SupplierPartyType[] = ['CARRIER', 'AGENT', 'VENDOR'];
  out.sort((a, b) => order.indexOf(a.partyType) - order.indexOf(b.partyType));
  return { blocks: out, notes };
}
