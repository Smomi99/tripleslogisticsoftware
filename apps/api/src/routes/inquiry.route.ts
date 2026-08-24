import {
  type InquiryPartyContactDto,
  type ShipmentType,
  type LaneCheckDto,
  type InquiryPartyOption,
  type InquiryPartyDto,
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
  type AgentQuoteCommentDto,
  agentQuoteCommentInputSchema,
  agentQuoteDecisionSchema,
  type StaffAgentQuoteDto,
} from '@ff/shared';
import { Router } from 'express';

import { commentToDto, COMMENT_SELECT } from '../lib/agent-quote-comment';
import { quoteHistory } from '../lib/agent-quote-history';
import { optionToDto, OPTIONS_INCLUDE, type OptionRow } from '../lib/agent-quote-view';
import { recordAudit } from '../lib/audit';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { isoCurrency } from '../lib/currency-label';
import { Prisma } from '../generated/prisma/client';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import { notifyInquiry } from '../lib/inquiry-notify';
import { routeAndApply, type RoutePlan } from '../lib/inquiry-routing';
import { logger } from '../lib/logger';
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
  commodities: {
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
    select: {
      commodityItemId: true,
      hsCode: true,
      commodityItem: { select: { name: true } },
    },
  },
  goodsType: { select: { id: true, name: true } },
  wonAgent: { select: { id: true, name: true } },
  tos: { select: { id: true, name: true } },
  mode: { select: { id: true, name: true } },
  parties: {
    select: {
      id: true,
      agent: { select: { id: true, name: true } },
      carrier: { select: { id: true, name: true } },
    },
  },
  contacts: {
    select: {
      id: true,
      agentPic: { select: { id: true, name: true, email: true, agent: { select: { name: true } } } },
      carrierPic: {
        select: { id: true, name: true, email: true, carrier: { select: { name: true } } },
      },
    },
  },
  currency: { select: { id: true, currency: true } },
  salesman: { select: { id: true, name: true } },
  volumes: {
    where: { deletedAt: null },
    include: {
      containerSize: { select: { code: true } },
      containerType: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  },
  _count: {
    select: {
      followups: { where: { deletedAt: null } },
      // A withdrawn quote is one the agent took back, so it is not an answer
      // and should not raise the count on the row.
      agentQuotes: { where: { deletedAt: null, status: { not: 'WITHDRAWN' } } },
    },
  },
} satisfies Prisma.InquiryInclude;

type InquiryWithRelations = Prisma.InquiryGetPayload<{ include: typeof inquiryInclude }>;


function toDto(inquiry: InquiryWithRelations, today: Date): InquiryDto {
  const volumes: InquiryVolumeDto[] = inquiry.volumes.map((volume) => ({
    id: volume.id.toString(),
    volumeKind: volume.volumeKind,
    containerSizeId: volume.containerSizeId?.toString() ?? null,
    containerSizeCode: volume.containerSize?.code ?? null,
    containerTypeId: volume.containerTypeId?.toString() ?? null,
    containerTypeName: volume.containerType?.name ?? null,
    quantity: volume.quantity,
    cbm: optionalQty(volume.cbm),
    weightKg: optionalQty(volume.weightKg),
    targetPrice: optionalMoney(volume.targetPrice),
    containerSizeNote: volume.containerSizeNote,
  }));

  const parties: InquiryPartyDto[] = inquiry.parties.map((row) => {
    const party = row.agent ?? row.carrier;
    return {
      id: row.id.toString(),
      partyId: (party?.id ?? 0n).toString(),
      name: party?.name ?? '',
    };
  });

  const partyContacts: InquiryPartyContactDto[] = inquiry.contacts.map((row) => {
    const pic = row.agentPic ?? row.carrierPic;
    return {
      id: row.id.toString(),
      contactId: (pic?.id ?? 0n).toString(),
      name: pic?.name ?? '',
      email: pic?.email ?? null,
      partyName: row.agentPic?.agent.name ?? row.carrierPic?.carrier.name ?? '',
    };
  });

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
    commodities: inquiry.commodities.map((c) => ({
      commodityItemId: c.commodityItemId.toString(),
      name: c.commodityItem?.name ?? '',
      hsCode: c.hsCode,
    })),
    goodsTypeId: inquiry.goodsTypeId?.toString() ?? null,
    goodsTypeName: inquiry.goodsType?.name ?? null,
    weightKg: inquiry.weightKg?.toString() ?? null,
    targetPrice: inquiry.targetPrice?.toString() ?? null,
    tosId: inquiry.tosId?.toString() ?? null,
    tosName: inquiry.tos?.name ?? null,
    modeId: inquiry.modeId?.toString() ?? null,
    modeName: inquiry.mode?.name ?? null,
    loadingType: inquiry.loadingType,
    currencyId: inquiry.currencyId?.toString() ?? null,
    currencyCode:
      inquiry.currency === null ? null : isoCurrency(inquiry.currency.currency),
    expectedShipmentDate: isoDate(inquiry.expectedShipmentDate),
    validTo: isoDate(inquiry.validTo),
    remarks: inquiry.remarks,
    salesmanId: inquiry.salesmanId?.toString() ?? null,
    salesmanName: inquiry.salesman?.name ?? null,
    status: inquiry.status,
    quotedPrice: optionalMoney(inquiry.quotedPrice),
    leadId: inquiry.leadId?.toString() ?? null,
    isActive: inquiry.isActive,
    volumes,
    parties,
    partyContacts,
    notifyEmails: inquiry.notifyEmails,
    followupCount: inquiry._count.followups,
    agentQuoteCount: inquiry._count.agentQuotes,
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
  /** How the cargo is sorted for pricing — Textile, Non-Textile, DG. */
  goodsTypes: LookupOption[];
  /** The physical box — Dry, Flat Rack, Open Top, Reefer. */
  containerTypes: LookupOption[];
  /** TOS — the eleven Incoterms. */
  termsOfShipment: LookupOption[];
  /** Mode — the CY/CY family. */
  modes: LookupOption[];
  currencies: LookupOption[];
  salesmen: LookupOption[];
  containerSizes: LookupOption[];
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
    const [sources, customers, ports, commodities, modes, goodsTypes, containerTypes, toss, currencies, salesmen, containers, me] =
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
        db.mode.findMany({
          where: { ...excludeInactive(inactive, 'mode'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { code: 'asc' },
        }),
        db.goodsType.findMany({
          where: { ...excludeInactive(inactive, 'goods_type'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.containerType.findMany({
          where: { ...excludeInactive(inactive, 'container_type'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { sortOrder: 'asc' },
        }),
        db.tos.findMany({
          where: { ...excludeInactive(inactive, 'tos'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          // EXW…DDP is a sequence, not an alphabet. sortOrder moved onto this
          // table with the swap, so the list can finally read in its own order.
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
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
        db.containerSize.findMany({
          where: { ...excludeInactive(inactive, 'container_size'), deletedAt: null, isActive: true },
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
      modes: modes.map((m) => ({ id: m.id.toString(), name: m.name })),
      goodsTypes: goodsTypes.map((g) => ({ id: g.id.toString(), name: g.name })),
      containerTypes: containerTypes.map((c) => ({ id: c.id.toString(), name: c.name })),
      termsOfShipment: toss.map((t) => ({ id: t.id.toString(), name: t.name })),
      currencies: currencies.map((c) => ({ id: c.id.toString(), name: c.currency })),
      salesmen: salesmen.map((e) => ({ id: e.id.toString(), name: e.name })),
      containerSizes: containers.map((c) => ({ id: c.id.toString(), name: c.code })),
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
  goodsTypeId: bigint | null;
  tosId: bigint | null;
  modeId: bigint | null;
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

  const goodsTypeId = await optional(input.goodsTypeId, 'goods type', (id) =>
    db.goodsType.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );
  const tosId = await optional(input.tosId, 'Incoterm', (id) =>
    db.tos.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
  );
  const modeId = await optional(input.modeId, 'mode', (id) =>
    db.mode.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true } }),
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
    goodsTypeId,
    tosId,
    modeId,
    currencyId,
    salesmanId,
    leadId,
  };
}

/** Drops the grid rows the user left blank rather than storing them as zeros. */
/** A decimal string from the wire, or null when the box was left blank. */
function decimalOrNull(value: string | undefined): Prisma.Decimal | null {
  return value === undefined || value === '' ? null : new Prisma.Decimal(value);
}

/**
 * The commodity rows an inquiry carries.
 *
 * Built from the request rather than merged with what is stored: the form sends
 * the whole list every time, and a commodity the operator removed has to
 * actually go. §5.3's rule for quotation lines, applied one level up.
 */
function commodityRows(
  input: ReturnType<typeof inquiryInputSchema.parse>,
  auth: { tenantId: bigint; userId: bigint },
): { commodityItemId: bigint; hsCode: string | null; createdBy: bigint; updatedBy: bigint }[] {
  // No tenantId: nested under inquiry.create Prisma takes it from the parent,
  // and at the top level the tenant extension injects it. Passing it by hand
  // is refused in the first case and redundant in the second.
  return (input.commodities ?? []).map((row) => ({
    commodityItemId: BigInt(row.commodityItemId),
    hsCode: row.hsCode === undefined || row.hsCode === '' ? null : row.hsCode,
    createdBy: auth.userId,
    updatedBy: auth.userId,
  }));
}

function volumeRows(
  input: ReturnType<typeof inquiryInputSchema.parse>,
  userId: bigint,
): Prisma.InquiryVolumeCreateManyInquiryInput[] {
  return input.volumes
    .filter(
      (v) =>
        (v.quantity !== undefined && v.quantity !== '') ||
        (v.cbm !== undefined && v.cbm !== '') ||
        (v.weightKg !== undefined && v.weightKg !== '') ||
        // A column may carry only a price or a note — the quantity can arrive
        // later, and dropping the row would silently lose what was typed.
        (v.targetPrice !== undefined && v.targetPrice !== '') ||
        (v.containerSizeNote !== undefined && v.containerSizeNote !== ''),
    )
    .map((v) => ({
      volumeKind: v.volumeKind,
      containerSizeId:
        v.containerSizeId === undefined || v.containerSizeId === ''
          ? null
          : BigInt(v.containerSizeId),
      containerTypeId:
        v.containerTypeId === undefined || v.containerTypeId === ''
          ? null
          : BigInt(v.containerTypeId),
      quantity: v.quantity === undefined || v.quantity === '' ? null : Number(v.quantity),
      cbm: v.cbm === undefined || v.cbm === '' ? null : v.cbm,
      weightKg: v.weightKg === undefined || v.weightKg === '' ? null : v.weightKg,
      targetPrice: v.targetPrice === undefined || v.targetPrice === '' ? null : v.targetPrice,
      containerSizeNote:
        v.containerSizeNote === undefined || v.containerSizeNote === ''
          ? null
          : v.containerSizeNote,
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
/**
 * Rewrites who an inquiry goes to.
 *
 * Wholesale rather than diffed, the way the volume grid is not: these rows
 * carry no history of their own — no id anyone quotes, no audit value — so
 * replacing them is honest and a diff would be ceremony. §4 rule 3 governs
 * business records, and the migration grants ff_app DELETE here for exactly
 * this, as it does on the other join tables.
 *
 * Inbound writes agents, Outbound writes customers. The ids are validated
 * against the right table first, so a client sending a customer id on an
 * Inbound inquiry is refused rather than silently storing nothing.
 */
async function writeParties(
  db: TenantDb,
  auth: { tenantId: bigint; userId: bigint },
  inquiryId: bigint,
  input: ReturnType<typeof inquiryInputSchema.parse>,
): Promise<void> {
  const inbound = input.movementType === 'INBOUND';
  const partyIds = [...new Set(input.partyIds)].map((v) => BigInt(v));
  const contactIds = [...new Set(input.partyContactIds)].map((v) => BigInt(v));

  if (partyIds.length > 0) {
    const found = inbound
      ? await db.agent.findMany({ where: { id: { in: partyIds }, deletedAt: null }, select: { id: true } })
      : await db.carrier.findMany({ where: { id: { in: partyIds }, deletedAt: null }, select: { id: true } });
    if (found.length !== partyIds.length) {
      throw HttpError.badRequest(
        inbound ? 'One of those agents is not available.' : 'One of those carriers is not available.',
      );
    }
  }

  if (contactIds.length > 0) {
    const found = inbound
      ? await db.agentPic.findMany({ where: { id: { in: contactIds }, deletedAt: null }, select: { id: true } })
      : await db.carrierPic.findMany({ where: { id: { in: contactIds }, deletedAt: null }, select: { id: true } });
    if (found.length !== contactIds.length) {
      throw HttpError.badRequest('One of those contacts is not available.');
    }
  }

  await db.$executeRaw`DELETE FROM inquiry_party WHERE inquiry_id = ${inquiryId} AND tenant_id = ${auth.tenantId}`;
  await db.$executeRaw`DELETE FROM inquiry_party_contact WHERE inquiry_id = ${inquiryId} AND tenant_id = ${auth.tenantId}`;

  if (partyIds.length > 0) {
    await db.inquiryParty.createMany({
      data: partyIds.map((partyId) => ({
        tenantId: auth.tenantId,
        inquiryId,
        agentId: inbound ? partyId : null,
        carrierId: inbound ? null : partyId,
        createdBy: auth.userId,
      })),
    });
  }

  if (contactIds.length > 0) {
    await db.inquiryPartyContact.createMany({
      data: contactIds.map((contactId) => ({
        tenantId: auth.tenantId,
        inquiryId,
        agentPicId: inbound ? contactId : null,
        carrierPicId: inbound ? null : contactId,
        createdBy: auth.userId,
      })),
    });
  }
}

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
    select: { id: true, volumeKind: true, containerSizeId: true },
  });

  const keyOf = (kind: string, containerSizeId: bigint | number | null | undefined): string =>
    `${kind}:${containerSizeId?.toString() ?? '-'}`;
  const byKey = new Map(existing.map((row) => [keyOf(row.volumeKind, row.containerSizeId), row.id]));

  for (const row of wanted) {
    const key = keyOf(row.volumeKind, row.containerSizeId ?? null);
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

  /*
   * Commodities are replaced rather than reconciled row by row.
   *
   * The form sends the whole list every time, and the only interesting change
   * is which commodities are on it. Soft-deleting the old set and writing the
   * new one keeps §4 rule 3 and leaves the partial unique index free to accept
   * a commodity that was removed and then put back — which reconciling in place
   * would collide with.
   */
  const wantedCommodities = commodityRows(input, auth);
  await db.inquiryCommodity.updateMany({
    where: { inquiryId: id, deletedAt: null },
    data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
  });
  if (wantedCommodities.length > 0) {
    await db.inquiryCommodity.createMany({
      // tenantId by hand here: this call is top level, where the type requires
      // it. Nested under inquiry.create it must be left out instead.
      data: wantedCommodities.map((row) => ({ ...row, tenantId: auth.tenantId, inquiryId: id })),
    });
  }

  await writeParties(db, auth, id, input);

  const updated = await db.inquiry.update({
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
      goodsTypeId: refs.goodsTypeId,
      weightKg: decimalOrNull(input.weightKg),
      targetPrice: decimalOrNull(input.targetPrice),
      tosId: refs.tosId,
      modeId: refs.modeId,
      loadingType: input.loadingType ?? null,
      notifyEmails: input.notifyEmails || null,
      currencyId: refs.currencyId,
      expectedShipmentDate: input.expectedShipmentDate
        ? new Date(input.expectedShipmentDate)
        : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
      remarks: input.remarks || null,
      salesmanId: refs.salesmanId,
      leadId: refs.leadId,
      updatedBy: auth.userId,
    },
    include: inquiryInclude,
  });

  // §5.1 again: an edit can move the lane, the goods type or who it was shared
  // with, so the routing is re-decided rather than left as it was.
  const plan = await routeAndApply(db, updated.id);
  const row = await db.inquiry.findFirstOrThrow({ where: { id }, include: inquiryInclude });
  return { row, plan };
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
        const created = await db.inquiry.create({
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
            goodsTypeId: refs.goodsTypeId,
            weightKg: decimalOrNull(input.weightKg),
            targetPrice: decimalOrNull(input.targetPrice),
            tosId: refs.tosId,
            modeId: refs.modeId,
            loadingType: input.loadingType ?? null,
            notifyEmails: input.notifyEmails || null,
            currencyId: refs.currencyId,
            expectedShipmentDate:
              input.expectedShipmentDate === undefined || input.expectedShipmentDate === ''
                ? null
                : new Date(input.expectedShipmentDate),
            validTo:
              input.validTo === undefined || input.validTo === '' ? null : new Date(input.validTo),
            remarks: input.remarks === undefined || input.remarks === '' ? null : input.remarks,
            salesmanId: refs.salesmanId,
            leadId: refs.leadId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
            ...(volumes.length > 0 ? { volumes: { createMany: { data: volumes } } } : {}),
            ...(commodityRows(input, auth).length > 0
              ? { commodities: { createMany: { data: commodityRows(input, auth) } } }
              : {}),
          },
          include: inquiryInclude,
        });

        // Recipients are written after the row exists, since they reference it.
        // Same transaction, so a failure here takes the inquiry with it.
        await writeParties(db, auth, created.id, input);
        // §5.1 runs here rather than after the commit, so the row can never be
        // seen with a status that disagrees with its own routing.
        const plan = await routeAndApply(db, created.id);
        const row = await db.inquiry.findFirstOrThrow({
          where: { id: created.id },
          include: inquiryInclude,
        });
        return { row, plan };
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not raise the inquiry. Try again.');
  });

  const dto = toDto(created.row, startOfToday());
  await notifyAfterSave(auth, dto, created.plan);

  const payload: ApiSuccess<InquiryDto> = { success: true, data: dto };
  res.status(201).json(payload);
});

// ===========================================================================
// Read one
// ===========================================================================

/**
 * GET /api/tenant/sales/inquiry-parties?movement=INBOUND|OUTBOUND
 *
 * The parties an inquiry can be sent to, each with its own contacts and their
 * addresses. One request rather than a fetch per selected party: the set is
 * small, and it lets the contact list and the email box react the instant a
 * party is ticked instead of after a round trip.
 */
/**
 * GET /api/tenant/sales/lane-check?polId=&podId=&shipmentType=
 *
 * Is there already a buying rate for this lane?
 *
 * Same rule the §5.5 Price action uses, so the two screens can never disagree:
 * PUBLISHED, the right mode for the shipment type, the same POL and POD, and
 * valid today. A rate whose validity has passed does NOT count as a match —
 * you cannot quote from it, so the operator still has to go and ask.
 *
 * Returns which of the three it is, because "expired" and "nothing at all" lead
 * to the same next step but are not the same fact, and the screen says so.
 */
/**
 * Tells whoever needs to know that this inquiry wants a price.
 *
 * Runs AFTER the transaction, on purpose. A mail server being unreachable must
 * not roll back an inquiry that saved correctly, so this is deliberately not
 * awaited inside withTenant and its failures never reach the response.
 */
async function notifyAfterSave(
  auth: { tenantId: bigint; userId: bigint },
  dto: InquiryDto,
  plan: RoutePlan,
): Promise<void> {
  try {
    await withTenant(auth.tenantId, async (db) => {
      const result = await notifyInquiry(db, {
        tenantId: auth.tenantId,
        actorId: auth.userId,
        inquiryId: BigInt(dto.id),
        code: dto.code,
        movementType: dto.movementType,
        polLabel: `${dto.polCode} ${dto.polName}`,
        podLabel: `${dto.podCode} ${dto.podName}`,
        customerName: dto.customerName,
        appUrl: env.APP_URL ?? null,
        plan,
      });

      /*
       * Mark the agents as told, so the share row can answer "did the RFQ
       * actually go out?" — the question §4.2's share tracking exists for.
       * Only when something was queued: on the lane-already-priced path the
       * inquiry is shared but nobody was chased, and saying otherwise would
       * make the screen claim a message that does not exist.
       */
      if (result.kind === 'agents' && result.queued) {
        await db.inquiryParty.updateMany({
          where: { inquiryId: BigInt(dto.id), agentId: { not: null } },
          data: { notifiedAt: new Date(), status: 'SHARED' },
        });
      }
      return result;
    });
  } catch (error) {
    logger.warn({ err: error, code: dto.code }, 'inquiry notification failed; the inquiry is saved');
  }
}

inquiryRouter.get('/lane-check', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const polId = req.query['polId'];
  const podId = req.query['podId'];
  const shipmentType = req.query['shipmentType'];

  if (typeof polId !== 'string' || !/^\d+$/.test(polId) ||
      typeof podId !== 'string' || !/^\d+$/.test(podId)) {
    throw HttpError.badRequest('Choose both ports.');
  }
  const type: ShipmentType = shipmentType === 'AIR' ? 'AIR' : 'SEA';

  const result = await withTenant(auth.tenantId, async (db) => {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const lane = {
      deletedAt: null,
      status: 'PUBLISHED' as const,
      mode: { in: MODES_FOR[type] },
      polId: BigInt(polId),
      podId: BigInt(podId),
    };

    const live = await db.freightRate.count({
      where: { ...lane, validFrom: { lte: today }, validTo: { gte: today } },
    });
    if (live > 0) return { status: 'MATCHED' as const, count: live, latestValidTo: null };

    // Nothing live. Was there something, and when did it lapse? The newest
    // expiry is the useful one to show — it says how stale the lane has gone.
    const lapsed = await db.freightRate.findFirst({
      where: { ...lane, validTo: { lt: today } },
      select: { validTo: true },
      orderBy: { validTo: 'desc' },
    });
    if (lapsed !== null) {
      return {
        status: 'EXPIRED' as const,
        count: 0,
        latestValidTo: lapsed.validTo.toISOString().slice(0, 10),
      };
    }
    return { status: 'NONE' as const, count: 0, latestValidTo: null };
  });

  const payload: ApiSuccess<LaneCheckDto> = { success: true, data: result };
  res.json(payload);
});

inquiryRouter.get('/inquiry-parties', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const inbound = req.query['movement'] !== 'OUTBOUND';
  const polId = req.query['polId'];

  const parties = await withTenant(auth.tenantId, async (db) => {
    /*
     * Inbound cargo comes from overseas, so the agent you need is at the
     * ORIGIN — the client's "country specific agent". Narrowed by the POL's
     * country when a POL is known, and left wide open when it is not, because
     * an empty picker is worse than a long one.
     */
    let country: string | null = null;
    if (inbound && typeof polId === 'string' && /^\d+$/.test(polId)) {
      const pol = await db.port.findFirst({
        where: { id: BigInt(polId), deletedAt: null },
        select: { country: true },
      });
      country = pol?.country ?? null;
    }
    const shape = {
      where: { deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        pics: {
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true, email: true },
          orderBy: { name: 'asc' as const },
        },
      },
      orderBy: { name: 'asc' as const },
    };
    if (!inbound) return db.carrier.findMany(shape);
    const agents = await db.agent.findMany({
      ...shape,
      where: { ...shape.where, ...(country === null ? {} : { country }) },
    });
    // Falling back to every agent beats showing none: the country may simply
    // not have been filled in on the agent records yet.
    if (agents.length > 0 || country === null) return agents;
    return db.agent.findMany(shape);
  });

  const payload: ApiSuccess<InquiryPartyOption[]> = {
    success: true,
    data: parties.map((party) => ({
      id: party.id.toString(),
      name: party.name,
      contacts: party.pics.map((pic) => ({
        id: pic.id.toString(),
        name: pic.name,
        email: pic.email,
      })),
    })),
  };
  res.json(payload);
});

/**
 * GET /api/tenant/sales/inquiries/:id/agent-quotes
 *
 * What the agents came back with. The mirror of the portal's submit route —
 * without it a quote lands in the database and nobody at the forwarder can see
 * it, which is the state this endpoint was written to fix.
 *
 * Each quote carries its amendment history, read from the audit trail. An agent
 * who drops their price from 1450 to 1399 the day before a decision is telling
 * you something, and "what did they change" should not require a DBA.
 */
inquiryRouter.get(
  '/inquiries/:id/agent-quotes',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');

    const quotes = await withTenant(auth.tenantId, async (db) => {
      // The same visibility rule the inquiry itself obeys: a salesman who
      // cannot see the inquiry cannot see what was quoted against it.
      const scope = await scopeClause(db, auth, 'OWN');
      const maySeeAll = auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`);
      const inquiry = await db.inquiry.findFirst({
        where: { id, deletedAt: null, ...(maySeeAll ? {} : scope) },
        select: { id: true },
      });
      if (inquiry === null) return null;

      const rows = await db.agentQuote.findMany({
        where: { inquiryId: id, deletedAt: null },
        select: {
          id: true,
          code: true,
          agentId: true,
          amount: true,
          currencyId: true,
          validUntil: true,
          transitDays: true,
          remarks: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          agent: { select: { name: true } },
          currency: { select: { currency: true } },
          submittedByUser: { select: { username: true, email: true } },
          options: OPTIONS_INCLUDE,
        },
        // Was ordered by amount, which is null on every quote that carries a
        // breakdown — the figures moved to the lines and there is no single
        // number left to sort on. Newest first instead, which is the order a
        // buyer reads them in anyway.
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });

      // Currency ids in the audit snapshots mean nothing on screen; this turns
      // them back into USD, BDT and so on.
      const currencies = await db.currency.findMany({ select: { id: true, currency: true } });
      const currencyNames = new Map(currencies.map((c) => [c.id.toString(), c.currency]));

      const history = await quoteHistory(
        db,
        rows.map((r) => r.id),
        { currencyNames },
      );

      return rows.map<StaffAgentQuoteDto>((row) => ({
        id: row.id.toString(),
        code: row.code,
        agentId: row.agentId.toString(),
        agentName: row.agent?.name ?? '—',
        submittedByName: row.submittedByUser?.username ?? null,
        options: (row.options as unknown as OptionRow[]).map(optionToDto),
        amount: row.amount?.toString() ?? '',
        currencyId: row.currencyId.toString(),
        currencyCode: row.currency === null ? null : isoCurrency(row.currency.currency),
        validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
        transitDays: row.transitDays,
        remarks: row.remarks,
        status: row.status,
        submittedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        history: history.get(row.id.toString()) ?? [],
      }));
    });

    if (quotes === null) throw HttpError.notFound('Inquiry not found.');

    const payload: ApiSuccess<StaffAgentQuoteDto[]> = { success: true, data: quotes };
    res.json(payload);
  },
);

/**
 * POST /api/tenant/sales/inquiries/:id/agent-quotes/:quoteId/decision
 *
 * Answering an agent. Guarded by ATTACH_PRICE rather than a new action:
 * deciding which supplier's price the inquiry carries is the same commercial
 * decision the Price drawer already makes, taken by the same people.
 *
 * Deliberately reversible while the inquiry is still live. Won and Lost are one
 * mis-click apart, and once a quote leaves SUBMITTED the agent can no longer
 * amend it — so a one-way door here would strand them behind a mistake nobody
 * at the forwarder could undo.
 *
 * What it deliberately does NOT do is settle the other agents. Whether winning
 * on one offer loses it for the rest is a business rule nobody has stated, and
 * a forwarder may well place two bookings for different equipment.
 *
 * The message posted with it is the whole point of the client's note: an agent
 * who is told only "lost" learns nothing and prices you the same way next time.
 * It is required on a loss and optional on a win, and it lands in the same
 * thread both sides have been talking in — flagged as the outcome, so it reads
 * as the end of the conversation rather than another remark.
 */
inquiryRouter.post(
  '/inquiries/:id/agent-quotes/:quoteId/decision',
  requirePermission(`${FEATURE}.ATTACH_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const quoteId = parseId(req.params.quoteId, 'quote');
    const { decision, comment } = agentQuoteDecisionSchema.parse(req.body);

    const updated = await withTenant(auth.tenantId, async (db) => {
      const inquiry = await findScopedInquiry(db, auth, id);
      if (inquiry.status === 'WON' || inquiry.status === 'LOST') {
        throw HttpError.conflict(`${inquiry.code} is already ${inquiry.status}.`);
      }

      const quote = await db.agentQuote.findFirst({
        where: { id: quoteId, inquiryId: id, deletedAt: null },
        select: { id: true, status: true },
      });
      if (quote === null) throw HttpError.notFound('That quote no longer exists.');
      if (quote.status === 'WITHDRAWN') {
        throw HttpError.conflict('That quote was withdrawn by the agent.');
      }

      await db.agentQuote.update({
        where: { id: quoteId },
        data: { status: decision, updatedBy: auth.userId },
      });

      // Same transaction as the status change: an outcome the agent is never
      // told about is the failure this feature exists to prevent, so it is not
      // allowed to be a separate write that can fail on its own.
      const body = (comment ?? '').trim();
      if (body !== '') {
        await db.agentQuoteComment.create({
          data: {
            tenantId: auth.tenantId,
            quoteId,
            authorId: auth.userId,
            body,
            outcome: decision,
          },
        });
      }
      return quote.id;
    });

    await recordAudit({
      tenantId: auth.tenantId,
      action: decision === 'WON' ? 'QUOTE_ACCEPTED' : 'QUOTE_DECLINED',
      tableName: 'agent_quote',
      recordId: updated,
      actorId: auth.userId,
      details: { inquiryId: id.toString() },
    });

    const payload: ApiSuccess<{ decision: string }> = { success: true, data: { decision } };
    res.json(payload);
  },
);

/**
 * The Status thread, from the forwarder's side.
 *
 * GET  /api/tenant/sales/inquiries/:id/agent-quotes/:quoteId/comments
 * POST /api/tenant/sales/inquiries/:id/agent-quotes/:quoteId/comments
 *
 * The same conversation the agent reads, through the door staff already have.
 * Reading needs VIEW; writing needs ATTACH_PRICE — posting to a supplier in the
 * company's name is the same class of act as deciding which supplier to use,
 * and it is not something a read-only viewer should be able to do.
 */
inquiryRouter.get(
  '/inquiries/:id/agent-quotes/:quoteId/comments',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const quoteId = parseId(req.params.quoteId, 'quote');

    const result = await withTenant(auth.tenantId, async (db) => {
      // Reuses the inquiry's own visibility rule: a salesman who cannot see the
      // inquiry cannot read what was said about its quotes.
      const inquiry = await findScopedInquiry(db, auth, id);
      const quote = await db.agentQuote.findFirst({
        where: { id: quoteId, inquiryId: inquiry.id, deletedAt: null },
        select: { id: true },
      });
      if (quote === null) return null;
      const rows = await db.agentQuoteComment.findMany({
        where: { quoteId: quote.id },
        orderBy: { createdAt: 'asc' },
        select: COMMENT_SELECT,
      });
      const tenant = await db.tenant.findFirst({
        where: { id: auth.tenantId },
        select: { name: true },
      });
      return { rows, forwarderName: tenant?.name ?? 'Us' };
    });
    if (result === null) throw HttpError.notFound('That quote no longer exists.');

    const payload: ApiSuccess<AgentQuoteCommentDto[]> = {
      success: true,
      data: result.rows.map((row) => commentToDto(row, 'STAFF', result.forwarderName)),
    };
    res.json(payload);
  },
);

inquiryRouter.post(
  '/inquiries/:id/agent-quotes/:quoteId/comments',
  requirePermission(`${FEATURE}.ATTACH_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'inquiry');
    const quoteId = parseId(req.params.quoteId, 'quote');
    const input = agentQuoteCommentInputSchema.parse(req.body);

    const result = await withTenant(auth.tenantId, async (db) => {
      const inquiry = await findScopedInquiry(db, auth, id);
      const quote = await db.agentQuote.findFirst({
        where: { id: quoteId, inquiryId: inquiry.id, deletedAt: null },
        select: { id: true },
      });
      if (quote === null) return null;
      const created = await db.agentQuoteComment.create({
        data: {
          tenantId: auth.tenantId,
          quoteId: quote.id,
          authorId: auth.userId,
          body: input.body,
        },
        select: COMMENT_SELECT,
      });
      const tenant = await db.tenant.findFirst({
        where: { id: auth.tenantId },
        select: { name: true },
      });
      return { created, forwarderName: tenant?.name ?? 'Us' };
    });
    if (result === null) throw HttpError.notFound('That quote no longer exists.');

    const payload: ApiSuccess<AgentQuoteCommentDto> = {
      success: true,
      data: commentToDto(result.created, 'STAFF', result.forwarderName),
    };
    res.status(201).json(payload);
  },
);

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

  const dto = toDto(updated.row, startOfToday());
  await notifyAfterSave(auth, dto, updated.plan);

  const payload: ApiSuccess<InquiryDto> = { success: true, data: dto };
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
