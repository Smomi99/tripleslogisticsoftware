import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  EXPIRING_SOON_DAYS,
  type FreightRateDto,
  freightRateInputSchema,
  freightRateListQuerySchema,
  type LocalChargeDto,
  type LookupOption,
  type PurchaseSourceType,
  type RateLineDto,
  type RateMode,
  RATE_SORT_FIELDS,
  type RateSortField,
} from '@ff/shared';
import { type RequestHandler, Router } from 'express';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { canManageProfit, canSeeBuyPrice, visibleRate, visibleRates } from '../lib/rate-visibility';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Purchase — freight rate entry (docs/MODULE_PURCHASE_SALES.md §5.1).
 *
 * The reference implementation for all nine purchase screens. Sea FCL, Sea LCL
 * and Air differ only by `mode`, and which tiers they price comes from
 * rate_tier — so this router serves all three rather than being copied twice.
 *
 * Two rules do real work here and are worth finding quickly:
 *   - §4 rule 5: buy price and profit are stripped from every response the
 *     caller is not permitted to see. See lib/rate-visibility.
 *   - §4 rule 8: overlapping published rates are refused by a Postgres
 *     exclusion constraint, translated to a readable message below.
 */
export const freightRateRouter: Router = Router();

freightRateRouter.use(authenticate);

/** Each mode is a separate §3 screen, so each carries its own permission. */
const FEATURE_BY_MODE: Record<RateMode, string> = {
  SEA_FCL: 'PURCHASE.SEA_FREIGHT_FCL',
  SEA_LCL: 'PURCHASE.SEA_FREIGHT_LCL',
  AIR: 'PURCHASE.AIR_FREIGHT_PURCHASE',
};

/**
 * Resolves the mode from the request, then checks that mode's permission.
 *
 * The mode is a route input, so it decides WHICH permission is required — never
 * whether one is required. An unknown mode is rejected before any lookup.
 */
function requireModePermission(action: string): RequestHandler {
  // Built once at startup so a typo in a feature key still fails loudly there,
  // rather than only on the first request that happens to use that mode.
  const guards = new Map<RateMode, RequestHandler>(
    (Object.keys(FEATURE_BY_MODE) as RateMode[]).map((mode) => [
      mode,
      requirePermission(`${FEATURE_BY_MODE[mode]}.${action}`),
    ]),
  );

  return function modeGuard(req, res, next): void {
    const raw: unknown = req.query['mode'] ?? (req.body as { mode?: unknown } | undefined)?.mode;
    const guard = typeof raw === 'string' ? guards.get(raw as RateMode) : undefined;
    if (guard === undefined) {
      throw HttpError.badRequest('Choose a freight mode.');
    }
    guard(req, res, next);
  };
}

const money = (value: Prisma.Decimal | null | undefined): string =>
  value === null || value === undefined ? '0.0000' : value.toFixed(4);

const optionalMoney = (value: Prisma.Decimal | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toFixed(4);

/** `YYYY-MM-DD`, the shape the shared schema validates and the form sends. */
const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * "USD — US Dollar" -> "USD".
 *
 * `currency.code` is the business code (CUR-001), not the ISO code; the ISO
 * code is the head of `currency.currency`. Rate tables are dense enough that
 * the full name does not fit beside every figure.
 */
const isoCurrency = (value: string): string => (value.split('—')[0] ?? value).trim();

/** The exclusion constraint is the authority; this makes its refusal readable. */
function translateWriteError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';

  if (code === 'P2010' || code === 'P2002' || message.includes('freight_rate_no_overlap')) {
    if (message.includes('freight_rate_no_overlap')) {
      throw HttpError.conflict(
        'A published rate already covers this lane, carrier and period. Edit that rate, or start this one after it ends.',
      );
    }
  }
  if (message.includes('freight_rate_purchase_source_ck')) {
    throw HttpError.badRequest('Choose exactly one source this rate was bought from.');
  }
  if (message.includes('freight_rate_validity_ck')) {
    throw HttpError.badRequest('The end date cannot fall before the start date.');
  }
  throw error;
}

/** Everything a rate DTO needs, in one shape reused by list and detail. */
const rateInclude = {
  pol: { select: { id: true, name: true, portCode: true } },
  pod: { select: { id: true, name: true, portCode: true } },
  carrier: { select: { id: true, name: true } },
  goodsType: { select: { id: true, name: true } },
  currency: { select: { id: true, code: true, currency: true } },
  purchaseCarrier: { select: { id: true, name: true } },
  purchaseVendor: { select: { id: true, name: true } },
  purchaseAgent: { select: { id: true, name: true } },
  lines: {
    where: { deletedAt: null },
    include: { tier: { select: { id: true, code: true, label: true, sortOrder: true } } },
    orderBy: [{ tier: { sortOrder: 'asc' } }, { id: 'asc' }],
  },
  localCharges: {
    where: { deletedAt: null },
    include: {
      costHead: { select: { id: true, name: true } },
      currency: { select: { id: true, code: true, currency: true } },
      costUnit: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.FreightRateInclude;

type RateWithRelations = Prisma.FreightRateGetPayload<{ include: typeof rateInclude }>;

function purchaseSource(rate: RateWithRelations): { id: string; name: string } {
  const source: Record<PurchaseSourceType, { id: bigint; name: string } | null> = {
    CARRIER: rate.purchaseCarrier,
    VENDOR: rate.purchaseVendor,
    AGENT: rate.purchaseAgent,
  };
  const named = source[rate.purchaseSourceType];
  // The CHECK constraint guarantees one is set; this is belt and braces.
  return named === null
    ? { id: '', name: '—' }
    : { id: named.id.toString(), name: named.name };
}

function toDto(rate: RateWithRelations, today: Date): FreightRateDto {
  const lines: RateLineDto[] = rate.lines.map((line) => ({
    id: line.id.toString(),
    tierId: line.tierId.toString(),
    tierCode: line.tier.code,
    tierLabel: line.tier.label,
    sellPrice: money(line.sellPrice),
    minCharge: optionalMoney(line.minCharge),
    buyPrice: money(line.buyPrice),
    profitType: line.profitType,
    profitValue: money(line.profitValue),
  }));

  const localCharges: LocalChargeDto[] = rate.localCharges.map((charge) => ({
    id: charge.id.toString(),
    costHeadId: charge.costHeadId.toString(),
    costHeadName: charge.costHead.name,
    side: charge.side,
    amount: money(charge.amount),
    currencyId: charge.currencyId.toString(),
    currencyCode: isoCurrency(charge.currency.currency),
    costUnitName: charge.costUnit?.name ?? null,
    remarks: charge.remarks,
  }));

  // Only same-currency charges are summed. Mixing BDT into a USD total would
  // produce a confident wrong number, which is worse than showing the count.
  const total = rate.localCharges
    .filter((c) => c.currencyId === rate.currencyId)
    .reduce((sum, c) => sum.add(c.amount), new Prisma.Decimal(0));

  const daysToExpiry = Math.ceil(
    (rate.validTo.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
  );

  const source = purchaseSource(rate);

  return {
    id: rate.id.toString(),
    code: rate.code,
    mode: rate.mode,
    polId: rate.polId.toString(),
    polName: rate.pol.name,
    polCode: rate.pol.portCode,
    podId: rate.podId.toString(),
    podName: rate.pod.name,
    podCode: rate.pod.portCode,
    carrierId: rate.carrierId.toString(),
    carrierName: rate.carrier.name,
    goodsTypeId: rate.goodsTypeId.toString(),
    goodsTypeName: rate.goodsType.name,
    purchaseSourceType: rate.purchaseSourceType,
    purchaseSourceId: source.id,
    purchaseSourceName: source.name,
    currencyId: rate.currencyId.toString(),
    currencyCode: isoCurrency(rate.currency.currency),
    validFrom: isoDate(rate.validFrom),
    validTo: isoDate(rate.validTo),
    transitDays: rate.transitDays,
    remarks: rate.remarks,
    status: rate.status,
    isActive: rate.isActive,
    expiringSoon: daysToExpiry >= 0 && daysToExpiry <= EXPIRING_SOON_DAYS,
    lines,
    localCharges,
    localChargeTotal: total.toFixed(4),
    localChargeCount: rate.localCharges.length,
  };
}

// ===========================================================================
// List
// ===========================================================================

freightRateRouter.get('/rates', requireModePermission('VIEW'), async (req, res) => {
  const auth = req.auth!;
  const query = freightRateListQuerySchema.parse(req.query);

  const today = new Date(new Date().toISOString().slice(0, 10));

  const where: Prisma.FreightRateWhereInput = {
    deletedAt: null,
    mode: query.mode,
    ...(query.polId !== undefined && query.polId !== ''
      ? { polId: BigInt(query.polId) }
      : {}),
    // §4 rule 7: many PODs at once.
    ...(query.podIds !== undefined ? { podId: { in: query.podIds.map(BigInt) } } : {}),
    ...(query.carrierId !== undefined && query.carrierId !== ''
      ? { carrierId: BigInt(query.carrierId) }
      : {}),
    ...(query.goodsTypeId !== undefined && query.goodsTypeId !== ''
      ? { goodsTypeId: BigInt(query.goodsTypeId) }
      : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    // §4 rule 2: valid rates by default; expired only when explicitly asked for.
    ...(query.includeExpired ? {} : { validTo: { gte: today } }),
    ...(query.search !== undefined
      ? {
          OR: [
            { code: { contains: query.search, mode: 'insensitive' } },
            { pol: { name: { contains: query.search, mode: 'insensitive' } } },
            { pod: { name: { contains: query.search, mode: 'insensitive' } } },
            { carrier: { name: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const sortBy: RateSortField = RATE_SORT_FIELDS.includes(query.sortBy as RateSortField)
    ? (query.sortBy as RateSortField)
    : 'validFrom';

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const [rows, total] = await Promise.all([
      db.freightRate.findMany({
        where,
        include: rateInclude,
        orderBy: { [sortBy]: query.sortOrder },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.freightRate.count({ where }),
    ]);
    return { rows, total };
  });

  const payload: ApiSuccess<FreightRateDto[]> = {
    success: true,
    // §4 rule 5 — the margin never leaves the server for a caller without the
    // permission, whatever the client then chooses to render.
    data: visibleRates(
      rows.map((r) => toDto(r, today)),
      canSeeBuyPrice(auth),
    ),
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

// ===========================================================================
// Create
// ===========================================================================

/** Resolves and validates every FK a rate points at, inside the tenant scope. */
async function assertReferences(
  db: TenantDb,
  input: ReturnType<typeof freightRateInputSchema.parse>,
): Promise<{
  polId: bigint;
  podId: bigint;
  carrierId: bigint;
  goodsTypeId: bigint;
  currencyId: bigint;
  purchaseCarrierId: bigint | null;
  purchaseVendorId: bigint | null;
  purchaseAgentId: bigint | null;
  tierIds: Map<string, bigint>;
}> {
  const polId = parseRefId(input.polId, 'port of loading');
  const podId = parseRefId(input.podId, 'port of discharge');
  const carrierId = parseRefId(input.carrierId, 'carrier');
  const goodsTypeId = parseRefId(input.goodsTypeId, 'goods type');
  const currencyId = parseRefId(input.currencyId, 'currency');

  // §4 rule 9: Air uses airports and airlines; sea uses seaports. "Enforce
  // server-side — a filtered dropdown is a convenience, not a constraint."
  const wantedPortType = input.mode === 'AIR' ? 'AIRPORT' : 'SEAPORT';
  const ports = await db.port.findMany({
    where: { id: { in: [polId, podId] }, deletedAt: null, isActive: true },
    select: { id: true, type: true },
  });
  if (ports.length !== 2) throw HttpError.badRequest('Choose two available ports.');
  for (const port of ports) {
    if (port.type !== wantedPortType) {
      throw HttpError.badRequest(
        input.mode === 'AIR'
          ? 'An air rate must run between two airports.'
          : 'A sea rate must run between two seaports.',
      );
    }
  }

  const carrier = await db.carrier.findFirst({
    where: { id: carrierId, deletedAt: null, isActive: true },
    select: { id: true, type: { select: { name: true } } },
  });
  if (carrier === null) throw HttpError.badRequest('That carrier is not available.');
  const isAirline = carrier.type.name.toLowerCase() === 'airline';
  if (input.mode === 'AIR' && !isAirline) {
    throw HttpError.badRequest('An air rate must name an airline.');
  }
  if (input.mode !== 'AIR' && isAirline) {
    throw HttpError.badRequest('A sea rate cannot name an airline.');
  }

  const goodsType = await db.goodsType.findFirst({
    where: { id: goodsTypeId, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (goodsType === null) throw HttpError.badRequest('That goods type is not available.');

  const currency = await db.currency.findFirst({
    where: { id: currencyId, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (currency === null) throw HttpError.badRequest('That currency is not available.');

  // Exactly one source, matching the declared type. The CHECK constraint says
  // the same thing; this reaches the user as a message instead of a 500.
  let purchaseCarrierId: bigint | null = null;
  let purchaseVendorId: bigint | null = null;
  let purchaseAgentId: bigint | null = null;

  if (input.purchaseSourceType === 'CARRIER') {
    purchaseCarrierId = parseRefId(input.purchaseCarrierId ?? '', 'carrier');
    const found = await db.carrier.findFirst({
      where: { id: purchaseCarrierId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (found === null) throw HttpError.badRequest('That carrier is not available.');
  } else if (input.purchaseSourceType === 'VENDOR') {
    purchaseVendorId = parseRefId(input.purchaseVendorId ?? '', 'vendor');
    const found = await db.vendor.findFirst({
      where: { id: purchaseVendorId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (found === null) throw HttpError.badRequest('That vendor is not available.');
  } else {
    purchaseAgentId = parseRefId(input.purchaseAgentId ?? '', 'agent');
    const found = await db.agent.findFirst({
      where: { id: purchaseAgentId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (found === null) throw HttpError.badRequest('That agent is not available.');
  }

  // Every tier must exist, be active, and belong to this rate's mode — pricing
  // a Sea FCL rate against an air weight break is meaningless.
  const tierIds = new Map<string, bigint>();
  for (const line of input.lines) tierIds.set(line.tierId, BigInt(line.tierId));
  const tiers = await db.rateTier.findMany({
    where: { id: { in: [...tierIds.values()] }, deletedAt: null, isActive: true },
    select: { id: true, mode: true },
  });
  if (tiers.length !== tierIds.size) {
    throw HttpError.badRequest('One of those rate tiers is not available.');
  }
  for (const tier of tiers) {
    if (tier.mode !== input.mode) {
      throw HttpError.badRequest('A rate can only be priced against tiers of its own mode.');
    }
  }

  return {
    polId,
    podId,
    carrierId,
    goodsTypeId,
    currencyId,
    purchaseCarrierId,
    purchaseVendorId,
    purchaseAgentId,
    tierIds,
  };
}

/** Local charge lines, with the cost head's unit captured at entry (§3.2). */
async function localChargeRows(
  db: TenantDb,
  input: ReturnType<typeof freightRateInputSchema.parse>,
  userId: bigint,
): Promise<Prisma.RateLocalChargeCreateManyRateInput[]> {
  if (input.localCharges.length === 0) return [];

  const costHeadIds = input.localCharges.map((c) => BigInt(c.costHeadId));
  const costHeads = await db.costHead.findMany({
    where: { id: { in: costHeadIds }, deletedAt: null, isActive: true },
    select: { id: true, unitId: true },
  });
  const unitOf = new Map(costHeads.map((h) => [h.id.toString(), h.unitId]));
  if (costHeads.length !== new Set(costHeadIds.map(String)).size) {
    throw HttpError.badRequest('One of those cost heads is not available.');
  }

  // No tenantId: these rows are created nested under the rate, and the
  // composite FK supplies it.
  return input.localCharges.map((charge) => ({
    costHeadId: BigInt(charge.costHeadId),
    side: charge.side,
    amount: charge.amount,
    currencyId: BigInt(charge.currencyId),
    costUnitId: unitOf.get(charge.costHeadId) ?? null,
    remarks: charge.remarks === undefined || charge.remarks === '' ? null : charge.remarks,
    createdBy: userId,
    updatedBy: userId,
  }));
}

freightRateRouter.post('/rates', requireModePermission('CREATE'), async (req, res) => {
  const auth = req.auth!;
  const input = freightRateInputSchema.parse(req.body);

  // §4 rule 6: only the price team may set a margin. Without it a rate can
  // still be entered, but at zero profit — the buyer records the cost, the
  // pricing team adds the margin later on the Add-on screen.
  const mayPrice = canManageProfit(auth);

  const created = await withTenant(auth.tenantId, async (db) => {
    const refs = await assertReferences(db, input);
    const charges = await localChargeRows(db, input, auth.userId);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'freightRate', CODE_PREFIX.freightRate, auth.tenantId);
      try {
        return await db.freightRate.create({
          data: {
            tenantId: auth.tenantId,
            code,
            mode: input.mode,
            polId: refs.polId,
            podId: refs.podId,
            carrierId: refs.carrierId,
            goodsTypeId: refs.goodsTypeId,
            purchaseSourceType: input.purchaseSourceType,
            purchaseCarrierId: refs.purchaseCarrierId,
            purchaseVendorId: refs.purchaseVendorId,
            purchaseAgentId: refs.purchaseAgentId,
            currencyId: refs.currencyId,
            validFrom: new Date(input.validFrom),
            validTo: new Date(input.validTo),
            transitDays:
              input.transitDays === undefined || input.transitDays === ''
                ? null
                : Number(input.transitDays),
            remarks: input.remarks === undefined || input.remarks === '' ? null : input.remarks,
            status: input.status,
            createdBy: auth.userId,
            updatedBy: auth.userId,
            lines: {
              createMany: {
                // tenantId is not accepted here — the composite FK to the
                // parent supplies it, and Prisma rejects it as unknown.
                data: input.lines.map((line) => ({
                  tierId: BigInt(line.tierId),
                  buyPrice: line.buyPrice,
                  profitType: mayPrice ? (line.profitType ?? 'FLAT') : 'FLAT',
                  profitValue: mayPrice ? (line.profitValue || '0') : '0',
                  minCharge:
                    line.minCharge === undefined || line.minCharge === '' ? null : line.minCharge,
                  createdBy: auth.userId,
                  updatedBy: auth.userId,
                })),
              },
            },
            ...(charges.length > 0 ? { localCharges: { createMany: { data: charges } } } : {}),
          },
          include: rateInclude,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        translateWriteError(error);
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not create the rate. Try again.');
  });

  const today = new Date(new Date().toISOString().slice(0, 10));
  const payload: ApiSuccess<FreightRateDto> = {
    success: true,
    data: visibleRate(toDto(created, today), canSeeBuyPrice(auth)),
  };
  res.status(201).json(payload);
});

// ===========================================================================
// Read one
// ===========================================================================

freightRateRouter.get('/rates/:id', requireModePermission('VIEW'), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'rate');

  const rate = await withTenant(auth.tenantId, (db) =>
    db.freightRate.findFirst({ where: { id, deletedAt: null }, include: rateInclude }),
  );
  if (rate === null) throw HttpError.notFound('Rate not found.');

  const today = new Date(new Date().toISOString().slice(0, 10));
  const payload: ApiSuccess<FreightRateDto> = {
    success: true,
    data: visibleRate(toDto(rate, today), canSeeBuyPrice(auth)),
  };
  res.json(payload);
});

// ===========================================================================
// Update
//
// §4 rule 1 makes Edit mean "supersede and replace", not "mutate". That logic
// lands in phase G with its own tests; until then this updates in place and
// refuses to touch a PUBLISHED rate, so no quotation can be invalidated by an
// edit in the meantime.
// ===========================================================================

freightRateRouter.patch('/rates/:id', requireModePermission('EDIT'), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'rate');
  const input = freightRateInputSchema.parse(req.body);
  const mayPrice = canManageProfit(auth);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.freightRate.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true },
    });
    if (existing === null) throw HttpError.notFound('Rate not found.');
    if (existing.status === 'PUBLISHED') {
      throw HttpError.conflict(
        'A published rate cannot be edited — quotations already reference it. Supersede it with a new rate instead.',
      );
    }
    if (existing.status === 'EXPIRED') {
      throw HttpError.conflict('An expired rate cannot be edited.');
    }

    const refs = await assertReferences(db, input);
    const charges = await localChargeRows(db, input, auth.userId);

    try {
      // A draft's lines and charges are replaced wholesale. Safe only because
      // nothing downstream can reference a draft yet.
      await db.freightRateLine.deleteMany({ where: { rateId: id } });
      await db.rateLocalCharge.deleteMany({ where: { rateId: id } });

      return await db.freightRate.update({
        where: { id },
        data: {
          mode: input.mode,
          polId: refs.polId,
          podId: refs.podId,
          carrierId: refs.carrierId,
          goodsTypeId: refs.goodsTypeId,
          purchaseSourceType: input.purchaseSourceType,
          purchaseCarrierId: refs.purchaseCarrierId,
          purchaseVendorId: refs.purchaseVendorId,
          purchaseAgentId: refs.purchaseAgentId,
          currencyId: refs.currencyId,
          validFrom: new Date(input.validFrom),
          validTo: new Date(input.validTo),
          transitDays:
            input.transitDays === undefined || input.transitDays === ''
              ? null
              : Number(input.transitDays),
          remarks: input.remarks === undefined || input.remarks === '' ? null : input.remarks,
          status: input.status,
          updatedBy: auth.userId,
          lines: {
            createMany: {
              // See the create path: the parent relation supplies tenantId.
              data: input.lines.map((line) => ({
                tierId: BigInt(line.tierId),
                buyPrice: line.buyPrice,
                profitType: mayPrice ? (line.profitType ?? 'FLAT') : 'FLAT',
                profitValue: mayPrice ? (line.profitValue || '0') : '0',
                minCharge:
                  line.minCharge === undefined || line.minCharge === '' ? null : line.minCharge,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              })),
            },
          },
          ...(charges.length > 0 ? { localCharges: { createMany: { data: charges } } } : {}),
        },
        include: rateInclude,
      });
    } catch (error) {
      translateWriteError(error);
    }
  });

  const today = new Date(new Date().toISOString().slice(0, 10));
  const payload: ApiSuccess<FreightRateDto> = {
    success: true,
    data: visibleRate(toDto(updated, today), canSeeBuyPrice(auth)),
  };
  res.json(payload);
});

// ===========================================================================
// Delete — soft, always (CLAUDE.md §4 rule 3)
// ===========================================================================

freightRateRouter.post('/rates/:id/delete', requireModePermission('EDIT'), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'rate');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.freightRate.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Rate not found.');

    await db.freightRate.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: id.toString() } };
  res.json(payload);
});

// ===========================================================================
// Form options — the dropdowns the entry row needs, filtered per §4 rule 9
// ===========================================================================

export interface RateFormOptions {
  ports: LookupOption[];
  carriers: LookupOption[];
  goodsTypes: LookupOption[];
  currencies: LookupOption[];
  vendors: LookupOption[];
  agents: LookupOption[];
  tiers: { id: string; code: string; label: string }[];
  costHeads: LookupOption[];
  canSeeBuyPrice: boolean;
  canManageProfit: boolean;
}

freightRateRouter.get('/rate-options', requireModePermission('VIEW'), async (req, res) => {
  const auth = req.auth!;
  const mode = req.query['mode'] as RateMode;

  const options = await withTenant(auth.tenantId, async (db) => {
    const [ports, carriers, goodsTypes, currencies, vendors, agents, tiers, costHeads] =
      await Promise.all([
        db.port.findMany({
          where: {
            deletedAt: null,
            isActive: true,
            type: mode === 'AIR' ? 'AIRPORT' : 'SEAPORT',
          },
          select: { id: true, name: true, portCode: true },
          orderBy: { name: 'asc' },
        }),
        db.carrier.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true, type: { select: { name: true } } },
          orderBy: { name: 'asc' },
        }),
        db.goodsType.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.currency.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, code: true, currency: true },
          orderBy: { code: 'asc' },
        }),
        db.vendor.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.agent.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.rateTier.findMany({
          where: { deletedAt: null, isActive: true, mode },
          select: { id: true, code: true, label: true },
          orderBy: { sortOrder: 'asc' },
        }),
        db.costHead.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);

    // §4 rule 9 again, on the way out: an air screen offers airlines only.
    const airline = (name: string): boolean => name.toLowerCase() === 'airline';
    const usableCarriers = carriers.filter((c) =>
      mode === 'AIR' ? airline(c.type.name) : !airline(c.type.name),
    );

    return {
      ports: ports.map((p) => ({ id: p.id.toString(), name: `${p.portCode} — ${p.name}` })),
      carriers: usableCarriers.map((c) => ({ id: c.id.toString(), name: c.name })),
      goodsTypes: goodsTypes.map((g) => ({ id: g.id.toString(), name: g.name })),
      // The dropdown has room for the full name; the tables do not.
      currencies: currencies.map((c) => ({ id: c.id.toString(), name: c.currency })),
      vendors: vendors.map((v) => ({ id: v.id.toString(), name: v.name })),
      agents: agents.map((a) => ({ id: a.id.toString(), name: a.name })),
      tiers: tiers.map((t) => ({ id: t.id.toString(), code: t.code, label: t.label })),
      costHeads: costHeads.map((h) => ({ id: h.id.toString(), name: h.name })),
    };
  });

  const payload: ApiSuccess<RateFormOptions> = {
    success: true,
    data: {
      ...options,
      // The client uses these to decide what to render; the server has already
      // decided what to send. Never the other way round.
      canSeeBuyPrice: canSeeBuyPrice(auth),
      canManageProfit: canManageProfit(auth),
    },
  };
  res.json(payload);
});
