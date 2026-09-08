import { HttpError } from './http-error';
import { Prisma } from '../generated/prisma/client';
import type { TenantDb } from './tenant-client';

/**
 * What a workspace books at — the one place that answers it.
 *
 * Every rate in the product means "units of the workspace's BASE currency per
 * 1 unit of this currency". Three things decide the answer and they are not
 * interchangeable:
 *
 *   1. The base itself is always exactly 1. Not "stored as 1" — returned as 1,
 *      because that is what being the base means, and a stored value can drift
 *      while the definition cannot.
 *   2. The workspace's own rate, the latest in force from currency_rate_history.
 *      This is what Settings → Currency writes, and until now nothing outside
 *      that screen read it: a workspace could set BDT/USD to 122 and every
 *      quotation would still bill at the system's 120.
 *   3. The shared `currency.conversion` default — and ONLY when the workspace's
 *      base is the same currency the system defaults are expressed in. A
 *      USD-based workspace falling back to a rate that means "BDT per unit"
 *      would be off by two orders of magnitude, silently. That is refused
 *      rather than guessed.
 */

/** A rate of zero or less cannot be divided by, and is not an exchange rate. */
function assertUsable(rate: Prisma.Decimal, label: string): void {
  if (rate.lessThanOrEqualTo(0)) {
    throw new HttpError(
      409,
      'RATE_NOT_SET',
      `${label} has no usable exchange rate. Set one on Settings → Currency.`,
    );
  }
}

export interface BaseCurrency {
  id: bigint;
  code: string;
  /** "BDT — Bangladeshi Taka". */
  currency: string;
  /**
   * True when the shared `conversion` defaults are expressed in this currency,
   * which is what makes them a safe fallback. The system defaults are in
   * whichever shared currency sits at 1.
   */
  systemDefaultsUsable: boolean;
}

/**
 * The workspace's base currency.
 *
 * Null when it has not been declared. Callers that need to convert must treat
 * that as a stop rather than picking one — guessing the base is how a whole
 * ledger silently changes meaning.
 */
export async function baseCurrency(
  db: TenantDb,
  tenantId: bigint,
): Promise<BaseCurrency | null> {
  const tenant = await db.tenant.findFirst({
    where: { id: tenantId },
    select: {
      currency: { select: { id: true, code: true, currency: true, conversion: true } },
    },
  });
  const base = tenant?.currency;
  if (base == null) return null;

  return {
    id: base.id,
    code: base.code,
    currency: base.currency,
    // The shared defaults are in the currency whose own default is 1. If the
    // base's default is 1, they and the base agree.
    systemDefaultsUsable: base.conversion.equals(1),
  };
}

export interface ResolvedRate {
  rate: Prisma.Decimal;
  source: 'BASE' | 'WORKSPACE' | 'SYSTEM_DEFAULT';
}

/**
 * The rate this workspace converts `currencyId` at, right now.
 *
 * Throws rather than returning something plausible when it cannot answer. Every
 * caller is about to multiply money by this, and a wrong rate that looks fine
 * is the worst outcome available here.
 */
export async function resolveRate(
  db: TenantDb,
  tenantId: bigint,
  currencyId: bigint,
  at: Date = new Date(),
): Promise<ResolvedRate> {
  const base = await baseCurrency(db, tenantId);
  if (base === null) {
    throw new HttpError(
      409,
      'NO_BASE_CURRENCY',
      'This workspace has no base currency. Set one on Settings → Currency before pricing anything.',
    );
  }

  // 1. The base converts to itself at 1, by definition.
  if (base.id === currencyId) {
    return { rate: new Prisma.Decimal(1), source: 'BASE' };
  }

  const currency = await db.currency.findFirst({
    where: { id: currencyId, deletedAt: null },
    select: { currency: true, conversion: true },
  });
  if (currency === null) throw HttpError.notFound('That currency no longer exists.');

  // 2. The workspace's own rate, latest in force.
  const own = await db.currencyRateHistory.findFirst({
    where: {
      currencyId,
      deletedAt: null,
      isActive: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    select: { rate: true },
  });
  if (own !== null) {
    assertUsable(own.rate, currency.currency);
    return { rate: own.rate, source: 'WORKSPACE' };
  }

  // 3. The shared default — only if it is expressed in this workspace's base.
  if (!base.systemDefaultsUsable) {
    throw new HttpError(
      409,
      'RATE_NOT_SET',
      `No ${currency.currency} rate on file for this workspace. ` +
        `The built-in default is not in ${base.code}, so it cannot be used — ` +
        'set a rate on Settings → Currency.',
    );
  }
  assertUsable(currency.conversion, currency.currency);
  return { rate: currency.conversion, source: 'SYSTEM_DEFAULT' };
}

/**
 * The rates for a set of currencies at once, for screens that list them.
 *
 * Same rules as resolveRate, except that a currency it cannot price is left out
 * of the map rather than throwing — a dropdown should still open when one of
 * its rows has no rate, and the caller decides what to do about the gap.
 */
export async function resolveRates(
  db: TenantDb,
  tenantId: bigint,
  currencyIds: bigint[],
  at: Date = new Date(),
): Promise<Map<string, ResolvedRate>> {
  const out = new Map<string, ResolvedRate>();
  if (currencyIds.length === 0) return out;

  const base = await baseCurrency(db, tenantId);
  if (base === null) return out;

  const currencies = await db.currency.findMany({
    where: { id: { in: currencyIds }, deletedAt: null },
    select: { id: true, conversion: true },
  });

  // One query for every workspace rate in force, rather than one per currency.
  const own = await db.currencyRateHistory.findMany({
    where: {
      currencyId: { in: currencyIds },
      deletedAt: null,
      isActive: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    select: { currencyId: true, rate: true },
  });
  const ownByCurrency = new Map<string, Prisma.Decimal>();
  for (const row of own) {
    // Ordered newest first, so the first one seen for a currency is in force.
    const key = row.currencyId.toString();
    if (!ownByCurrency.has(key)) ownByCurrency.set(key, row.rate);
  }

  for (const currency of currencies) {
    const key = currency.id.toString();
    if (currency.id === base.id) {
      out.set(key, { rate: new Prisma.Decimal(1), source: 'BASE' });
      continue;
    }
    const mine = ownByCurrency.get(key);
    if (mine !== undefined && mine.greaterThan(0)) {
      out.set(key, { rate: mine, source: 'WORKSPACE' });
      continue;
    }
    if (base.systemDefaultsUsable && currency.conversion.greaterThan(0)) {
      out.set(key, { rate: currency.conversion, source: 'SYSTEM_DEFAULT' });
    }
    // Otherwise no entry: this workspace cannot price that currency yet.
  }
  return out;
}

/**
 * Move every workspace rate onto a new base.
 *
 * Rates are relative, so changing the base is division: if USD is 120 of the
 * old base and AED is 32.70, then in USD terms AED is 32.70 / 120 = 0.2725 and
 * the old base itself is 1 / 120. Every ratio between two currencies survives
 * untouched, which is the property that makes this safe to do at all.
 *
 * Writes an explicit rate for EVERY currency the workspace can see, including
 * ones that were riding on the shared default — because after the switch that
 * default is in the wrong base and must never be fallen back to again.
 *
 * Returns the rows to write. Deliberately pure: the caller decides the
 * transaction, and a rebase that half-applied would leave a ledger where two
 * currencies disagree about what the base is.
 */
export function rebase(
  currencies: { id: bigint; rateInOldBase: Prisma.Decimal }[],
  newBaseId: bigint,
  newBaseRateInOldBase: Prisma.Decimal,
): { currencyId: bigint; rate: Prisma.Decimal }[] {
  if (newBaseRateInOldBase.lessThanOrEqualTo(0)) {
    throw new HttpError(
      409,
      'RATE_NOT_SET',
      'That currency has no usable rate yet, so nothing can be expressed against it. ' +
        'Set its rate first, then make it the base.',
    );
  }

  return currencies.map((c) => ({
    currencyId: c.id,
    rate:
      c.id === newBaseId
        ? new Prisma.Decimal(1)
        : /*
             Ten decimal places, matching the column. Rounding here rather than
             letting Postgres truncate means the stored figure is the one this
             computed, and a test can hold it to that.

             The limit is honest and worth stating: decimal places are absolute
             while rates are relative, so a very small rate carries fewer
             significant figures than a large one. At ten places a rate of
             1e-6 still keeps five, which is finer than any published rate.
           */
          c.rateInOldBase.dividedBy(newBaseRateInOldBase).toDecimalPlaces(10),
  }));
}
