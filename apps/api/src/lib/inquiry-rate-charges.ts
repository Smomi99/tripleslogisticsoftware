import type { InquiryRateChargesInput, LocalChargeDto } from '@ff/shared';

import { isoCurrency } from './currency-label';
import { resolveRate } from './currency-rate';
import { HttpError } from './http-error';
import { inactiveMasters } from './master-visibility';
import { Prisma } from '../generated/prisma/client';
import type { TenantDb } from './tenant-client';

/**
 * The charges a quoted container carries (client, 2026-10-26): "when the user
 * selects a container they can also select which charges to add; if an extra
 * charge is needed they can add a new one; including the charges, the quoted
 * price will update."
 *
 * Two kinds of charge, one table. A purchase rate's own local charge is
 * ticked in; an extra is typed on the inquiry. Either way its cost head,
 * currency and amount are copied onto inquiry_rate_charge, so re-keying the
 * purchase rate later cannot move a figure already quoted.
 */

export const localChargeInclude = {
  costHead: { select: { name: true } },
  currency: { select: { currency: true } },
  costUnit: { select: { name: true } },
  containerSize: { select: { id: true, code: true } },
} satisfies Prisma.RateLocalChargeInclude;

type LocalChargeRow = Prisma.RateLocalChargeGetPayload<{ include: typeof localChargeInclude }>;

export function localChargeToDto(charge: LocalChargeRow): LocalChargeDto {
  return {
    id: charge.id.toString(),
    costHeadId: charge.costHeadId.toString(),
    costHeadName: charge.costHead.name,
    side: charge.side,
    amount: charge.amount.toFixed(4),
    currencyId: charge.currencyId.toString(),
    currencyCode: isoCurrency(charge.currency.currency),
    costUnitName: charge.costUnit?.name ?? null,
    containerSizeId: charge.containerSize?.id.toString() ?? null,
    containerSizeCode: charge.containerSize?.code ?? null,
    remarks: charge.remarks,
  };
}

/**
 * Whether a rate's local charge belongs on a line. A charge keyed to no size
 * applies whatever the box; one keyed to a size applies to that size only. An
 * LCL or air line has no container, so only the size-less charges reach it.
 */
export function appliesTo(
  charge: { containerSizeId: bigint | null },
  tierContainerSizeId: bigint | null,
): boolean {
  return charge.containerSizeId === null || charge.containerSizeId === tierContainerSizeId;
}

/** The attached line whose charges are being set. */
export interface ChargeTarget {
  inquiryRateId: bigint;
  rateId: bigint;
  rateCurrencyId: bigint;
  tierContainerSizeId: bigint | null;
  freightPrice: Prisma.Decimal;
}

/**
 * Freight plus every charge, in the rate's currency.
 *
 * Converted through the workspace base, amount × rate(from) ÷ rate(to), the
 * way every other conversion is. A charge already in the rate's currency is
 * added as it stands, so a workspace with no base currency still prices a
 * same-currency quote; one that needs a conversion it cannot make is refused
 * by resolveRate with the reason, rather than quoted short.
 */
async function quotedTotal(
  db: TenantDb,
  tenantId: bigint,
  target: ChargeTarget,
  charges: { currencyId: bigint; amount: Prisma.Decimal }[],
): Promise<Prisma.Decimal> {
  const rates = new Map<string, Prisma.Decimal>();
  const rateOf = async (currencyId: bigint): Promise<Prisma.Decimal> => {
    const key = currencyId.toString();
    const known = rates.get(key);
    if (known !== undefined) return known;
    const { rate } = await resolveRate(db, tenantId, currencyId);
    rates.set(key, rate);
    return rate;
  };

  let total = target.freightPrice;
  for (const charge of charges) {
    if (charge.currencyId === target.rateCurrencyId) {
      total = total.plus(charge.amount);
      continue;
    }
    const from = await rateOf(charge.currencyId);
    const to = await rateOf(target.rateCurrencyId);
    total = total.plus(charge.amount.times(from).dividedBy(to));
  }
  return total.toDecimalPlaces(4);
}

/**
 * Sets what one attached line carries and re-prices it. Whatever the input
 * does not list is taken out — softly, since §4 rule 3 forbids anything else.
 *
 * A ticked charge already on the line keeps the amount it was quoted at; one
 * newly ticked is copied from the rate as it stands now.
 */
export async function setRateCharges(
  db: TenantDb,
  tenantId: bigint,
  userId: bigint,
  target: ChargeTarget,
  input: InquiryRateChargesInput,
): Promise<void> {
  const localChargeIds = [...new Set(input.localChargeIds ?? [])];
  const extras = input.extras ?? [];

  const existing = await db.inquiryRateCharge.findMany({
    where: { inquiryRateId: target.inquiryRateId, deletedAt: null },
    select: { id: true, localChargeId: true, costHeadId: true, currencyId: true, amount: true },
  });
  const keptLocal = new Map(
    existing.flatMap((row) =>
      row.localChargeId === null ? [] : [[row.localChargeId.toString(), row] as const],
    ),
  );
  const savedExtras = new Map(
    existing.flatMap((row) => (row.localChargeId === null ? [[row.id.toString(), row] as const] : [])),
  );

  // ---- the rate's own charges ---------------------------------------------
  const wanted = localChargeIds.filter((id) => !keptLocal.has(id));
  const offered =
    wanted.length === 0
      ? []
      : await db.rateLocalCharge.findMany({
          where: { id: { in: wanted.map((id) => BigInt(id)) }, deletedAt: null },
          select: {
            id: true,
            rateId: true,
            costHeadId: true,
            currencyId: true,
            amount: true,
            containerSizeId: true,
          },
        });
  const offeredById = new Map(offered.map((c) => [c.id.toString(), c]));
  for (const id of wanted) {
    const charge = offeredById.get(id);
    // Re-checked here: the drawer only offered this rate's charges for this
    // box, and a filtered picker is a convenience, not a constraint.
    if (
      charge === undefined ||
      charge.rateId !== target.rateId ||
      !appliesTo(charge, target.tierContainerSizeId)
    ) {
      throw HttpError.badRequest('That charge is not on this rate for this container.');
    }
  }

  // ---- extras ---------------------------------------------------------------
  const headIds = [...new Set(extras.map((e) => e.costHeadId))].map((v) => BigInt(v));
  const currencyIds = [...new Set(extras.map((e) => e.currencyId))].map((v) => BigInt(v));
  const [heads, currencies, hidden] = await Promise.all([
    headIds.length === 0
      ? []
      : db.costHead.findMany({
          where: { id: { in: headIds }, deletedAt: null },
          select: { id: true, isActive: true },
        }),
    currencyIds.length === 0
      ? []
      : db.currency.findMany({
          where: { id: { in: currencyIds }, deletedAt: null },
          select: { id: true, isActive: true },
        }),
    inactiveMasters(db),
  ]);
  const headActive = new Map(heads.map((h) => [h.id.toString(), h.isActive]));
  // A shared currency this workspace switched off counts as inactive here.
  const switchedOff = new Set((hidden.get('currency') ?? []).map((v) => v.toString()));
  const currencyActive = new Map(
    currencies.map((c) => [c.id.toString(), c.isActive && !switchedOff.has(c.id.toString())]),
  );
  for (const extra of extras) {
    const before = extra.id === undefined ? undefined : savedExtras.get(extra.id);
    if (extra.id !== undefined && before === undefined) {
      throw HttpError.notFound('One of those charges was removed meanwhile. Reopen Price.');
    }
    // Something switched off since may stay on the charge that already has
    // it; it may not be newly chosen (§4 rule 3).
    const head = headActive.get(extra.costHeadId);
    if (head === undefined || (!head && before?.costHeadId.toString() !== extra.costHeadId)) {
      throw HttpError.badRequest('That cost head is not available. Choose another.');
    }
    const currency = currencyActive.get(extra.currencyId);
    if (
      currency === undefined ||
      (!currency && before?.currencyId.toString() !== extra.currencyId)
    ) {
      throw HttpError.badRequest('That currency is not available. Choose another.');
    }
  }

  // ---- write ------------------------------------------------------------------
  const keepLocal = new Set(localChargeIds);
  const keepExtra = new Set(extras.flatMap((e) => (e.id === undefined ? [] : [e.id])));
  for (const row of existing) {
    const stays =
      row.localChargeId === null
        ? keepExtra.has(row.id.toString())
        : keepLocal.has(row.localChargeId.toString());
    if (stays) continue;
    await db.inquiryRateCharge.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
  }
  for (const id of wanted) {
    const charge = offeredById.get(id)!;
    await db.inquiryRateCharge.create({
      data: {
        tenantId,
        inquiryRateId: target.inquiryRateId,
        sortOrder: 0,
        localChargeId: charge.id,
        costHeadId: charge.costHeadId,
        currencyId: charge.currencyId,
        amount: charge.amount,
        createdBy: userId,
        updatedBy: userId,
      },
    });
  }
  for (const extra of extras) {
    const values = {
      costHeadId: BigInt(extra.costHeadId),
      currencyId: BigInt(extra.currencyId),
      amount: extra.amount,
      updatedBy: userId,
    };
    if (extra.id === undefined) {
      await db.inquiryRateCharge.create({
        data: {
          tenantId,
          inquiryRateId: target.inquiryRateId,
          // After the rate's own charges, which sit at 0.
          sortOrder: 1,
          ...values,
          createdBy: userId,
        },
      });
    } else {
      // Saved again unchanged is not an edit, and the trail should not say so.
      const before = savedExtras.get(extra.id)!;
      if (
        before.costHeadId === values.costHeadId &&
        before.currencyId === values.currencyId &&
        before.amount.equals(values.amount)
      ) {
        continue;
      }
      await db.inquiryRateCharge.update({ where: { id: before.id }, data: values });
    }
  }

  // ---- re-price -----------------------------------------------------------------
  const carried = await db.inquiryRateCharge.findMany({
    where: { inquiryRateId: target.inquiryRateId, deletedAt: null },
    select: { currencyId: true, amount: true },
  });
  await db.inquiryRate.update({
    where: { id: target.inquiryRateId },
    data: {
      quotedPrice: await quotedTotal(db, tenantId, target, carried),
      updatedBy: userId,
    },
  });
}
