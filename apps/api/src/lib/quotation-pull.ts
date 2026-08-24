import { Prisma } from '../generated/prisma/client';
import { isoCurrency } from './currency-label';
import type { TenantDb } from './tenant-client';

/**
 * §5.3 rule 3 — building a quotation's lines out of the price table.
 *
 * "Match the price table on POL + POD + Goods Type + Carrier, pull every cost
 * head with a selling price, and create one line per applicable container size
 * using the quantities from inquiry_container."
 *
 * The price table answers that in two parts, which is the thing to understand
 * before reading any of this:
 *
 *   freight_rate_line  prices the box. One row per rate_tier, and for sea FCL a
 *                      tier IS a container size. It carries no cost head — the
 *                      purchase side never needed to name the freight.
 *   rate_local_charge  prices everything around it, and does carry a cost head:
 *                      the Seal Charge, ENS and HBL lines on the client's
 *                      sample sheet.
 *
 * So the freight lines need a name from somewhere, and the caller supplies it.
 * What the freight is *called* on a customer-facing document is a sales
 * decision, not a purchasing one, and inventing a column on freight_rate to
 * hold it would put that decision in the wrong module. Without one, the local
 * charges still pull and the freight is left for the user to add by hand —
 * §5.3 rule 5's instinct, applied to a gap in the schema rather than a gap in
 * the prices.
 *
 * Nothing here reads buy_price. A quotation is customer-facing and sell_price
 * is the only figure that belongs on it; the buy side is guarded by
 * PURCHASE.*.VIEW_BUY_PRICE and has no business in this file at all.
 */

export interface PulledLine {
  lineGroup: 'STANDARD';
  sortOrder: number;
  costHeadId: bigint;
  costHeadName: string;
  containerSizeId: bigint | null;
  containerSizeName: string | null;
  costUnitId: bigint | null;
  unitName: string | null;
  quantity: Prisma.Decimal;
  sellingPrice: Prisma.Decimal;
  currencyId: bigint;
  currencyCode: string;
  source: 'AUTO';
  priceSourceRateLineId: bigint | null;
  priceSourceLocalChargeId: bigint | null;
}

export interface PullResult {
  lines: PulledLine[];
  /** The rate the lines came from, for the caller to record or report on. */
  rateId: bigint | null;
  /**
   * Container sizes the inquiry asks for that the rate does not price. §5.3
   * rule 5 refuses to block the quotation over an incomplete price table, so
   * these come back to be shown rather than to stop anything.
   */
  unpricedSizes: string[];
}

/** Today at UTC midnight — rate validity is a DATE, not an instant. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function pullQuotationLines(
  db: TenantDb,
  input: {
    polId: bigint;
    podId: bigint;
    goodsTypeId: bigint | null;
    carrierId: bigint;
    inquiryId: bigint;
    /** Names the freight lines. Null leaves them for the user to add. */
    freightCostHeadId: bigint | null;
  },
): Promise<PullResult> {
  const today = startOfToday();

  /*
   * The lane, priced by this carrier, live today.
   *
   * Goods type joins the match only when the inquiry states one — an inquiry
   * with no goods type should still find the lane's rate rather than silently
   * returning nothing, which would look identical to "we hold no rate".
   */
  const rate = await db.freightRate.findFirst({
    where: {
      polId: input.polId,
      podId: input.podId,
      carrierId: input.carrierId,
      ...(input.goodsTypeId === null ? {} : { goodsTypeId: input.goodsTypeId }),
      status: 'PUBLISHED',
      deletedAt: null,
      isActive: true,
      validFrom: { lte: today },
      validTo: { gte: today },
    },
    // The most recently issued one, when a lane has been repriced.
    orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      currencyId: true,
      currency: { select: { currency: true } },
      lines: {
        where: { deletedAt: null, isActive: true },
        select: {
          id: true,
          sellPrice: true,
          tier: {
            select: {
              containerSizeId: true,
              label: true,
              containerSize: { select: { name: true } },
            },
          },
        },
      },
      localCharges: {
        where: { deletedAt: null, isActive: true },
        select: {
          id: true,
          amount: true,
          currencyId: true,
          currency: { select: { currency: true } },
          containerSizeId: true,
          containerSize: { select: { name: true } },
          costUnitId: true,
          costUnit: { select: { name: true } },
          costHeadId: true,
          costHead: { select: { name: true, unitId: true, unit: { select: { name: true } } } },
        },
      },
    },
  });

  // What the customer actually asked to move, per container size.
  const volumes = await db.inquiryVolume.findMany({
    where: { inquiryId: input.inquiryId, deletedAt: null, isActive: true },
    select: {
      containerSizeId: true,
      containerSize: { select: { name: true } },
      containerSizeNote: true,
      quantity: true,
      cbm: true,
      weightKg: true,
    },
  });

  if (rate === null) return { lines: [], rateId: null, unpricedSizes: [] };

  /*
   * How many of each size. An FCL row counts boxes; an LCL row is measured and
   * an air row weighed, and for those the "quantity" the line bills by is the
   * CBM or the kilos — which is exactly what the rate's own tier unit expects.
   */
  const wanted = new Map<string, { qty: Prisma.Decimal; name: string | null }>();
  for (const volume of volumes) {
    const key = volume.containerSizeId?.toString() ?? 'NO_SIZE';
    const qty =
      volume.quantity !== null
        ? new Prisma.Decimal(volume.quantity)
        : (volume.cbm ?? volume.weightKg ?? null);
    if (qty === null) continue;
    const existing = wanted.get(key);
    wanted.set(key, {
      qty: existing === undefined ? qty : existing.qty.plus(qty),
      name: volume.containerSize?.name ?? volume.containerSizeNote ?? null,
    });
  }

  const freightCurrency = isoCurrency(rate.currency?.currency ?? '') ?? '';
  const lines: PulledLine[] = [];
  const priced = new Set<string>();
  let sortOrder = 0;

  // ---- the freight, one line per size the customer wants and we price ------
  if (input.freightCostHeadId !== null) {
    const head = await db.costHead.findFirst({
      where: { id: input.freightCostHeadId, deletedAt: null },
      select: { id: true, name: true, unitId: true, unit: { select: { name: true } } },
    });
    if (head !== null) {
      for (const rateLine of rate.lines) {
        const key = rateLine.tier.containerSizeId?.toString() ?? 'NO_SIZE';
        const want = wanted.get(key);
        // A rate may price sizes the customer did not ask for. Quoting those
        // would put equipment on the document nobody requested.
        if (want === undefined) continue;
        if (rateLine.sellPrice === null) continue;
        priced.add(key);
        lines.push({
          lineGroup: 'STANDARD',
          sortOrder: (sortOrder += 1),
          costHeadId: head.id,
          costHeadName: head.name,
          containerSizeId: rateLine.tier.containerSizeId,
          containerSizeName: rateLine.tier.containerSize?.name ?? rateLine.tier.label,
          costUnitId: head.unitId,
          unitName: head.unit?.name ?? null,
          quantity: want.qty,
          sellingPrice: rateLine.sellPrice,
          currencyId: rate.currencyId,
          currencyCode: freightCurrency,
          source: 'AUTO',
          priceSourceRateLineId: rateLine.id,
          priceSourceLocalChargeId: null,
        });
      }
    }
  }

  // ---- the charges around it ----------------------------------------------
  for (const charge of rate.localCharges) {
    const key = charge.containerSizeId?.toString() ?? 'NO_SIZE';
    /*
     * A charge tied to a container size bills per box, so it only applies if
     * the customer wants that box. A charge with no size — the ENS and HBL
     * lines on the client's sheet — bills once per document, quantity 1.
     */
    let quantity: Prisma.Decimal;
    if (charge.containerSizeId === null) {
      quantity = new Prisma.Decimal(1);
    } else {
      const want = wanted.get(key);
      if (want === undefined) continue;
      quantity = want.qty;
    }

    lines.push({
      lineGroup: 'STANDARD',
      sortOrder: (sortOrder += 1),
      costHeadId: charge.costHeadId,
      costHeadName: charge.costHead?.name ?? '—',
      containerSizeId: charge.containerSizeId,
      containerSizeName: charge.containerSize?.name ?? null,
      // The charge's own unit if it has one, else the cost head's.
      costUnitId: charge.costUnitId ?? charge.costHead?.unitId ?? null,
      unitName: charge.costUnit?.name ?? charge.costHead?.unit?.name ?? null,
      quantity,
      sellingPrice: charge.amount,
      currencyId: charge.currencyId,
      currencyCode: isoCurrency(charge.currency?.currency ?? '') ?? '',
      source: 'AUTO',
      priceSourceRateLineId: null,
      priceSourceLocalChargeId: charge.id,
    });
  }

  // §5.3 rule 5: report the gaps, never block on them.
  const unpricedSizes: string[] = [];
  for (const [key, want] of wanted) {
    if (key === 'NO_SIZE') continue;
    if (!priced.has(key)) unpricedSizes.push(want.name ?? 'that size');
  }

  return { lines, rateId: rate.id, unpricedSizes };
}
