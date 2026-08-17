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
  marginUpdateSchema,
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
import { buildRatePdf, buildRateWorkbook, exportFilename } from '../lib/rate-export';
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
    freeDays: rate.freeDays,
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

/** Midnight today, so a rate valid through today is still valid. */
const startOfToday = (): Date => new Date(new Date().toISOString().slice(0, 10));

/**
 * The §4 rules 2 and 7 filter set, shared by the purchase list and the add-on
 * search. Both screens look at the same rates through different permissions,
 * so the filtering must not drift between them.
 */
function rateWhere(
  query: ReturnType<typeof freightRateListQuerySchema.parse>,
  today: Date,
): Prisma.FreightRateWhereInput {
  return {
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
}

freightRateRouter.get('/rates', requireModePermission('VIEW'), async (req, res) => {
  const auth = req.auth!;
  const query = freightRateListQuerySchema.parse(req.query);
  const today = startOfToday();
  const where = rateWhere(query, today);

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
            freeDays:
              input.freeDays === undefined || input.freeDays === ''
                ? null
                : Number(input.freeDays),
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
// Update — §4 rule 1, "rates are versioned, never overwritten"
//
// A DRAFT is edited in place: nothing downstream can reference it yet.
//
// A PUBLISHED rate is SUPERSEDED. The old row keeps every figure it was
// quoted at and is closed off — valid_to moves to yesterday, status becomes
// EXPIRED, superseded_by_id points at the replacement — and the new values go
// into a new row. The spec calls mutating these in place "the single most
// expensive mistake available in this module", because a quotation issued last
// month must still resolve to the rate that was live when it was issued.
//
// Order matters inside the transaction: the old row is expired BEFORE the new
// one is inserted, or the §4 rule 8 exclusion constraint sees two published
// rates on one lane and refuses the write. That constraint is scoped to
// PUBLISHED precisely so this sequence is possible.
// ===========================================================================

/** Yesterday, or the rate's own start if it has not begun — the CHECK
 *  constraint requires valid_to >= valid_from, and a rate created for a future
 *  period can be superseded before it ever runs. */
function closeOffDate(validFrom: Date, today: Date): Date {
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday < validFrom ? validFrom : yesterday;
}

freightRateRouter.patch('/rates/:id', requireModePermission('EDIT'), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'rate');
  const input = freightRateInputSchema.parse(req.body);
  const mayPrice = canManageProfit(auth);
  const today = startOfToday();

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.freightRate.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, validFrom: true, supersededById: true },
    });
    if (existing === null) throw HttpError.notFound('Rate not found.');
    if (existing.status === 'EXPIRED') {
      throw HttpError.conflict(
        'An expired rate cannot be edited. Buy the lane again as a new rate.',
      );
    }
    if (existing.supersededById !== null) {
      // Belt and braces: an EXPIRED check already covers this, but a superseded
      // row must never sprout a second successor whatever its status says.
      throw HttpError.conflict('That rate has already been superseded.');
    }

    const refs = await assertReferences(db, input);
    const charges = await localChargeRows(db, input, auth.userId);

    const lineData = input.lines.map((line) => ({
      tierId: BigInt(line.tierId),
      buyPrice: line.buyPrice,
      profitType: mayPrice ? (line.profitType ?? 'FLAT') : 'FLAT',
      profitValue: mayPrice ? (line.profitValue || '0') : '0',
      minCharge: line.minCharge === undefined || line.minCharge === '' ? null : line.minCharge,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    }));

    const rateData = {
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
      freeDays:
        input.freeDays === undefined || input.freeDays === '' ? null : Number(input.freeDays),
      remarks: input.remarks === undefined || input.remarks === '' ? null : input.remarks,
      status: input.status,
    };

    // ---- §4 rule 1: supersede rather than mutate ----------------------------
    if (existing.status === 'PUBLISHED') {
      try {
        // Close the old row FIRST, so the exclusion constraint sees one
        // published rate on this lane at a time.
        await db.freightRate.update({
          where: { id },
          data: {
            validTo: closeOffDate(existing.validFrom, today),
            status: 'EXPIRED',
            updatedBy: auth.userId,
          },
        });

        for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
          const code = await nextCode(db, 'freightRate', CODE_PREFIX.freightRate, auth.tenantId);
          try {
            const replacement = await db.freightRate.create({
              data: {
                tenantId: auth.tenantId,
                code,
                ...rateData,
                createdBy: auth.userId,
                updatedBy: auth.userId,
                lines: { createMany: { data: lineData } },
                ...(charges.length > 0 ? { localCharges: { createMany: { data: charges } } } : {}),
              },
              include: rateInclude,
            });

            // The old row now names its successor, so the chain is walkable.
            await db.freightRate.update({
              where: { id },
              data: { supersededById: replacement.id },
            });

            return replacement;
          } catch (error) {
            if (isUniqueViolation(error, 'code')) continue;
            throw error;
          }
        }
        throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not supersede the rate.');
      } catch (error) {
        translateWriteError(error);
      }
    }

    // ---- DRAFT: edited in place, nothing references it yet ------------------
    //
    // Lines are matched to the submitted tiers rather than cleared and
    // rebuilt. §4 rule 3 forbids hard deletes — the tenant client refuses
    // deleteMany outright — and soft-deleting instead would collide with
    // UNIQUE(tenant_id, rate_id, tier_id) the moment the same tier came back.
    // Matching also preserves each line's id, which rate_profit_log points at.
    try {
      const existingLines = await db.freightRateLine.findMany({
        where: { rateId: id, deletedAt: null },
        select: { id: true, tierId: true },
      });
      const lineByTier = new Map(existingLines.map((l) => [l.tierId.toString(), l.id]));
      const submittedTiers = new Set(lineData.map((l) => l.tierId.toString()));

      for (const line of lineData) {
        const existingLineId = lineByTier.get(line.tierId.toString());
        if (existingLineId === undefined) {
          await db.freightRateLine.create({
            data: { tenantId: auth.tenantId, rateId: id, ...line },
          });
        } else {
          await db.freightRateLine.update({
            where: { id: existingLineId },
            data: {
              buyPrice: line.buyPrice,
              profitType: line.profitType,
              profitValue: line.profitValue,
              minCharge: line.minCharge,
              updatedBy: auth.userId,
            },
          });
        }
      }
      // Tiers dropped from the rate are retired, not removed.
      for (const line of existingLines) {
        if (!submittedTiers.has(line.tierId.toString())) {
          await db.freightRateLine.update({
            where: { id: line.id },
            data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
          });
        }
      }

      const existingCharges = await db.rateLocalCharge.findMany({
        where: { rateId: id, deletedAt: null },
        select: { id: true, costHeadId: true, side: true },
      });
      const chargeKey = (costHeadId: bigint | number | string, side: string): string =>
        `${costHeadId.toString()}:${side}`;
      const chargeByKey = new Map(
        existingCharges.map((c) => [chargeKey(c.costHeadId, c.side), c.id]),
      );
      const submittedCharges = new Set(charges.map((c) => chargeKey(c.costHeadId!, c.side!)));

      for (const charge of charges) {
        const key = chargeKey(charge.costHeadId!, charge.side!);
        const existingChargeId = chargeByKey.get(key);
        if (existingChargeId === undefined) {
          await db.rateLocalCharge.create({
            data: { tenantId: auth.tenantId, rateId: id, ...charge },
          });
        } else {
          await db.rateLocalCharge.update({
            where: { id: existingChargeId },
            data: {
              amount: charge.amount,
              currencyId: charge.currencyId,
              costUnitId: charge.costUnitId,
              remarks: charge.remarks,
              updatedBy: auth.userId,
            },
          });
        }
      }
      for (const charge of existingCharges) {
        if (!submittedCharges.has(chargeKey(charge.costHeadId, charge.side))) {
          await db.rateLocalCharge.update({
            where: { id: charge.id },
            data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
          });
        }
      }

      return await db.freightRate.update({
        where: { id },
        data: { ...rateData, updatedBy: auth.userId },
        include: rateInclude,
      });
    } catch (error) {
      translateWriteError(error);
    }
  });

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
// Price Add-on (§5.2) — the screen where margin is set
//
// A separate feature from the purchase screen: a buyer records cost, the
// pricing team adds margin, and neither needs the other's screen. On top of
// its own VIEW/EDIT it requires PURCHASE.RATE.MANAGE_PROFIT, because a
// screen whose entire purpose is setting margin is meaningless without it.
// ===========================================================================

const ADDON_FEATURE_BY_MODE: Record<RateMode, string> = {
  SEA_FCL: 'PURCHASE.PRICE_ADDON_FCL_SEA',
  SEA_LCL: 'PURCHASE.PRICE_ADDON_LCL_SEA',
  AIR: 'PURCHASE.PRICE_ADDON_AIR',
};

function requireAddonPermission(action: string): RequestHandler {
  const guards = new Map<RateMode, RequestHandler>(
    (Object.keys(ADDON_FEATURE_BY_MODE) as RateMode[]).map((mode) => [
      mode,
      requirePermission(`${ADDON_FEATURE_BY_MODE[mode]}.${action}`),
    ]),
  );

  return function addonGuard(req, res, next): void {
    const raw: unknown = req.query['mode'] ?? (req.body as { mode?: unknown } | undefined)?.mode;
    const guard = typeof raw === 'string' ? guards.get(raw as RateMode) : undefined;
    if (guard === undefined) {
      throw HttpError.badRequest('Choose a freight mode.');
    }
    guard(req, res, next);
  };
}

/** §5.2: "Gate the whole screen behind PURCHASE.RATE.MANAGE_PROFIT." */
const requireProfitRights: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (auth === undefined) throw HttpError.unauthorized();
  if (!canManageProfit(auth)) {
    throw HttpError.forbidden('Only the pricing team may set margins.');
  }
  next();
};

freightRateRouter.get(
  '/addon/rates',
  requireAddonPermission('VIEW'),
  requireProfitRights,
  async (req, res) => {
    const auth = req.auth!;
    const query = freightRateListQuerySchema.parse(req.query);
    const today = startOfToday();

    const { rows, total } = await withTenant(auth.tenantId, async (db) => {
      const where = rateWhere(query, today);
      const [rows, total] = await Promise.all([
        db.freightRate.findMany({
          where,
          include: rateInclude,
          orderBy: [{ pol: { name: 'asc' } }, { pod: { name: 'asc' } }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        db.freightRate.count({ where }),
      ]);
      return { rows, total };
    });

    const payload: ApiSuccess<FreightRateDto[]> = {
      success: true,
      // Still stripped. Holding MANAGE_PROFIT does not imply VIEW_BUY_PRICE —
      // a user may be trusted to set a margin without seeing what was paid.
      data: visibleRates(
        rows.map((r) => toDto(r, today)),
        canSeeBuyPrice(auth),
      ),
      meta: buildMeta(query.page, query.limit, total),
    };
    res.json(payload);
  },
);

/**
 * §5.2: commit every edited margin in one transaction.
 *
 * §4 rule 6: "every change writes to rate_profit_log". Unchanged rows are
 * skipped rather than logged, so the log answers "what actually moved" instead
 * of "what was on screen when someone pressed Save".
 *
 * sell_price is never written here. It is a generated column; setting the
 * margin is the only way to move it, which is the guarantee §4 rule 4 buys.
 */
freightRateRouter.patch(
  '/addon/margins',
  requireAddonPermission('EDIT'),
  requireProfitRights,
  async (req, res) => {
    const auth = req.auth!;
    const input = marginUpdateSchema.parse(req.body);

    const ids = input.edits.map((edit) => BigInt(edit.rateLineId));
    if (new Set(ids.map(String)).size !== ids.length) {
      throw HttpError.badRequest('The same rate line was submitted twice.');
    }

    const changed = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.freightRateLine.findMany({
        where: { id: { in: ids }, deletedAt: null, rate: { deletedAt: null, mode: input.mode } },
        select: {
          id: true,
          profitType: true,
          profitValue: true,
          rate: { select: { status: true } },
        },
      });

      // All or nothing, including the lookup: if one line is missing the whole
      // save fails, rather than silently applying the rest.
      if (existing.length !== ids.length) {
        throw HttpError.notFound('One of those rate lines no longer exists.');
      }

      const before = new Map(existing.map((line) => [line.id.toString(), line]));
      let applied = 0;

      for (const edit of input.edits) {
        const previous = before.get(edit.rateLineId)!;

        // §4 rule 1 again: a published rate's price is what quotations quoted.
        if (previous.rate.status === 'EXPIRED') {
          throw HttpError.conflict('An expired rate cannot be re-priced.');
        }

        const sameType = previous.profitType === edit.profitType;
        const sameValue = previous.profitValue.equals(new Prisma.Decimal(edit.profitValue));
        if (sameType && sameValue) continue;

        await db.freightRateLine.update({
          where: { id: BigInt(edit.rateLineId) },
          data: {
            profitType: edit.profitType,
            profitValue: edit.profitValue,
            updatedBy: auth.userId,
          },
        });

        await db.rateProfitLog.create({
          data: {
            tenantId: auth.tenantId,
            rateLineId: BigInt(edit.rateLineId),
            oldProfitType: previous.profitType,
            oldProfitValue: previous.profitValue,
            newProfitType: edit.profitType,
            newProfitValue: edit.profitValue,
            reason: input.reason === undefined || input.reason === '' ? null : input.reason,
            changedBy: auth.userId,
          },
        });
        applied += 1;
      }

      return applied;
    });

    const payload: ApiSuccess<{ changed: number }> = { success: true, data: { changed } };
    res.json(payload);
  },
);

/** The margin history for one line — who moved it, when, and from what. */
freightRateRouter.get(
  '/addon/margins/:id/history',
  requireAddonPermission('VIEW'),
  requireProfitRights,
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'rate line');

    const entries = await withTenant(auth.tenantId, (db) =>
      db.rateProfitLog.findMany({
        where: { rateLineId: id },
        orderBy: { changedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          oldProfitType: true,
          oldProfitValue: true,
          newProfitType: true,
          newProfitValue: true,
          reason: true,
          changedAt: true,
          changedByUser: { select: { username: true } },
        },
      }),
    );

    const payload: ApiSuccess<MarginHistoryEntry[]> = {
      success: true,
      data: entries.map((entry) => ({
        id: entry.id.toString(),
        oldProfitType: entry.oldProfitType,
        oldProfitValue: optionalMoney(entry.oldProfitValue),
        newProfitType: entry.newProfitType,
        newProfitValue: money(entry.newProfitValue),
        reason: entry.reason,
        changedAt: entry.changedAt.toISOString(),
        changedBy: entry.changedByUser?.username ?? 'system',
      })),
    };
    res.json(payload);
  },
);

export interface MarginHistoryEntry {
  id: string;
  oldProfitType: 'FLAT' | 'PERCENT' | null;
  oldProfitValue: string | null;
  newProfitType: 'FLAT' | 'PERCENT';
  newProfitValue: string;
  reason: string | null;
  changedAt: string;
  changedBy: string;
}

// ===========================================================================
// Price List (§5.3) — the screen sales actually lives in
//
// Shows sell price to anyone with VIEW. Buy price and margin appear only with
// PURCHASE.RATE.VIEW_BUY_PRICE, and are absent from the payload otherwise —
// including from the export, which matters more because a file gets forwarded.
// ===========================================================================

const PRICE_LIST_FEATURE_BY_MODE: Record<RateMode, string> = {
  SEA_FCL: 'PURCHASE.PRICE_LIST_SEA_FCL',
  SEA_LCL: 'PURCHASE.PRICE_LIST_SEA_LCL',
  AIR: 'PURCHASE.PRICE_LIST_AIR',
};

function requirePriceListPermission(action: string): RequestHandler {
  const guards = new Map<RateMode, RequestHandler>(
    (Object.keys(PRICE_LIST_FEATURE_BY_MODE) as RateMode[]).map((mode) => [
      mode,
      requirePermission(`${PRICE_LIST_FEATURE_BY_MODE[mode]}.${action}`),
    ]),
  );

  return function priceListGuard(req, res, next): void {
    const raw: unknown = req.query['mode'] ?? (req.body as { mode?: unknown } | undefined)?.mode;
    const guard = typeof raw === 'string' ? guards.get(raw as RateMode) : undefined;
    if (guard === undefined) {
      throw HttpError.badRequest('Choose a freight mode.');
    }
    guard(req, res, next);
  };
}

/** The rows behind both the list and the export, so the two cannot disagree. */
async function priceListRows(
  auth: NonNullable<Parameters<RequestHandler>[0]['auth']>,
  query: ReturnType<typeof freightRateListQuerySchema.parse>,
  limit: number,
): Promise<{ rates: FreightRateDto[]; total: number }> {
  const today = startOfToday();
  const where: Prisma.FreightRateWhereInput = {
    ...rateWhere(query, today),
    // §4 rule 2: the price list shows what sales may actually quote.
    ...(query.status === undefined ? { status: 'PUBLISHED' } : {}),
  };

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const [rows, total] = await Promise.all([
      db.freightRate.findMany({
        where,
        include: rateInclude,
        orderBy: [{ pol: { name: 'asc' } }, { pod: { name: 'asc' } }, { code: 'asc' }],
        skip: (query.page - 1) * limit,
        take: limit,
      }),
      db.freightRate.count({ where }),
    ]);
    return { rows, total };
  });

  return {
    rates: visibleRates(
      rows.map((r) => toDto(r, today)),
      canSeeBuyPrice(auth),
    ),
    total,
  };
}

freightRateRouter.get(
  '/price-list',
  requirePriceListPermission('VIEW'),
  async (req, res) => {
    const auth = req.auth!;
    const query = freightRateListQuerySchema.parse(req.query);
    const { rates, total } = await priceListRows(auth, query, query.limit);

    const payload: ApiSuccess<FreightRateDto[]> = {
      success: true,
      data: rates,
      meta: buildMeta(query.page, query.limit, total),
    };
    res.json(payload);
  },
);

/**
 * §4 rule 12: "produces Excel and PDF of exactly the filtered rows the user is
 * looking at". Same filters, same visibility rules, same rows — the export
 * calls priceListRows rather than re-deriving anything.
 *
 * Capped rather than paginated: a download of one page would be a surprise.
 */
const EXPORT_ROW_CAP = 5000;

freightRateRouter.get(
  '/price-list/export',
  requirePriceListPermission('EXPORT'),
  async (req, res) => {
    const auth = req.auth!;
    const format = req.query['format'] === 'pdf' ? 'pdf' : 'xlsx';
    const query = freightRateListQuerySchema.parse({ ...req.query, page: '1' });

    const { rates, total } = await priceListRows(auth, query, EXPORT_ROW_CAP);
    if (total > EXPORT_ROW_CAP) {
      throw HttpError.badRequest(
        `That is ${total} rates. Narrow the filters to ${EXPORT_ROW_CAP} or fewer before exporting.`,
      );
    }

    const context = await withTenant(auth.tenantId, async (db) => {
      const [tenant, user] = await Promise.all([
        db.tenant.findFirst({ where: { id: auth.tenantId }, select: { name: true } }),
        db.user.findFirst({ where: { id: auth.userId }, select: { username: true } }),
      ]);
      return {
        mode: query.mode,
        rates,
        workspaceName: tenant?.name ?? 'Workspace',
        generatedBy: user?.username ?? 'unknown',
      };
    });

    const filename = exportFilename(query.mode, format);
    const body =
      format === 'pdf' ? await buildRatePdf(context) : await buildRateWorkbook(context);

    res.setHeader(
      'Content-Type',
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  },
);

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
