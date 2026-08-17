import {
  type ApiSuccess,
  buildMeta,
  type InquiryDto,
  inquiryInputSchema,
  inquiryListQuerySchema,
  type InquirySortField,
  INQUIRY_SORT_FIELDS,
  type InquiryVolumeDto,
  type LookupOption,
} from '@ff/shared';
import { Router } from 'express';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextInquiryNo, seriesYearOf } from '../lib/inquiry-no';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Sales — inquiry (docs/MODULE_PURCHASE_SALES.md §5.4).
 *
 * §6 gives New Inquiry and Inquiry List one feature between them: capturing an
 * inquiry and working it are the same permission, and only the action differs.
 *
 * §4 rule 10 is the rule doing real work here: "Salesmen see their own
 * inquiries by default. VIEW_ALL widens it to the whole team. Implement it as a
 * reusable scope, because Quotation, Shipment and Invoice will all need the
 * same thing." So the scoping lives in one function, not in each handler.
 */
export const inquiryRouter: Router = Router();

inquiryRouter.use(authenticate);

const FEATURE = 'SALES.INQUIRY';

const optionalMoney = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(4);
const optionalQty = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(3);
const isoDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

const startOfToday = (): Date => new Date(new Date().toISOString().slice(0, 10));

/**
 * §4 rule 10's row scope, as one reusable clause.
 *
 * A salesman is an employee; a user links to one. Someone with no employee
 * record and no VIEW_ALL sees nothing rather than everything — failing closed
 * is the only safe direction for a visibility rule.
 */
async function scopeClause(
  db: TenantDb,
  auth: { userId: bigint; isSuperadmin: boolean; permissions: ReadonlySet<string> },
  requested: 'OWN' | 'ALL',
): Promise<Prisma.InquiryWhereInput> {
  const maySeeAll = auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`);
  if (requested === 'ALL' && maySeeAll) return {};

  const user = await db.user.findFirst({
    where: { id: auth.userId },
    select: { employeeId: true },
  });

  // A superadmin with no employee record still sees everything; anyone else
  // sees only what they are recorded against.
  if (user?.employeeId == null) {
    return maySeeAll ? {} : { id: BigInt(-1) };
  }
  return { salesmanId: user.employeeId };
}

const inquiryInclude = {
  source: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
  pol: { select: { id: true, name: true, portCode: true } },
  pod: { select: { id: true, name: true, portCode: true } },
  commodityItem: { select: { id: true, name: true } },
  tos: { select: { id: true, name: true } },
  currency: { select: { id: true, currency: true } },
  salesman: { select: { id: true, name: true } },
  volumes: {
    where: { deletedAt: null },
    include: { containerType: { select: { code: true } } },
    orderBy: { id: 'asc' },
  },
  _count: { select: { followups: { where: { deletedAt: null } } } },
} satisfies Prisma.InquiryInclude;

type InquiryWithRelations = Prisma.InquiryGetPayload<{ include: typeof inquiryInclude }>;

const isoCurrency = (value: string): string => (value.split('—')[0] ?? value).trim();

function toDto(inquiry: InquiryWithRelations, today: Date): InquiryDto {
  const volumes: InquiryVolumeDto[] = inquiry.volumes.map((volume) => ({
    id: volume.id.toString(),
    volumeKind: volume.volumeKind,
    containerTypeId: volume.containerTypeId?.toString() ?? null,
    containerTypeCode: volume.containerType?.code ?? null,
    quantity: volume.quantity,
    cbm: optionalQty(volume.cbm),
    weightKg: optionalQty(volume.weightKg),
  }));

  return {
    id: inquiry.id.toString(),
    code: inquiry.code,
    seriesYear: inquiry.seriesYear,
    inquiryDate: isoDate(inquiry.inquiryDate)!,
    sourceId: inquiry.sourceId.toString(),
    sourceName: inquiry.source.name,
    shipmentType: inquiry.shipmentType,
    customerId: inquiry.customerId.toString(),
    customerName: inquiry.customer.name,
    movementType: inquiry.movementType,
    polId: inquiry.polId.toString(),
    polCode: inquiry.pol.portCode,
    polName: inquiry.pol.name,
    podId: inquiry.podId.toString(),
    podCode: inquiry.pod.portCode,
    podName: inquiry.pod.name,
    placeOfReceipt: inquiry.placeOfReceipt,
    commodityItemId: inquiry.commodityItemId?.toString() ?? null,
    commodityName: inquiry.commodityItem?.name ?? null,
    hsCode: inquiry.hsCode,
    tosId: inquiry.tosId?.toString() ?? null,
    tosName: inquiry.tos?.name ?? null,
    targetPrice: optionalMoney(inquiry.targetPrice),
    currencyId: inquiry.currencyId?.toString() ?? null,
    currencyCode:
      inquiry.currency === null ? null : isoCurrency(inquiry.currency.currency),
    expectedShipmentDate: isoDate(inquiry.expectedShipmentDate),
    validTo: isoDate(inquiry.validTo),
    weightKg: optionalQty(inquiry.weightKg),
    remarks: inquiry.remarks,
    salesmanId: inquiry.salesmanId?.toString() ?? null,
    salesmanName: inquiry.salesman?.name ?? null,
    status: inquiry.status,
    quotedPrice: optionalMoney(inquiry.quotedPrice),
    leadId: inquiry.leadId?.toString() ?? null,
    isActive: inquiry.isActive,
    volumes,
    followupCount: inquiry._count.followups,
    // §4 rule 11: past its window but still OPEN. Reported rather than written,
    // so the list can flag it before the job next runs.
    isLapsed:
      inquiry.status === 'OPEN' && inquiry.validTo !== null && inquiry.validTo < today,
  };
}

// ===========================================================================
// Form options (§5.4's field order)
// ===========================================================================

export interface InquiryFormOptions {
  sources: LookupOption[];
  customers: LookupOption[];
  seaPorts: LookupOption[];
  airPorts: LookupOption[];
  commodities: { id: string; name: string; hsCode: string | null }[];
  termsOfShipment: LookupOption[];
  currencies: LookupOption[];
  salesmen: LookupOption[];
  containerTypes: LookupOption[];
  /** §5.4: "Salesman defaults to the logged-in user's employee record." */
  defaultSalesmanId: string | null;
  canSetOutcome: boolean;
  canViewAll: boolean;
}

inquiryRouter.get('/inquiry-options', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;

  const data = await withTenant(auth.tenantId, async (db) => {
    const [sources, customers, ports, commodities, toss, currencies, salesmen, containers, me] =
      await Promise.all([
        db.inquirySource.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.customer.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.port.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true, portCode: true, type: true },
          orderBy: { name: 'asc' },
        }),
        db.commodityItem.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true, hsCode: true },
          orderBy: { name: 'asc' },
        }),
        db.tos.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { code: 'asc' },
        }),
        db.currency.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, currency: true },
          orderBy: { code: 'asc' },
        }),
        db.employee.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.containerType.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, code: true },
          orderBy: { sortOrder: 'asc' },
        }),
        db.user.findFirst({ where: { id: auth.userId }, select: { employeeId: true } }),
      ]);

    const asOption = (p: { id: bigint; portCode: string; name: string }): LookupOption => ({
      id: p.id.toString(),
      name: `${p.portCode} — ${p.name}`,
    });

    return {
      sources: sources.map((s) => ({ id: s.id.toString(), name: s.name })),
      customers: customers.map((c) => ({ id: c.id.toString(), name: c.name })),
      seaPorts: ports.filter((p) => p.type === 'SEAPORT').map(asOption),
      airPorts: ports.filter((p) => p.type === 'AIRPORT').map(asOption),
      commodities: commodities.map((c) => ({
        id: c.id.toString(),
        name: c.name,
        hsCode: c.hsCode,
      })),
      termsOfShipment: toss.map((t) => ({ id: t.id.toString(), name: t.name })),
      currencies: currencies.map((c) => ({ id: c.id.toString(), name: c.currency })),
      salesmen: salesmen.map((e) => ({ id: e.id.toString(), name: e.name })),
      containerTypes: containers.map((c) => ({ id: c.id.toString(), name: c.code })),
      defaultSalesmanId: me?.employeeId?.toString() ?? null,
    };
  });

  const payload: ApiSuccess<InquiryFormOptions> = {
    success: true,
    data: {
      ...data,
      canSetOutcome: auth.isSuperadmin || auth.permissions.has(`${FEATURE}.SET_OUTCOME`),
      canViewAll: auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`),
    },
  };
  res.json(payload);
});

// ===========================================================================
// Create (§5.4)
// ===========================================================================

/** Validates every FK inside the tenant scope, and §4 rule 9's port types. */
async function assertReferences(
  db: TenantDb,
  input: ReturnType<typeof inquiryInputSchema.parse>,
): Promise<{
  sourceId: bigint;
  customerId: bigint;
  polId: bigint;
  podId: bigint;
  commodityItemId: bigint | null;
  tosId: bigint | null;
  currencyId: bigint | null;
  salesmanId: bigint | null;
  leadId: bigint | null;
}> {
  const sourceId = parseRefId(input.sourceId, 'inquiry source');
  const customerId = parseRefId(input.customerId, 'customer');
  const polId = parseRefId(input.polId, 'port of loading');
  const podId = parseRefId(input.podId, 'port of discharge');

  // An air inquiry runs between airports, a sea one between seaports — the
  // same reasoning as §4 rule 9 for rates, enforced server-side.
  const wanted = input.shipmentType === 'AIR' ? 'AIRPORT' : 'SEAPORT';
  const ports = await db.port.findMany({
    where: { id: { in: [polId, podId] }, deletedAt: null, isActive: true },
    select: { id: true, type: true },
  });
  if (ports.length !== 2) throw HttpError.badRequest('Choose two available ports.');
  for (const port of ports) {
    if (port.type !== wanted) {
      throw HttpError.badRequest(
        input.shipmentType === 'AIR'
          ? 'An air inquiry must run between two airports.'
          : 'A sea inquiry must run between two seaports.',
      );
    }
  }

  const [source, customer] = await Promise.all([
    db.inquirySource.findFirst({
      where: { id: sourceId, deletedAt: null, isActive: true },
      select: { id: true },
    }),
    db.customer.findFirst({
      where: { id: customerId, deletedAt: null, isActive: true },
      select: { id: true },
    }),
  ]);
  if (source === null) throw HttpError.badRequest('That inquiry source is not available.');
  if (customer === null) throw HttpError.badRequest('That customer is not available.');

  const optional = async <T>(
    raw: string | undefined,
    label: string,
    find: (id: bigint) => Promise<T | null>,
  ): Promise<bigint | null> => {
    if (raw === undefined || raw === '') return null;
    const id = parseRefId(raw, label);
    if ((await find(id)) === null) throw HttpError.badRequest(`That ${label} is not available.`);
    return id;
  };

  const commodityItemId = await optional(input.commodityItemId, 'commodity', (id) =>
    db.commodityItem.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );
  const tosId = await optional(input.tosId, 'term of shipment', (id) =>
    db.tos.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );
  const currencyId = await optional(input.currencyId, 'currency', (id) =>
    db.currency.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );
  const salesmanId = await optional(input.salesmanId, 'salesman', (id) =>
    db.employee.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );
  const leadId = await optional(input.leadId, 'lead', (id) =>
    db.salesLead.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );

  return {
    sourceId,
    customerId,
    polId,
    podId,
    commodityItemId,
    tosId,
    currencyId,
    salesmanId,
    leadId,
  };
}

/** Drops the grid rows the user left blank rather than storing them as zeros. */
function volumeRows(
  input: ReturnType<typeof inquiryInputSchema.parse>,
  userId: bigint,
): Prisma.InquiryVolumeCreateManyInquiryInput[] {
  return input.volumes
    .filter(
      (v) =>
        (v.quantity !== undefined && v.quantity !== '') ||
        (v.cbm !== undefined && v.cbm !== '') ||
        (v.weightKg !== undefined && v.weightKg !== ''),
    )
    .map((v) => ({
      volumeKind: v.volumeKind,
      containerTypeId:
        v.containerTypeId === undefined || v.containerTypeId === ''
          ? null
          : BigInt(v.containerTypeId),
      quantity: v.quantity === undefined || v.quantity === '' ? null : Number(v.quantity),
      cbm: v.cbm === undefined || v.cbm === '' ? null : v.cbm,
      weightKg: v.weightKg === undefined || v.weightKg === '' ? null : v.weightKg,
      createdBy: userId,
      updatedBy: userId,
    }));
}

inquiryRouter.post('/inquiries', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = inquiryInputSchema.parse(req.body);
  const inquiryDate = new Date(input.inquiryDate);
  const year = seriesYearOf(inquiryDate);

  const created = await withTenant(auth.tenantId, async (db) => {
    const refs = await assertReferences(db, input);
    const volumes = volumeRows(input, auth.userId);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextInquiryNo(db, auth.tenantId, year);
      try {
        return await db.inquiry.create({
          data: {
            tenantId: auth.tenantId,
            code,
            seriesYear: year,
            inquiryDate,
            sourceId: refs.sourceId,
            shipmentType: input.shipmentType,
            customerId: refs.customerId,
            movementType: input.movementType,
            polId: refs.polId,
            podId: refs.podId,
            placeOfReceipt:
              input.placeOfReceipt === undefined || input.placeOfReceipt === ''
                ? null
                : input.placeOfReceipt,
            commodityItemId: refs.commodityItemId,
            hsCode: input.hsCode === undefined || input.hsCode === '' ? null : input.hsCode,
            tosId: refs.tosId,
            targetPrice:
              input.targetPrice === undefined || input.targetPrice === ''
                ? null
                : input.targetPrice,
            currencyId: refs.currencyId,
            expectedShipmentDate:
              input.expectedShipmentDate === undefined || input.expectedShipmentDate === ''
                ? null
                : new Date(input.expectedShipmentDate),
            validTo:
              input.validTo === undefined || input.validTo === '' ? null : new Date(input.validTo),
            weightKg:
              input.weightKg === undefined || input.weightKg === '' ? null : input.weightKg,
            remarks: input.remarks === undefined || input.remarks === '' ? null : input.remarks,
            salesmanId: refs.salesmanId,
            leadId: refs.leadId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
            ...(volumes.length > 0 ? { volumes: { createMany: { data: volumes } } } : {}),
          },
          include: inquiryInclude,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not raise the inquiry. Try again.');
  });

  const payload: ApiSuccess<InquiryDto> = {
    success: true,
    data: toDto(created, startOfToday()),
  };
  res.status(201).json(payload);
});

// ===========================================================================
// Read one
// ===========================================================================

inquiryRouter.get('/inquiries/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'inquiry');

  const inquiry = await withTenant(auth.tenantId, async (db) => {
    const scope = await scopeClause(db, auth, 'OWN');
    const maySeeAll = auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`);
    return db.inquiry.findFirst({
      where: { id, deletedAt: null, ...(maySeeAll ? {} : scope) },
      include: inquiryInclude,
    });
  });
  if (inquiry === null) throw HttpError.notFound('Inquiry not found.');

  const payload: ApiSuccess<InquiryDto> = {
    success: true,
    data: toDto(inquiry, startOfToday()),
  };
  res.json(payload);
});

// ===========================================================================
// List — the filters §5.5 needs; its row actions land in phase I
// ===========================================================================

inquiryRouter.get('/inquiries', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = inquiryListQuerySchema.parse(req.query);
  const today = startOfToday();

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const scope = await scopeClause(db, auth, query.scope);

    const where: Prisma.InquiryWhereInput = {
      deletedAt: null,
      ...scope,
      ...(query.shipmentType !== undefined ? { shipmentType: query.shipmentType } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.polId !== undefined && query.polId !== '' ? { polId: BigInt(query.polId) } : {}),
      ...(query.podId !== undefined && query.podId !== '' ? { podId: BigInt(query.podId) } : {}),
      ...(query.salesmanId !== undefined && query.salesmanId !== ''
        ? { salesmanId: BigInt(query.salesmanId) }
        : {}),
      ...(query.fromDate !== undefined && query.fromDate !== ''
        ? { inquiryDate: { gte: new Date(query.fromDate) } }
        : {}),
      ...(query.toDate !== undefined && query.toDate !== ''
        ? { inquiryDate: { lte: new Date(query.toDate) } }
        : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    // fromDate and toDate both target inquiryDate, so they must merge rather
    // than the second overwriting the first.
    if (
      query.fromDate !== undefined &&
      query.fromDate !== '' &&
      query.toDate !== undefined &&
      query.toDate !== ''
    ) {
      where.inquiryDate = { gte: new Date(query.fromDate), lte: new Date(query.toDate) };
    }

    const sortBy: InquirySortField = INQUIRY_SORT_FIELDS.includes(
      query.sortBy as InquirySortField,
    )
      ? (query.sortBy as InquirySortField)
      : 'inquiryDate';

    const [rows, total] = await Promise.all([
      db.inquiry.findMany({
        where,
        include: inquiryInclude,
        orderBy: { [sortBy]: query.sortOrder === 'asc' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.inquiry.count({ where }),
    ]);
    return { rows, total };
  });

  const payload: ApiSuccess<InquiryDto[]> = {
    success: true,
    data: rows.map((r) => toDto(r, today)),
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});
