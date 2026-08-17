import type { LocalChargeDto, RateLineDto, FreightRateDto } from '@ff/shared';

import type { AuthContext } from '../middleware/authenticate';

/**
 * §4 rule 5 — buy price is restricted data.
 *
 * "Gate the buy price and the profit columns behind PURCHASE.RATE.VIEW_BUY_PRICE
 * — and strip them from the API response when the permission is absent. Hiding a
 * column in React while the JSON still carries the margin is not access control;
 * the whole company's margin is one devtools tab away."
 *
 * So this is not a formatting helper. It is the enforcement point, and every
 * route that returns a rate line must pass through it. The line DTO makes
 * buyPrice/profitType/profitValue optional precisely so that omitting them is
 * expressible in the type system rather than a runtime cast.
 */

export const VIEW_BUY_PRICE = 'PURCHASE.RATE.VIEW_BUY_PRICE';
export const MANAGE_PROFIT = 'PURCHASE.RATE.MANAGE_PROFIT';

export function canSeeBuyPrice(auth: AuthContext): boolean {
  return auth.isSuperadmin || auth.permissions.has(VIEW_BUY_PRICE);
}

export function canManageProfit(auth: AuthContext): boolean {
  return auth.isSuperadmin || auth.permissions.has(MANAGE_PROFIT);
}

/**
 * Returns the line as the caller is allowed to see it.
 *
 * Deliberately builds a new object rather than deleting keys from the old one:
 * a `delete` that misses a field fails open, and this failing open costs the
 * client their margin.
 */
export function visibleLine(line: RateLineDto, showBuyPrice: boolean): RateLineDto {
  const base: RateLineDto = {
    id: line.id,
    tierId: line.tierId,
    tierCode: line.tierCode,
    tierLabel: line.tierLabel,
    sellPrice: line.sellPrice,
    minCharge: line.minCharge,
  };
  if (!showBuyPrice) return base;
  return {
    ...base,
    buyPrice: line.buyPrice,
    profitType: line.profitType,
    profitValue: line.profitValue,
  };
}

export function visibleRate(rate: FreightRateDto, showBuyPrice: boolean): FreightRateDto {
  return { ...rate, lines: rate.lines.map((l) => visibleLine(l, showBuyPrice)) };
}

export function visibleRates(rates: FreightRateDto[], showBuyPrice: boolean): FreightRateDto[] {
  return rates.map((r) => visibleRate(r, showBuyPrice));
}

/** Local charges are cost, not margin, and are not gated. Re-exported for clarity. */
export type { LocalChargeDto };
