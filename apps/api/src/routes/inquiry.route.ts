import {
  type ApiSuccess,
  buildMeta,
  type InquiryDto,
  type InquiryFollowupDto,
  inquiryFollowupInputSchema,
  inquiryInputSchema,
  inquiryListQuerySchema,
  type InquiryRateDto,
  inquiryRateAttachSchema,
  type InquiryRateMatchDto,
  inquiryRateSelectSchema,
  type InquirySortField,
  INQUIRY_SORT_FIELDS,
  inquiryStatusInputSchema,
  OUTCOME_STATUSES,
  type InquiryVolumeDto,
  type LookupOption,
} from '@ff/shared';
import { Router } from 'express';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { nextInquiryNo, seriesYearOf } from '../lib/inquiry-no';
import { canSeeBuyPrice, visibleLine } from '../lib/rate-visibility';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticate } from '../middleware/authenticate';
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
    // Shared rows this workspace switched off are recorded as overrides, not on
    // the rows themselves (§7A rule 7), so `isActive` alone still offers them.
    const inactive = await inactiveMasters(db);
    const [sources, customers, ports, commodities, toss, currencies, salesmen, containers, me] =
      await Promise.all([
        db.inquirySource.findMany({
          where: { ...excludeInactive(inactive, 'inquiry_source'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.customer.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.port.findMany({
          where: { ...excludeInactive(inactive, 'port'), deletedAt: null, isActive: true },
          select: { id: true, name: true, portCode: true, type: true },
          orderBy: { name: 'asc' },
        }),
        db.commodityItem.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true, hsCode: true },
          orderBy: { name: 'asc' },
        }),
        db.tos.findMany({
          where: { ...excludeInactive(inactive, 'tos'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { code: 'asc' },
        }),
        db.currency.findMany({
          where: { ...excludeInactive(inactive, 'currency'), deletedAt: null, isActive: true },
          select: { id: true, currency: true },
          orderBy: { code: 'asc' },
        }),
        db.employee.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.containerType.findMany({
          where: { ...excludeInactive(inactive, 'container_type'), deletedAt: null, isActive: true },
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
  const inactivePorts = await inactiveMasters(db);
  const ports = await db.port.findMany({
    where: {
      AND: [{ id: { in: [polId, podId] } }, excludeInactive(inactivePorts, 'port')],
      deletedAt: null,
      isActive: true,
    },
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

/**
 * Rewrites an inquiry from the §5.4 form.
 *
 * Volumes are matched and rewritten rather than deleted and recreated: §4
 * rule 3 forbids the hard delete, and the tenant client refuses deleteMany
 * outright. Rows the new input drops are deactivated, not removed.
 */
async function updateInquiry(
  db: TenantDb,
  auth: { tenantId: bigint; userId: bigint },
  id: bigint,
  input: ReturnType<typeof inquiryInputSchema.parse>,
) {
  const refs = await assertReferences(db, input);
  const wanted = volumeRows(input, auth.userId);
  const existing = await db.inquiryVolume.findMany({
    where: { inquiryId: id, deletedAt: null },
    select: { id: true, volumeKind: true, containerTypeId: true },
  });

  const keyOf = (kind: string, containerTypeId: bigint | number | null | undefined): string =>
    `${kind}:${containerTypeId?.toString() ?? '-'}`;
  const byKey = new Map(existing.map((row) => [keyOf(row.volumeKind, row.containerTypeId), row.id]));

  for (const row of wanted) {
    const key = keyOf(row.volumeKind, row.containerTypeId ?? null);
    const match = byKey.get(key);
    if (match === undefined) {
      await db.inquiryVolume.create({ data: { ...row, tenantId: auth.tenantId, inquiryId: id } });
    } else {
      await db.inquiryVolume.update({
        where: { id: match },
        data: {
          quantity: row.quantity ?? null,
          cbm: row.cbm ?? null,
          weightKg: row.weightKg ?? null,
          isActive: true,
          updatedBy: auth.userId,
        },
      });
      byKey.delete(key);
    }
  }
  for (const orphan of byKey.values()) {
    await db.inquiryVolume.update({
      where: { id: orphan },
      data: { isActive: false, updatedBy: auth.userId },
    });
  }

  return db.inquiry.update({
    where: { id },
    data: {
      inquiryDate: new Date(input.inquiryDate),
      sourceId: refs.sourceId,
      shipmentType: input.shipmentType,
      customerId: refs.customerId,
      movementType: input.movementType,
      polId: refs.polId,
      podId: refs.podId,
      placeOfReceipt: input.placeOfReceipt || null,
      commodityItemId: refs.commodityItemId,
      hsCode: input.hsCode || null,
      tosId: refs.tosId,
      targetPrice: input.targetPrice || null,
      currencyId: refs.currencyId,
      expectedShipmentDate: input.expectedShipmentDate
        ? new Date(input.expectedShipmentDate)
        : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
      weightKg: input.weightKg || null,
      remarks: input.remarks || null,
      salesmanId: refs.salesmanId,
      leadId: refs.leadId,
      updatedBy: auth.userId,
    },
    include: inquiryInclude,
  });
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

// ===========================================================================
// §5.5 row actions
//
// Each is its own permission, per the table in §5.5. View and Edit read and
// write the inquiry itself; Follow Up, Price and Quote each move it along the
// pipeline, and none of them is implied by being able to see the list.
// ===========================================================================

function followupToDto(row: {
  id: bigint;
  followupDate: Date;
  contactMode: 'CALL' | 'EMAIL' | 'VISIT' | 'WHATSAPP';
  contactPerson: string | null;
  notes: string | null;
  nextFollowupDate: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
}): InquiryFollowupDto {
  return {
    id: row.id.toString(),
    followupDate: isoDate(row.followupDate)!,
    contactMode: row.contactMode,
    contactPerson: row.contactPerson,
    notes: row.notes,
    nextFollowupDate: isoDate(row.nextFollowupDate),
    createdBy: row.createdBy?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The inquiry, if this caller is allowed to work it. */
async function findScopedInquiry(db: TenantDb, auth: AuthContext, id: bigint) {
  const scope = await scopeClause(db, auth, 'OWN');
  const maySeeAll = auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`);
  const inquiry = await db.inquiry.findFirst({
    where: { id, deletedAt: null, ...(maySeeAll ? {} : scope) },
    select: {
      id: true,
      code: true,
      status: true,
      shipmentType: true,
      polId: true,
      podId: true,
      validTo: true,
    },
  });
  if (inquiry === null) throw HttpError.notFound('Inquiry not found.');
  return inquiry;
}

// --------------------------------------------------------------- Edit

inquiryRouter.patch('/inquiries/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'inquiry');
  const input = inquiryInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await findScopedInquiry(db, auth, id);
    // §5.5: "Edit form; blocked once status is WON." A won inquiry is the
    // record the business books revenue against; changing its lane or price
    // afterwards rewrites history.
    if (existing.status === 'WON') {
      throw HttpError.conflict(
        `${existing.code} is marked WON and can no longer be edited. Set it back to QUOTED first if this is wrong.`,
      );
    }
    return updateInquiry(db, auth, id, input);
  });

  const payload: ApiSuccess<InquiryDto> = { success: true, data: toDto(updated, startOfToday()) };
  res.json(payload);
});

// ---------------------------------------------------------- Follow Up(n)

inquiryRouter.get(
  '/inquiries/:id/followups',
  requirePermission(`${FEATURE}.FOLLOWUP`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');

    const rows = await withTenant(auth.tenantId, async (db) => {
      await findScopedInquiry(db, auth, id);
      return db.inquiryFollowup.findMany({
        where: { inquiryId: id, deletedAt: null },
        orderBy: [{ followupDate: 'desc' }, { id: 'desc' }],
      });
    });

    const payload: ApiSuccess<InquiryFollowupDto[]> = {
      success: true,
      data: rows.map(followupToDto),
    };
    res.json(payload);
  },
);

inquiryRouter.post(
  '/inquiries/:id/followups',
  requirePermission(`${FEATURE}.FOLLOWUP`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const input = inquiryFollowupInputSchema.parse(req.body);

    const created = await withTenant(auth.tenantId, async (db) => {
      await findScopedInquiry(db, auth, id);
      return db.inquiryFollowup.create({
        data: {
          tenantId: auth.tenantId,
          inquiryId: id,
          followupDate: new Date(input.followupDate),
          contactMode: input.contactMode,
          contactPerson: input.contactPerson || null,
          notes: input.notes || null,
          nextFollowupDate:
            input.nextFollowupDate === undefined || input.nextFollowupDate === ''
              ? null
              : new Date(input.nextFollowupDate),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
      });
    });

    const payload: ApiSuccess<InquiryFollowupDto> = {
      success: true,
      data: followupToDto(created),
    };
    res.status(201).json(payload);
  },
);

/**
 * sell_price is a GENERATED column (§4 rule 4), so Prisma types it nullable
 * even though buy_price and profit_value are both NOT NULL and the expression
 * cannot produce null. The existing rate screens format a missing one as
 * 0.0000; a quote may not. Quoting a customer zero because a column came back
 * empty is precisely the class of silent failure §4 rule 1 is written about.
 */
function sellPriceOf(line: { sellPrice: Prisma.Decimal | null }): Prisma.Decimal {
  if (line.sellPrice === null) {
    throw new HttpError(
      500,
      'RATE_SELL_PRICE_MISSING',
      'That rate has no sell price. Ask the pricing team to re-save it before quoting.',
    );
  }
  return line.sellPrice;
}

// ------------------------------------------------------------------ Price

/** Sea inquiries can quote either FCL or LCL; air has one mode. */
const MODES_FOR: Record<'SEA' | 'AIR', ('SEA_FCL' | 'SEA_LCL' | 'AIR')[]> = {
  SEA: ['SEA_FCL', 'SEA_LCL'],
  AIR: ['AIR'],
};

/**
 * §5.5 Price: "Opens matching rates for that lane/mode/validity."
 *
 * Validity follows §4 rule 2 — only rates live today, and only PUBLISHED ones.
 * A quote built on an expired or draft rate is a number the company cannot
 * honour.
 */
inquiryRouter.get(
  '/inquiries/:id/matching-rates',
  requirePermission(`${FEATURE}.ATTACH_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const today = startOfToday();

    const matches = await withTenant(auth.tenantId, async (db) => {
      const inquiry = await findScopedInquiry(db, auth, id);
      return db.freightRate.findMany({
        where: {
          deletedAt: null,
          status: 'PUBLISHED',
          mode: { in: MODES_FOR[inquiry.shipmentType] },
          polId: inquiry.polId,
          podId: inquiry.podId,
          validFrom: { lte: today },
          validTo: { gte: today },
        },
        include: {
          carrier: { select: { name: true } },
          currency: { select: { currency: true } },
          lines: {
            where: { deletedAt: null },
            include: { tier: { select: { code: true, label: true } } },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: [{ carrier: { name: 'asc' } }, { code: 'asc' }],
        take: 50,
      });
    });

    const showBuy = canSeeBuyPrice(auth);
    const payload: ApiSuccess<InquiryRateMatchDto[]> = {
      success: true,
      data: matches.map((rate) => ({
        rateId: rate.id.toString(),
        rateCode: rate.code,
        carrierName: rate.carrier.name,
        validFrom: isoDate(rate.validFrom)!,
        validTo: isoDate(rate.validTo)!,
        currencyCode: isoCurrency(rate.currency.currency),
        transitDays: rate.transitDays,
        freeDays: rate.freeDays,
        // §4 rule 5 — the enforcement point, not a formatting choice.
        lines: rate.lines.map((line) =>
          visibleLine(
            {
              id: line.id.toString(),
              tierId: line.tierId.toString(),
              tierCode: line.tier.code,
              tierLabel: line.tier.label,
              sellPrice: sellPriceOf(line).toFixed(4),
              minCharge: line.minCharge === null ? null : line.minCharge.toFixed(4),
              buyPrice: line.buyPrice.toFixed(4),
              profitType: line.profitType,
              profitValue: line.profitValue.toFixed(4),
            },
            showBuy,
          ),
        ),
      })),
    };
    res.json(payload);
  },
);

const attachedInclude = {
  rateLine: { include: { tier: { select: { label: true } } } },
  rate: {
    select: {
      code: true,
      status: true,
      validTo: true,
      supersededById: true,
      carrier: { select: { name: true } },
      currency: { select: { currency: true } },
    },
  },
} satisfies Prisma.InquiryRateInclude;

function attachedToDto(
  row: Prisma.InquiryRateGetPayload<{ include: typeof attachedInclude }>,
  today: Date,
): InquiryRateDto {
  return {
    id: row.id.toString(),
    rateId: row.rateId.toString(),
    rateCode: row.rate.code,
    rateLineId: row.rateLineId.toString(),
    tierLabel: row.rateLine.tier.label,
    carrierName: row.rate.carrier.name,
    currencyCode: isoCurrency(row.rate.currency.currency),
    quotedPrice: row.quotedPrice.toFixed(4),
    isSelected: row.isSelected,
    // The snapshot is still what was quoted; this only tells the user the
    // underlying rate has moved on (§4 rule 1).
    isStale:
      row.rate.supersededById !== null ||
      row.rate.status !== 'PUBLISHED' ||
      row.rate.validTo < today,
  };
}

/** Writes the selected line's price onto the inquiry (§5.5 Price). */
async function syncQuotedPrice(db: TenantDb, auth: AuthContext, inquiryId: bigint): Promise<void> {
  const selected = await db.inquiryRate.findFirst({
    where: { inquiryId, deletedAt: null, isSelected: true },
    select: { quotedPrice: true },
  });
  await db.inquiry.update({
    where: { id: inquiryId },
    data: { quotedPrice: selected?.quotedPrice ?? null, updatedBy: auth.userId },
  });
}

async function attachedRates(db: TenantDb, inquiryId: bigint) {
  return db.inquiryRate.findMany({
    where: { inquiryId, deletedAt: null },
    include: attachedInclude,
    orderBy: [{ isSelected: 'desc' }, { id: 'asc' }],
  });
}

inquiryRouter.get(
  '/inquiries/:id/rates',
  requirePermission(`${FEATURE}.ATTACH_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');

    const rows = await withTenant(auth.tenantId, async (db) => {
      await findScopedInquiry(db, auth, id);
      return attachedRates(db, id);
    });

    const payload: ApiSuccess<InquiryRateDto[]> = {
      success: true,
      data: rows.map((row) => attachedToDto(row, startOfToday())),
    };
    res.json(payload);
  },
);

inquiryRouter.post(
  '/inquiries/:id/rates',
  requirePermission(`${FEATURE}.ATTACH_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const input = inquiryRateAttachSchema.parse(req.body);

    const rows = await withTenant(auth.tenantId, async (db) => {
      const inquiry = await findScopedInquiry(db, auth, id);
      if (inquiry.status === 'WON') {
        throw HttpError.conflict(`${inquiry.code} is marked WON. Its pricing is settled.`);
      }

      for (const rateLineId of input.rateLineIds) {
        const line = await db.freightRateLine.findFirst({
          where: { id: BigInt(rateLineId), deletedAt: null },
          select: {
            id: true,
            rateId: true,
            sellPrice: true,
            rate: { select: { polId: true, podId: true, status: true } },
          },
        });
        if (line === null) throw HttpError.badRequest('That rate is no longer available.');
        // The lane is re-checked server-side: the picker filtered by it, and a
        // filtered picker is a convenience, not a constraint (§4 rule 9).
        if (line.rate.polId !== inquiry.polId || line.rate.podId !== inquiry.podId) {
          throw HttpError.badRequest('That rate is for a different lane.');
        }
        if (line.rate.status !== 'PUBLISHED') {
          throw HttpError.badRequest('That rate is not published.');
        }

        const already = await db.inquiryRate.findFirst({
          where: { inquiryId: id, rateLineId: line.id },
          select: { id: true },
        });
        if (already !== null) {
          // Re-attaching something previously removed revives it rather than
          // colliding with the unique index — §4 rule 3 leaves the row behind.
          await db.inquiryRate.update({
            where: { id: already.id },
            data: {
              deletedAt: null,
              isActive: true,
              quotedPrice: sellPriceOf(line),
              updatedBy: auth.userId,
            },
          });
          continue;
        }
        await db.inquiryRate.create({
          data: {
            tenantId: auth.tenantId,
            inquiryId: id,
            rateId: line.rateId,
            rateLineId: line.id,
            quotedPrice: sellPriceOf(line),
            addedBy: auth.userId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
        });
      }

      // The cheapest line attached becomes the quoted one, so an inquiry never
      // sits with rates attached and no price. The user can move it after.
      const anySelected = await db.inquiryRate.count({
        where: { inquiryId: id, deletedAt: null, isSelected: true },
      });
      if (anySelected === 0) {
        const cheapest = await db.inquiryRate.findFirst({
          where: { inquiryId: id, deletedAt: null },
          orderBy: { quotedPrice: 'asc' },
          select: { id: true },
        });
        if (cheapest !== null) {
          await db.inquiryRate.update({
            where: { id: cheapest.id },
            data: { isSelected: true, updatedBy: auth.userId },
          });
        }
      }
      await syncQuotedPrice(db, auth, id);
      return attachedRates(db, id);
    });

    const payload: ApiSuccess<InquiryRateDto[]> = {
      success: true,
      data: rows.map((row) => attachedToDto(row, startOfToday())),
    };
    res.status(201).json(payload);
  },
);

/** Moves which attached line the inquiry quotes. */
inquiryRouter.post(
  '/inquiries/:id/rates/select',
  requirePermission(`${FEATURE}.ATTACH_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const input = inquiryRateSelectSchema.parse(req.body);

    const rows = await withTenant(auth.tenantId, async (db) => {
      await findScopedInquiry(db, auth, id);
      const target = await db.inquiryRate.findFirst({
        where: { id: BigInt(input.inquiryRateId), inquiryId: id, deletedAt: null },
        select: { id: true },
      });
      if (target === null) throw HttpError.notFound('That rate is not attached to this inquiry.');

      await db.inquiryRate.updateMany({
        where: { inquiryId: id, deletedAt: null, isSelected: true },
        data: { isSelected: false, updatedBy: auth.userId },
      });
      await db.inquiryRate.update({
        where: { id: target.id },
        data: { isSelected: true, updatedBy: auth.userId },
      });
      await syncQuotedPrice(db, auth, id);
      return attachedRates(db, id);
    });

    const payload: ApiSuccess<InquiryRateDto[]> = {
      success: true,
      data: rows.map((row) => attachedToDto(row, startOfToday())),
    };
    res.json(payload);
  },
);

// ----------------------------------------------------------------- Status

inquiryRouter.post(
  '/inquiries/:id/status',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const input = inquiryStatusInputSchema.parse(req.body);

    // §9 Q10, answered: WON and LOST are the numbers the business is measured
    // on, so they need SET_OUTCOME. Everything else is ordinary EDIT. The route
    // guard cannot express this — which permission applies depends on the body.
    const isOutcome = OUTCOME_STATUSES.includes(input.status);
    const needed = isOutcome ? `${FEATURE}.SET_OUTCOME` : `${FEATURE}.EDIT`;
    if (!auth.isSuperadmin && !auth.permissions.has(needed)) {
      throw HttpError.forbidden(
        isOutcome
          ? 'Only a user who may set an outcome can mark an inquiry WON or LOST.'
          : 'You do not have permission to change this inquiry.',
      );
    }

    const updated = await withTenant(auth.tenantId, async (db) => {
      await findScopedInquiry(db, auth, id);
      await db.inquiry.update({
        where: { id },
        data: { status: input.status, updatedBy: auth.userId },
      });
      if (input.reason !== undefined && input.reason !== '') {
        // The reason belongs on the follow-up trail, which is where anyone
        // reviewing a lost inquiry will go looking for it.
        await db.inquiryFollowup.create({
          data: {
            tenantId: auth.tenantId,
            inquiryId: id,
            followupDate: startOfToday(),
            contactMode: 'CALL',
            notes: `Status set to ${input.status}: ${input.reason}`,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
        });
      }
      return db.inquiry.findFirstOrThrow({ where: { id }, include: inquiryInclude });
    });

    const payload: ApiSuccess<InquiryDto> = { success: true, data: toDto(updated, startOfToday()) };
    res.json(payload);
  },
);

// ------------------------------------------------------------------ Quote

/**
 * §5.5 Quote: "Creates a quotation from the inquiry and sets status QUOTED."
 *
 * Only the second half happens here. The quotation record is §3.4, which is
 * phase J and stops at a stub — the client's Quotation sheet ends after six
 * fields, and §9 Q11 is still open on everything past them.
 */
inquiryRouter.post(
  '/inquiries/:id/quote',
  requirePermission(`${FEATURE}.CONVERT_QUOTE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');

    const updated = await withTenant(auth.tenantId, async (db) => {
      const inquiry = await findScopedInquiry(db, auth, id);
      if (inquiry.status === 'WON' || inquiry.status === 'LOST') {
        throw HttpError.conflict(`${inquiry.code} is already ${inquiry.status}.`);
      }
      const priced = await db.inquiryRate.count({
        where: { inquiryId: id, deletedAt: null, isSelected: true },
      });
      if (priced === 0) {
        throw HttpError.badRequest(
          'Attach a rate with Price before quoting, so the quotation has a figure.',
        );
      }
      await db.inquiry.update({
        where: { id },
        data: { status: 'QUOTED', updatedBy: auth.userId },
      });
      return db.inquiry.findFirstOrThrow({ where: { id }, include: inquiryInclude });
    });

    const payload: ApiSuccess<InquiryDto> = { success: true, data: toDto(updated, startOfToday()) };
    res.json(payload);
  },
);
