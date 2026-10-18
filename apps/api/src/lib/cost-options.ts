import { type CostOptionsDto, isoCurrency } from '@ff/shared';

import { baseCurrency, resolveRates } from './currency-rate';
import { isoOf } from './debit-invoice';
import { excludeInactive, inactiveMasters } from './master-visibility';
import type { TenantDb } from './tenant-client';

/**
 * What a cost-block grid draws from — the masters a "Buying from Carrier /
 * Agent / Vendor" block picks from, and today's rate for each currency.
 *
 * One builder for the debit invoice and the quotation (2026-10-18), so the two
 * cost grids cannot come to offer different lists.
 */
export async function costOptionsFor(db: TenantDb, tenantId: bigint): Promise<CostOptionsDto> {
  const [base, inactive] = await Promise.all([baseCurrency(db, tenantId), inactiveMasters(db)]);
  const live = { deletedAt: null, isActive: true };
  const [currencies, costHeads, sizes, units, carriers, agents, vendors] = await Promise.all([
    db.currency.findMany({
      where: { ...live, ...excludeInactive(inactive, 'currency') },
      select: { id: true, currency: true },
      orderBy: { currency: 'asc' },
    }),
    db.costHead.findMany({
      where: live,
      select: { id: true, name: true, unitId: true, unit: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    db.containerSize.findMany({
      where: { ...live, ...excludeInactive(inactive, 'container_size') },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    db.costUnit.findMany({
      where: { ...live, ...excludeInactive(inactive, 'cost_unit') },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.carrier.findMany({
      where: { ...live, ...excludeInactive(inactive, 'carrier') },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.agent.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    db.vendor.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const rates = await resolveRates(
    db,
    tenantId,
    currencies.map((c) => c.id),
  );
  const option = (r: { id: bigint; name: string }) => ({ id: r.id.toString(), label: r.name });
  return {
    baseCurrencyId: base?.id.toString() ?? null,
    baseCurrencyCode: base === null ? null : isoOf(base),
    currencies: currencies.map((c) => ({
      id: c.id.toString(),
      label: c.currency,
      code: isoCurrency(c.currency),
      rate: rates.get(c.id.toString())?.rate.toString() ?? null,
    })),
    costHeads: costHeads.map((h) => ({
      id: h.id.toString(),
      label: h.name,
      unitId: h.unitId.toString(),
      unitName: h.unit.name,
    })),
    containerSizes: sizes.map(option),
    costUnits: units.map(option),
    carriers: carriers.map(option),
    agents: agents.map(option),
    vendors: vendors.map(option),
  };
}
