import {
  airportLabel,
  type ApiSuccess,
  buildMeta,
  CLOSED_LEAD_STATUSES,
  CONVERSION_PENDING_STATUSES,
  isoCurrency,
  type LeadFollowupDue,
  type LeadShipmentMode,
  portLabel,
  type SalesLeadActivityDto,
  salesLeadActivityQuerySchema,
  type SalesLeadDocumentDto,
  salesLeadDocumentUploadSchema,
  type SalesLeadDto,
  type SalesLeadDueDto,
  salesLeadDueQuerySchema,
  type SalesLeadFollowupDto,
  salesLeadFollowupInputSchema,
  type SalesLeadFollowupPayload,
  type SalesLeadFormOptions,
  salesLeadInputSchema,
  type SalesLeadKpiDto,
  salesLeadKpiQuerySchema,
  salesLeadListQuerySchema,
  type SalesLeadStatus,
} from '@ff/shared';
import { Router } from 'express';

import { CODE_RETRY_LIMIT, inSavepoint, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextSalesLeadNo, seriesYearOf } from '../lib/inquiry-no';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { parseId, parseRefId } from '../lib/request';
import { displayNameFromKey, openFile, putFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { tenantDayOf } from '../lib/tenant-day';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Sales leads — "Sales Lead-FOB" and "Sales Lead follow up" on the menu.
 *
 * The client's FOB Sales Lead Form (docs/SALES_LEAD_FOB.md); § numbers below
 * are that form's sections. §8's master-data pattern throughout: search, sort,
 * pagination, Edit plus an Active/Inactive toggle rather than a delete, and
 * child screens scoped to the parent by URL.
 *
 * Every user holding VIEW sees every lead. The form names a lead owner but
 * states no rule that a salesperson sees only their own, so none is invented;
 * the register filters by salesperson instead.
 */
export const salesLeadRouter: Router = Router();

salesLeadRouter.use(authenticate);

const LEAD_FEATURE = 'SALES.NEW_SALES_LEAD';
const FOLLOWUP_FEATURE = 'SALES.SALES_LEAD_FOLLOWUP';

const isoDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);
const decimalString = (value: Prisma.Decimal | null, places = 4): string | null =>
  value === null ? null : value.toFixed(places);
const blank = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();
const decimalOrNull = (value: string | undefined): Prisma.Decimal | null =>
  value === undefined || value === '' ? null : new Prisma.Decimal(value);
const dateOrNull = (value: string | undefined): Date | null =>
  value === undefined || value === '' ? null : new Date(value);

/** Adds days to a YYYY-MM-DD string, in UTC so no zone moves it. */
function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Today, as the workspace's clock reads it. Follow-ups are due on its days. */
async function tenantToday(db: TenantDb, tenantId: bigint): Promise<string> {
  return (await tenantDayOf(db, tenantId))(new Date());
}

// ===========================================================================
// Mapping
// ===========================================================================

const portSelect = { select: { name: true, portCode: true, type: true, country: true } } as const;

const leadInclude = {
  source: { select: { name: true } },
  owner: { select: { name: true, department: true } },
  customer: { select: { name: true } },
  commodityItem: { select: { name: true } },
  pol: portSelect,
  pod: portSelect,
  containerSize: { select: { code: true, teuFactor: true } },
  currentCarrier: { select: { name: true } },
  currency: { select: { currency: true } },
  _count: {
    select: {
      followups: { where: { deletedAt: null } },
      inquiries: { where: { deletedAt: null } },
      documents: { where: { deletedAt: null } },
    },
  },
} satisfies Prisma.SalesLeadInclude;

type LeadRow = Prisma.SalesLeadGetPayload<{ include: typeof leadInclude }>;

function shipmentModeOf(row: {
  shipmentType: 'SEA' | 'AIR' | null;
  loadingType: 'FCL' | 'LCL' | 'CONSOL_BOX' | null;
}): LeadShipmentMode | null {
  if (row.shipmentType === 'AIR') return 'AIR';
  if (row.shipmentType === 'SEA' && row.loadingType === 'FCL') return 'SEA_FCL';
  if (row.shipmentType === 'SEA' && row.loadingType !== null) return 'SEA_LCL';
  return null;
}

function placeOf(port: { name: string; portCode: string; type: string } | null): string | null {
  if (port === null) return null;
  return port.type === 'AIRPORT' ? airportLabel(port) : portLabel(port);
}

interface Forecast {
  monthlyRevenue: Prisma.Decimal | null;
  monthlyProfit: Prisma.Decimal | null;
  weightedProfit: Prisma.Decimal | null;
  monthlyTeu: Prisma.Decimal | null;
}

/**
 * §4's "Calculated opportunity value": the volume is monthly, the figures are
 * per unit. In NUMERIC throughout, so the register's totals add up to the cent.
 */
function forecastOf(row: {
  shipmentType: 'SEA' | 'AIR' | null;
  loadingType: 'FCL' | 'LCL' | 'CONSOL_BOX' | null;
  monthlyVolume: Prisma.Decimal | null;
  revenuePerUnit: Prisma.Decimal | null;
  profitPerUnit: Prisma.Decimal | null;
  winProbability: number | null;
  containerSize: { teuFactor: Prisma.Decimal } | null;
}): Forecast {
  const volume = row.monthlyVolume;
  const monthlyRevenue =
    volume !== null && row.revenuePerUnit !== null ? volume.mul(row.revenuePerUnit) : null;
  const monthlyProfit =
    volume !== null && row.profitPerUnit !== null ? volume.mul(row.profitPerUnit) : null;
  return {
    monthlyRevenue,
    monthlyProfit,
    weightedProfit:
      monthlyProfit !== null && row.winProbability !== null
        ? monthlyProfit.mul(row.winProbability).div(100)
        : null,
    monthlyTeu:
      shipmentModeOf(row) === 'SEA_FCL' && volume !== null && row.containerSize !== null
        ? volume.mul(row.containerSize.teuFactor)
        : null,
  };
}

function toDto(lead: LeadRow): SalesLeadDto {
  const forecast = forecastOf(lead);
  return {
    id: lead.id.toString(),
    code: lead.code,
    isActive: lead.isActive,
    createdAt: lead.createdAt.toISOString(),

    leadDate: isoDate(lead.leadDate)!,
    sourceId: lead.sourceId?.toString() ?? null,
    sourceName: lead.source?.name ?? null,
    ownerId: lead.ownerId?.toString() ?? null,
    ownerName: lead.owner?.name ?? null,
    ownerDepartment: lead.owner?.department ?? null,
    businessType: lead.businessType,
    priority: lead.priority,

    name: lead.name,
    customerId: lead.customerId?.toString() ?? null,
    customerName: lead.customer?.name ?? null,
    exporterContact: lead.exporterContact,
    exporterMobile: lead.exporterMobile,
    exporterEmail: lead.exporterEmail,
    factoryLocation: lead.factoryLocation,
    buyerName: lead.buyerName,
    buyerCustomerId: lead.buyerCustomerId?.toString() ?? null,
    buyerCountry: lead.buyerCountry,
    buyingHouse: lead.buyingHouse,
    agentName: lead.agentName,
    agentId: lead.agentId?.toString() ?? null,
    agentCountry: lead.agentCountry,
    agentContact: lead.agentContact,

    commodityItemId: lead.commodityItemId?.toString() ?? null,
    commodityName: lead.commodityItem?.name ?? null,
    shipmentMode: shipmentModeOf(lead),
    polId: lead.polId?.toString() ?? null,
    polName: placeOf(lead.pol),
    podId: lead.podId?.toString() ?? null,
    podName: placeOf(lead.pod),
    podCountry: lead.pod?.country ?? null,
    containerSizeId: lead.containerSizeId?.toString() ?? null,
    containerSizeName: lead.containerSize?.code ?? null,
    monthlyVolume: decimalString(lead.monthlyVolume, 3),
    shipmentFrequency: lead.shipmentFrequency,
    firstShipmentDate: isoDate(lead.firstShipmentDate),
    incumbentForwarder: lead.incumbentForwarder,
    currentCarrierId: lead.currentCarrierId?.toString() ?? null,
    currentCarrierName: lead.currentCarrier?.name ?? null,
    requirements: lead.requirements,

    freightControl: lead.freightControl,
    status: lead.status,
    currency: lead.currency === null ? null : isoCurrency(lead.currency.currency),
    revenuePerUnit: decimalString(lead.revenuePerUnit),
    profitPerUnit: decimalString(lead.profitPerUnit),
    marketRatePerUnit: decimalString(lead.marketRatePerUnit),
    marketRateSource: lead.marketRateSource,
    winProbability: lead.winProbability,
    nextFollowupDate: isoDate(lead.nextFollowupDate),
    outcomeReason: lead.outcomeReason,
    closedAt: lead.closedAt?.toISOString() ?? null,

    forecast: {
      monthlyRevenue: decimalString(forecast.monthlyRevenue, 2),
      monthlyProfit: decimalString(forecast.monthlyProfit, 2),
      weightedProfit: decimalString(forecast.weightedProfit, 2),
      monthlyTeu: decimalString(forecast.monthlyTeu, 2),
    },

    followupCount: lead._count.followups,
    inquiryCount: lead._count.inquiries,
    documentCount: lead._count.documents,
  };
}

// ===========================================================================
// Shared filters
// ===========================================================================

const OPEN_STATUSES: SalesLeadStatus[] = ['NEW', 'QUALIFIED', 'RATE_REQUESTED', 'QUOTED', 'NEGOTIATION'];

/** The leads still being worked: active, and neither won nor lost. */
const openLeadWhere: Prisma.SalesLeadWhereInput = {
  deletedAt: null,
  isActive: true,
  status: { in: OPEN_STATUSES },
};

/** One follow-up bucket as a `where`, against the workspace's today. */
function dueWhere(due: LeadFollowupDue, today: string): Prisma.SalesLeadWhereInput {
  switch (due) {
    case 'OVERDUE':
      return { nextFollowupDate: { lt: new Date(today) } };
    case 'TODAY':
      return { nextFollowupDate: new Date(today) };
    case 'UPCOMING':
      return { nextFollowupDate: { gt: new Date(today), lte: new Date(addDays(today, 7)) } };
    case 'UNSCHEDULED':
      return { nextFollowupDate: null };
  }
}

function dueOf(nextFollowupDate: Date | null, today: string): LeadFollowupDue {
  const day = isoDate(nextFollowupDate);
  if (day === null) return 'UNSCHEDULED';
  if (day < today) return 'OVERDUE';
  if (day === today) return 'TODAY';
  return 'UPCOMING';
}

// ===========================================================================
// Form options
// ===========================================================================

/**
 * The US dollar row. §4 writes every per-unit figure in USD, and §4 rule 6
 * stores the currency beside the amount, so this is the currency the API sets.
 */
async function usdCurrencyId(db: TenantDb): Promise<{ id: bigint; label: string } | null> {
  const rows = await db.currency.findMany({
    where: { deletedAt: null, currency: { startsWith: 'USD' } },
    select: { id: true, currency: true, tenantId: true },
  });
  // A workspace's own USD row wins over the shared one, if it made one.
  const row =
    rows.find((r) => isoCurrency(r.currency) === 'USD' && r.tenantId !== null) ??
    rows.find((r) => isoCurrency(r.currency) === 'USD');
  return row === undefined ? null : { id: row.id, label: 'USD' };
}

salesLeadRouter.get(
  '/lead-form-options',
  requirePermission(`${LEAD_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;

    const data = await withTenant(auth.tenantId, async (db) => {
      const inactive = await inactiveMasters(db);
      const [sources, owners, customers, agents, commodities, ports, sizes, carriers, me, usd] =
        await Promise.all([
          db.inquirySource.findMany({
            where: { ...excludeInactive(inactive, 'inquiry_source'), deletedAt: null, isActive: true },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          }),
          db.employee.findMany({
            where: { deletedAt: null, isActive: true },
            select: { id: true, name: true, department: true },
            orderBy: { name: 'asc' },
          }),
          db.customer.findMany({
            where: { deletedAt: null, isActive: true },
            select: {
              id: true,
              name: true,
              country: true,
              address: true,
              pics: {
                where: { deletedAt: null, isActive: true },
                select: { name: true, mobile: true, email: true },
                orderBy: { id: 'asc' },
                take: 1,
              },
            },
            orderBy: { name: 'asc' },
          }),
          db.agent.findMany({
            where: { deletedAt: null, isActive: true },
            select: {
              id: true,
              name: true,
              country: true,
              pics: {
                where: { deletedAt: null, isActive: true },
                select: { name: true, email: true },
                orderBy: { id: 'asc' },
                take: 1,
              },
            },
            orderBy: { name: 'asc' },
          }),
          db.commodityItem.findMany({
            where: { deletedAt: null, isActive: true },
            select: { id: true, name: true, hsCode: true },
            orderBy: { name: 'asc' },
          }),
          db.port.findMany({
            where: { ...excludeInactive(inactive, 'port'), deletedAt: null, isActive: true },
            select: { id: true, name: true, portCode: true, type: true, country: true },
            orderBy: { name: 'asc' },
          }),
          db.containerSize.findMany({
            where: { ...excludeInactive(inactive, 'container_size'), deletedAt: null, isActive: true },
            select: { id: true, code: true, teuFactor: true },
            orderBy: { sortOrder: 'asc' },
          }),
          db.carrier.findMany({
            where: { ...excludeInactive(inactive, 'carrier'), deletedAt: null, isActive: true },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          }),
          db.user.findFirst({ where: { id: auth.userId }, select: { employeeId: true } }),
          usdCurrencyId(db),
        ]);

      const options: SalesLeadFormOptions = {
        sources: sources.map((s) => ({ id: s.id.toString(), name: s.name })),
        owners: owners.map((e) => ({ id: e.id.toString(), name: e.name, department: e.department })),
        customers: customers.map((c) => ({
          id: c.id.toString(),
          name: c.name,
          country: c.country,
          address: c.address,
          contact: c.pics[0] ?? null,
        })),
        agents: agents.map((a) => ({
          id: a.id.toString(),
          name: a.name,
          country: a.country,
          contact: a.pics[0] ?? null,
        })),
        commodities: commodities.map((c) => ({ id: c.id.toString(), name: c.name, hsCode: c.hsCode })),
        seaPorts: ports
          .filter((p) => p.type === 'SEAPORT')
          .map((p) => ({ id: p.id.toString(), name: portLabel(p), country: p.country })),
        // Airports lead with the IATA code, so they sort by it too.
        airPorts: ports
          .filter((p) => p.type === 'AIRPORT')
          .sort((a, b) => a.portCode.localeCompare(b.portCode))
          .map((p) => ({ id: p.id.toString(), name: airportLabel(p), country: p.country })),
        containerSizes: sizes.map((s) => ({
          id: s.id.toString(),
          name: s.code,
          teuFactor: s.teuFactor.toFixed(2),
        })),
        carriers: carriers.map((c) => ({ id: c.id.toString(), name: c.name })),
        defaultOwnerId: me?.employeeId?.toString() ?? null,
        currency: usd?.label ?? null,
      };
      return options;
    });

    const payload: ApiSuccess<SalesLeadFormOptions> = { success: true, data };
    res.json(payload);
  },
);

// ===========================================================================
// Leads — the register (§7)
// ===========================================================================

salesLeadRouter.get('/leads', requirePermission(`${LEAD_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = salesLeadListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const today = query.due === undefined ? null : await tenantToday(db, auth.tenantId);

    const where: Prisma.SalesLeadWhereInput = {
      AND: [
        { deletedAt: null },
        query.isActive !== undefined ? { isActive: query.isActive } : {},
        query.status === 'OPEN'
          ? { status: { in: OPEN_STATUSES } }
          : query.status === 'CLOSED'
            ? { status: { in: [...CLOSED_LEAD_STATUSES] } }
            : query.status !== undefined
              ? { status: query.status }
              : {},
        query.ownerId !== undefined ? { ownerId: BigInt(query.ownerId) } : {},
        query.freightControl !== undefined ? { freightControl: query.freightControl } : {},
        // A due filter means "what needs a call", so it only ever finds open leads.
        query.due !== undefined && today !== null
          ? { ...openLeadWhere, ...dueWhere(query.due, today) }
          : {},
        query.search !== undefined
          ? {
              OR: [
                { code: { contains: query.search, mode: 'insensitive' } },
                { name: { contains: query.search, mode: 'insensitive' } },
                { buyerName: { contains: query.search, mode: 'insensitive' } },
                { buyingHouse: { contains: query.search, mode: 'insensitive' } },
                { agentName: { contains: query.search, mode: 'insensitive' } },
                { incumbentForwarder: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    // A register reads newest first; id breaks ties between leads of one day.
    const orderBy: Prisma.SalesLeadOrderByWithRelationInput[] =
      query.sortBy === 'nextFollowupDate'
        ? [{ nextFollowupDate: { sort: query.sortOrder, nulls: 'last' } }, { id: 'desc' }]
        : [{ [query.sortBy]: query.sortOrder }, { id: 'desc' }];

    const [rows, total] = await Promise.all([
      db.salesLead.findMany({
        where,
        include: leadInclude,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.salesLead.count({ where }),
    ]);
    return { rows, total };
  });

  const payload: ApiSuccess<SalesLeadDto[]> = {
    success: true,
    data: rows.map(toDto),
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

/**
 * §7's management KPIs.
 *
 * The pipeline figures are the open leads as they stand now. The two
 * conversion figures count the leads decided this calendar year in the
 * workspace's zone — a rate over all time never moves, and one over a month
 * swings on a single lead.
 */
salesLeadRouter.get('/leads/kpis', requirePermission(`${LEAD_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = salesLeadKpiQuerySchema.parse(req.query);

  const data = await withTenant(auth.tenantId, async (db) => {
    const dayOf = await tenantDayOf(db, auth.tenantId);
    const today = dayOf(new Date());
    const year = Number(today.slice(0, 4));
    const owner: Prisma.SalesLeadWhereInput =
      query.ownerId !== undefined ? { ownerId: BigInt(query.ownerId) } : {};

    const [open, decided] = await Promise.all([
      db.salesLead.findMany({
        where: { ...openLeadWhere, ...owner },
        select: {
          status: true,
          shipmentType: true,
          loadingType: true,
          monthlyVolume: true,
          revenuePerUnit: true,
          profitPerUnit: true,
          winProbability: true,
          nextFollowupDate: true,
          containerSize: { select: { teuFactor: true } },
        },
      }),
      // A generous window, narrowed to the workspace's own year below: the
      // year boundary in Dhaka is not the one in UTC.
      db.salesLead.findMany({
        where: {
          deletedAt: null,
          ...owner,
          status: { in: [...CLOSED_LEAD_STATUSES] },
          closedAt: { gte: new Date(Date.UTC(year - 1, 11, 30)) },
        },
        select: { status: true, businessType: true, closedAt: true },
      }),
    ]);

    const zero = new Prisma.Decimal(0);
    let teu = zero;
    let revenue = zero;
    let profit = zero;
    let weighted = zero;
    let overdue = 0;
    for (const lead of open) {
      const f = forecastOf(lead);
      if (f.monthlyTeu !== null) teu = teu.add(f.monthlyTeu);
      if (f.monthlyRevenue !== null) revenue = revenue.add(f.monthlyRevenue);
      if (f.monthlyProfit !== null) profit = profit.add(f.monthlyProfit);
      if (f.weightedProfit !== null) weighted = weighted.add(f.weightedProfit);
      if (dueOf(lead.nextFollowupDate, today) === 'OVERDUE') overdue += 1;
    }

    const thisYear = decided.filter(
      (l) => l.closedAt !== null && dayOf(l.closedAt).startsWith(`${year}-`),
    );
    const won = thisYear.filter((l) => l.status === 'WON');
    const lost = thisYear.filter((l) => l.status === 'LOST');

    const kpis: SalesLeadKpiDto = {
      activeLeads: open.length,
      // Past the first step: someone has confirmed freight control and volume.
      qualifiedLeads: open.filter((l) => l.status !== 'NEW').length,
      monthlyTeuPipeline: teu.toFixed(2),
      monthlyRevenue: revenue.toFixed(2),
      monthlyProfit: profit.toFixed(2),
      weightedProfit: weighted.toFixed(2),
      conversionPending: open.filter((l) => CONVERSION_PENDING_STATUSES.includes(l.status)).length,
      conversionRate:
        won.length + lost.length === 0
          ? null
          : Math.round((won.length / (won.length + lost.length)) * 1000) / 10,
      wonThisYear: won.length,
      lostThisYear: lost.length,
      overdueFollowups: overdue,
      newCustomersWon: won.filter((l) => l.businessType === 'NEW_CUSTOMER').length,
      year,
      currency: 'USD',
    };
    return kpis;
  });

  const payload: ApiSuccess<SalesLeadKpiDto> = { success: true, data };
  res.json(payload);
});

salesLeadRouter.get('/leads/:id', requirePermission(`${LEAD_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'lead');

  const lead = await withTenant(auth.tenantId, (db) =>
    db.salesLead.findFirst({ where: { id, deletedAt: null }, include: leadInclude }),
  );
  if (lead === null) throw HttpError.notFound('Lead not found.');

  const payload: ApiSuccess<SalesLeadDto> = { success: true, data: toDto(lead) };
  res.json(payload);
});

// ===========================================================================
// Create and edit
// ===========================================================================

type LeadInput = ReturnType<typeof salesLeadInputSchema.parse>;

interface LeadRefs {
  sourceId: bigint;
  ownerId: bigint;
  customerId: bigint | null;
  buyerCustomerId: bigint | null;
  agentId: bigint | null;
  commodityItemId: bigint;
  polId: bigint;
  podId: bigint;
  containerSizeId: bigint | null;
  currentCarrierId: bigint | null;
  currencyId: bigint | null;
}

/**
 * Every FK, checked inside the tenant scope.
 *
 * A reference must be available to be chosen — active, and not switched off by
 * this workspace — unless the lead already points at it. A customer
 * deactivated after it was linked must not stop the lead being saved again.
 */
async function assertReferences(
  db: TenantDb,
  input: LeadInput,
  existing: Partial<Record<keyof LeadRefs, bigint | null>> = {},
): Promise<LeadRefs> {
  const inactive = await inactiveMasters(db);

  async function ref(
    raw: string | undefined,
    key: keyof LeadRefs,
    label: string,
    find: (id: bigint, mustBeLive: boolean) => Promise<unknown>,
  ): Promise<bigint | null> {
    if (raw === undefined || raw === '') return null;
    const id = parseRefId(raw, label);
    const mustBeLive = existing[key] !== id;
    if ((await find(id, mustBeLive)) === null) {
      throw HttpError.badRequest(`That ${label} is not available.`);
    }
    return id;
  }
  const live = (mustBeLive: boolean, table: string) =>
    mustBeLive ? { isActive: true, ...excludeInactive(inactive, table) } : {};

  const sourceId = await ref(input.sourceId, 'sourceId', 'lead source', (id, m) =>
    db.inquirySource.findFirst({ where: { AND: [{ id }, live(m, 'inquiry_source')], deletedAt: null }, select: { id: true } }),
  );
  const ownerId = await ref(input.ownerId, 'ownerId', 'salesperson', (id, m) =>
    db.employee.findFirst({ where: { id, deletedAt: null, ...(m ? { isActive: true } : {}) }, select: { id: true } }),
  );
  const customerId = await ref(input.customerId, 'customerId', 'customer', (id, m) =>
    db.customer.findFirst({ where: { id, deletedAt: null, ...(m ? { isActive: true } : {}) }, select: { id: true } }),
  );
  const buyerCustomerId = await ref(input.buyerCustomerId, 'buyerCustomerId', 'buyer', (id, m) =>
    db.customer.findFirst({ where: { id, deletedAt: null, ...(m ? { isActive: true } : {}) }, select: { id: true } }),
  );
  const agentId = await ref(input.agentId, 'agentId', 'agent', (id, m) =>
    db.agent.findFirst({ where: { id, deletedAt: null, ...(m ? { isActive: true } : {}) }, select: { id: true } }),
  );
  const commodityItemId = await ref(input.commodityItemId, 'commodityItemId', 'commodity', (id, m) =>
    db.commodityItem.findFirst({ where: { id, deletedAt: null, ...(m ? { isActive: true } : {}) }, select: { id: true } }),
  );
  const containerSizeId = await ref(input.containerSizeId, 'containerSizeId', 'equipment type', (id, m) =>
    db.containerSize.findFirst({ where: { AND: [{ id }, live(m, 'container_size')], deletedAt: null }, select: { id: true } }),
  );
  const currentCarrierId = await ref(input.currentCarrierId, 'currentCarrierId', 'shipping line', (id, m) =>
    db.carrier.findFirst({ where: { AND: [{ id }, live(m, 'carrier')], deletedAt: null }, select: { id: true } }),
  );

  // An air lead runs between airports, a sea one between seaports — the
  // inquiry's rule, so the inquiry raised from it is valid as it stands.
  const wanted = input.shipmentMode === 'AIR' ? 'AIRPORT' : 'SEAPORT';
  const portOf = async (raw: string, key: 'polId' | 'podId', label: string): Promise<bigint> => {
    const id = parseRefId(raw, label);
    const mustBeLive = existing[key] !== id;
    const port = await db.port.findFirst({
      where: { AND: [{ id }, live(mustBeLive, 'port')], deletedAt: null },
      select: { type: true },
    });
    if (port === null) throw HttpError.badRequest(`That ${label} is not available.`);
    if (port.type !== wanted) {
      throw HttpError.badRequest(
        input.shipmentMode === 'AIR'
          ? 'An air lead must run between two airports.'
          : 'A sea lead must run between two seaports.',
      );
    }
    return id;
  };
  const polId = await portOf(input.polId, 'polId', 'port of loading');
  const podId = await portOf(input.podId, 'podId', 'port of discharge');

  const hasAmount = [input.revenuePerUnit, input.profitPerUnit, input.marketRatePerUnit].some(
    (v) => v !== undefined && v !== '',
  );
  const usd = await usdCurrencyId(db);
  if (hasAmount && usd === null) {
    throw HttpError.badRequest('Add USD under Setting → Currency before recording revenue figures.');
  }

  return {
    sourceId: sourceId!,
    ownerId: ownerId!,
    customerId,
    buyerCustomerId,
    agentId,
    commodityItemId: commodityItemId!,
    polId,
    podId,
    containerSizeId: input.shipmentMode === 'SEA_FCL' ? containerSizeId : null,
    currentCarrierId,
    currencyId: usd?.id ?? null,
  };
}

/** The columns one input writes, create and edit alike. */
function leadData(input: LeadInput, refs: LeadRefs) {
  return {
    leadDate: new Date(input.leadDate),
    sourceId: refs.sourceId,
    ownerId: refs.ownerId,
    businessType: input.businessType,
    priority: input.priority === undefined || input.priority === '' ? null : input.priority,

    name: input.name,
    customerId: refs.customerId,
    exporterContact: blank(input.exporterContact),
    exporterMobile: blank(input.exporterMobile),
    exporterEmail: blank(input.exporterEmail),
    factoryLocation: blank(input.factoryLocation),
    buyerName: blank(input.buyerName),
    buyerCustomerId: refs.buyerCustomerId,
    buyerCountry: blank(input.buyerCountry),
    buyingHouse: blank(input.buyingHouse),
    agentName: blank(input.agentName),
    agentId: refs.agentId,
    agentCountry: blank(input.agentCountry),
    agentContact: blank(input.agentContact),

    commodityItemId: refs.commodityItemId,
    shipmentType: input.shipmentMode === 'AIR' ? ('AIR' as const) : ('SEA' as const),
    loadingType:
      input.shipmentMode === 'SEA_FCL'
        ? ('FCL' as const)
        : input.shipmentMode === 'SEA_LCL'
          ? ('LCL' as const)
          : null,
    polId: refs.polId,
    podId: refs.podId,
    containerSizeId: refs.containerSizeId,
    monthlyVolume: decimalOrNull(input.monthlyVolume),
    shipmentFrequency:
      input.shipmentFrequency === undefined || input.shipmentFrequency === ''
        ? null
        : input.shipmentFrequency,
    firstShipmentDate: dateOrNull(input.firstShipmentDate),
    incumbentForwarder: blank(input.incumbentForwarder),
    currentCarrierId: refs.currentCarrierId,
    requirements: blank(input.requirements),

    freightControl:
      input.freightControl === undefined || input.freightControl === '' ? null : input.freightControl,
    status: input.status,
    currencyId: refs.currencyId,
    revenuePerUnit: decimalOrNull(input.revenuePerUnit),
    profitPerUnit: decimalOrNull(input.profitPerUnit),
    marketRatePerUnit: decimalOrNull(input.marketRatePerUnit),
    marketRateSource: blank(input.marketRateSource),
    winProbability:
      input.winProbability === undefined || input.winProbability === ''
        ? null
        : Number(input.winProbability),
    nextFollowupDate: dateOrNull(input.nextFollowupDate),
    // Kept on an open lead too: a reason typed before reopening is history.
    outcomeReason: blank(input.outcomeReason),
  };
}

/**
 * When the lead was decided. Stamped when it first becomes WON or LOST, kept
 * while it stays decided, and cleared if it is reopened.
 */
function closedAtFor(
  status: SalesLeadStatus,
  before: { status: SalesLeadStatus; closedAt: Date | null } | null,
): Date | null {
  if (!CLOSED_LEAD_STATUSES.includes(status)) return null;
  if (before !== null && before.status === status && before.closedAt !== null) return before.closedAt;
  return new Date();
}

salesLeadRouter.post('/leads', requirePermission(`${LEAD_FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = salesLeadInputSchema.parse(req.body);
  const leadDate = new Date(input.leadDate);
  const year = seriesYearOf(leadDate);

  const created = await withTenant(auth.tenantId, async (db) => {
    const refs = await assertReferences(db, input);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextSalesLeadNo(db, auth.tenantId, year);
      try {
        return await inSavepoint(db, () =>
          db.salesLead.create({
            data: {
              tenantId: auth.tenantId,
              code,
              seriesYear: year,
              ...leadData(input, refs),
              closedAt: closedAtFor(input.status, null),
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            include: leadInclude,
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not add the lead. Try again.');
  });

  const payload: ApiSuccess<SalesLeadDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

salesLeadRouter.patch('/leads/:id', requirePermission(`${LEAD_FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'lead');
  const input = salesLeadInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.salesLead.findFirst({
      where: { id, deletedAt: null },
      select: {
        status: true,
        closedAt: true,
        sourceId: true,
        ownerId: true,
        customerId: true,
        buyerCustomerId: true,
        agentId: true,
        commodityItemId: true,
        polId: true,
        podId: true,
        containerSizeId: true,
        currentCarrierId: true,
      },
    });
    if (existing === null) throw HttpError.notFound('Lead not found.');

    const refs = await assertReferences(db, input, existing);
    return db.salesLead.update({
      where: { id },
      data: {
        ...leadData(input, refs),
        closedAt: closedAtFor(input.status, existing),
        updatedBy: auth.userId,
      },
      include: leadInclude,
    });
  });

  const payload: ApiSuccess<SalesLeadDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

/** §8: Active/Inactive rather than delete — §4 rule 3 forbids the latter. */
salesLeadRouter.post(
  '/leads/:id/toggle-status',
  requirePermission(`${LEAD_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'lead');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.salesLead.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Lead not found.');

      const updated = await db.salesLead.update({
        where: { id },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

// ===========================================================================
// Follow-ups — a lead's own history (§8's child screen)
// ===========================================================================

/** Confirms the lead exists inside this tenant before touching its children. */
async function assertLead(db: TenantDb, leadId: bigint): Promise<LeadRow> {
  const lead = await db.salesLead.findFirst({
    where: { id: leadId, deletedAt: null },
    include: leadInclude,
  });
  if (lead === null) throw HttpError.notFound('Lead not found.');
  return lead;
}

const followupSelect = {
  id: true,
  followupDate: true,
  contactMode: true,
  contactPerson: true,
  notes: true,
  outcome: true,
  nextAction: true,
  targetRate: true,
  objections: true,
  nextFollowupDate: true,
  createdAt: true,
  currency: { select: { currency: true } },
  createdByUser: { select: { username: true } },
} satisfies Prisma.SalesLeadFollowupSelect;

type FollowupRow = Prisma.SalesLeadFollowupGetPayload<{ select: typeof followupSelect }>;

function followupToDto(row: FollowupRow): SalesLeadFollowupDto {
  return {
    id: row.id.toString(),
    followupDate: isoDate(row.followupDate)!,
    contactMode: row.contactMode,
    contactPerson: row.contactPerson,
    notes: row.notes,
    outcome: row.outcome,
    nextAction: row.nextAction,
    targetRate: decimalString(row.targetRate),
    currency: row.currency === null ? null : isoCurrency(row.currency.currency),
    objections: row.objections,
    nextFollowupDate: isoDate(row.nextFollowupDate),
    createdBy: row.createdByUser?.username ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The inquiries a lead produced, as far as this user may see them.
 *
 * The inquiry's own visibility rule (MODULE_PURCHASE_SALES §4 rule 10): VIEW_ALL
 * sees the team's, plain VIEW only the user's own, and no VIEW sees none.
 */
async function leadInquiries(
  db: TenantDb,
  auth: { userId: bigint; isSuperadmin: boolean; permissions: ReadonlySet<string> },
  leadId: bigint,
): Promise<SalesLeadFollowupPayload['inquiries']> {
  const has = (key: string) => auth.isSuperadmin || auth.permissions.has(key);
  if (!has('SALES.INQUIRY.VIEW')) return [];

  let scope: Prisma.InquiryWhereInput = {};
  if (!has('SALES.INQUIRY.VIEW_ALL')) {
    const user = await db.user.findFirst({ where: { id: auth.userId }, select: { employeeId: true } });
    if (user?.employeeId == null) return [];
    scope = { salesmanId: user.employeeId };
  }

  const rows = await db.inquiry.findMany({
    where: { leadId, deletedAt: null, ...scope },
    select: { id: true, code: true, inquiryDate: true, status: true, customer: { select: { name: true } } },
    orderBy: { inquiryDate: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    inquiryDate: isoDate(r.inquiryDate)!,
    status: r.status,
    customerName: r.customer.name,
  }));
}

salesLeadRouter.get(
  '/leads/:id/followups',
  requirePermission(`${FOLLOWUP_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');

    const data = await withTenant(auth.tenantId, async (db) => {
      const lead = await assertLead(db, leadId);
      const [rows, inquiries] = await Promise.all([
        db.salesLeadFollowup.findMany({
          where: { leadId, deletedAt: null },
          orderBy: [{ followupDate: 'desc' }, { id: 'desc' }],
          select: followupSelect,
        }),
        leadInquiries(db, auth, leadId),
      ]);
      return { lead, rows, inquiries };
    });

    const payload: ApiSuccess<SalesLeadFollowupPayload> = {
      success: true,
      data: {
        lead: toDto(data.lead),
        followups: data.rows.map(followupToDto),
        inquiries: data.inquiries,
      },
    };
    res.json(payload);
  },
);

salesLeadRouter.post(
  '/leads/:id/followups',
  requirePermission(`${FOLLOWUP_FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');
    const input = salesLeadFollowupInputSchema.parse(req.body);

    const created = await withTenant(auth.tenantId, async (db) => {
      await assertLead(db, leadId);
      const targetRate = decimalOrNull(input.targetRate);
      const usd = targetRate === null ? null : await usdCurrencyId(db);
      if (targetRate !== null && usd === null) {
        throw HttpError.badRequest('Add USD under Setting → Currency before recording a target rate.');
      }
      const nextFollowupDate = dateOrNull(input.nextFollowupDate);

      const row = await db.salesLeadFollowup.create({
        data: {
          tenantId: auth.tenantId,
          leadId,
          followupDate: new Date(input.followupDate),
          contactMode: input.contactMode,
          contactPerson: blank(input.contactPerson),
          notes: blank(input.notes),
          outcome: blank(input.outcome),
          nextAction: blank(input.nextAction),
          targetRate,
          currencyId: usd?.id ?? null,
          objections: blank(input.objections),
          nextFollowupDate,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: followupSelect,
      });

      // The latest conversation sets when the next one is due. Blank means
      // nothing is planned, which the due list then shows as "No date set".
      await db.salesLead.update({
        where: { id: leadId },
        data: { nextFollowupDate, updatedBy: auth.userId },
      });
      return row;
    });

    const payload: ApiSuccess<SalesLeadFollowupDto> = {
      success: true,
      data: followupToDto(created),
    };
    res.status(201).json(payload);
  },
);

// ===========================================================================
// Follow-ups across every lead — the "Sales Lead follow up" menu screen
// ===========================================================================

/**
 * The due list: open leads by when they next need a call. `meta.counts` carries
 * every bucket's size, so the tabs can say how much is waiting on each.
 */
salesLeadRouter.get(
  '/lead-followups/due',
  requirePermission(`${FOLLOWUP_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const query = salesLeadDueQuerySchema.parse(req.query);

    const result = await withTenant(auth.tenantId, async (db) => {
      const today = await tenantToday(db, auth.tenantId);
      const base: Prisma.SalesLeadWhereInput = {
        AND: [
          openLeadWhere,
          query.ownerId !== undefined ? { ownerId: BigInt(query.ownerId) } : {},
          query.search !== undefined
            ? {
                OR: [
                  { code: { contains: query.search, mode: 'insensitive' } },
                  { name: { contains: query.search, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      };
      const where: Prisma.SalesLeadWhereInput =
        query.due === undefined ? base : { AND: [base, dueWhere(query.due, today)] };

      const [rows, total, overdue, dueToday, upcoming, unscheduled] = await Promise.all([
        db.salesLead.findMany({
          where,
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            nextFollowupDate: true,
            owner: { select: { name: true } },
            pol: portSelect,
            pod: portSelect,
            followups: {
              where: { deletedAt: null },
              orderBy: [{ followupDate: 'desc' }, { id: 'desc' }],
              take: 1,
              select: { followupDate: true, contactMode: true, outcome: true, nextAction: true },
            },
          },
          orderBy: [{ nextFollowupDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        db.salesLead.count({ where }),
        db.salesLead.count({ where: { AND: [base, dueWhere('OVERDUE', today)] } }),
        db.salesLead.count({ where: { AND: [base, dueWhere('TODAY', today)] } }),
        db.salesLead.count({ where: { AND: [base, dueWhere('UPCOMING', today)] } }),
        db.salesLead.count({ where: { AND: [base, dueWhere('UNSCHEDULED', today)] } }),
      ]);

      const data: SalesLeadDueDto[] = rows.map((r) => {
        const last = r.followups[0];
        const pol = placeOf(r.pol);
        const pod = placeOf(r.pod);
        return {
          id: r.id.toString(),
          code: r.code,
          name: r.name,
          status: r.status,
          ownerName: r.owner?.name ?? null,
          lane: pol === null || pod === null ? null : `${pol} → ${pod}`,
          nextFollowupDate: isoDate(r.nextFollowupDate),
          due: dueOf(r.nextFollowupDate, today),
          last:
            last === undefined
              ? null
              : {
                  followupDate: isoDate(last.followupDate)!,
                  contactMode: last.contactMode,
                  outcome: last.outcome,
                  nextAction: last.nextAction,
                },
        };
      });
      return {
        data,
        total,
        counts: { OVERDUE: overdue, TODAY: dueToday, UPCOMING: upcoming, UNSCHEDULED: unscheduled },
      };
    });

    const payload: ApiSuccess<SalesLeadDueDto[]> = {
      success: true,
      data: result.data,
      meta: { ...buildMeta(query.page, query.limit, result.total), counts: result.counts },
    };
    res.json(payload);
  },
);

/** The activity log: every follow-up recorded, newest first (§6 "Approval and audit"). */
salesLeadRouter.get(
  '/lead-followups/activity',
  requirePermission(`${FOLLOWUP_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const query = salesLeadActivityQuerySchema.parse(req.query);

    const where: Prisma.SalesLeadFollowupWhereInput = {
      deletedAt: null,
      lead: {
        deletedAt: null,
        ...(query.ownerId !== undefined ? { ownerId: BigInt(query.ownerId) } : {}),
        ...(query.search !== undefined
          ? {
              OR: [
                { code: { contains: query.search, mode: 'insensitive' } },
                { name: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      ...(query.from !== undefined || query.to !== undefined
        ? {
            followupDate: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const { rows, total } = await withTenant(auth.tenantId, async (db) => {
      const [rows, total] = await Promise.all([
        db.salesLeadFollowup.findMany({
          where,
          select: { ...followupSelect, lead: { select: { id: true, code: true, name: true } } },
          orderBy: [{ followupDate: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        db.salesLeadFollowup.count({ where }),
      ]);
      return { rows, total };
    });

    const payload: ApiSuccess<SalesLeadActivityDto[]> = {
      success: true,
      data: rows.map((r) => ({
        ...followupToDto(r),
        leadId: r.lead.id.toString(),
        leadCode: r.lead.code,
        leadName: r.lead.name,
      })),
      meta: buildMeta(query.page, query.limit, total),
    };
    res.json(payload);
  },
);

// ===========================================================================
// Documents — §6 Document attachment
// ===========================================================================

const documentSelect = {
  id: true,
  kind: true,
  fileKey: true,
  createdAt: true,
  createdByUser: { select: { username: true } },
} satisfies Prisma.SalesLeadDocumentSelect;

function documentToDto(row: Prisma.SalesLeadDocumentGetPayload<{ select: typeof documentSelect }>): SalesLeadDocumentDto {
  return {
    id: row.id.toString(),
    kind: row.kind,
    fileName: displayNameFromKey(row.fileKey),
    uploadedBy: row.createdByUser?.username ?? null,
    uploadedAt: row.createdAt.toISOString(),
  };
}

export interface LeadDocumentsPayload {
  lead: { id: string; code: string; name: string };
  documents: SalesLeadDocumentDto[];
}

async function documentsOf(db: TenantDb, leadId: bigint): Promise<LeadDocumentsPayload> {
  const lead = await assertLead(db, leadId);
  const rows = await db.salesLeadDocument.findMany({
    where: { leadId, deletedAt: null },
    select: documentSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return {
    lead: { id: lead.id.toString(), code: lead.code, name: lead.name },
    documents: rows.map(documentToDto),
  };
}

salesLeadRouter.get(
  '/leads/:id/documents',
  requirePermission(`${LEAD_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');
    const data = await withTenant(auth.tenantId, (db) => documentsOf(db, leadId));
    const payload: ApiSuccess<LeadDocumentsPayload> = { success: true, data };
    res.json(payload);
  },
);

salesLeadRouter.post(
  '/leads/:id/documents',
  requirePermission(`${LEAD_FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');
    const { kind } = salesLeadDocumentUploadSchema.parse(req.body);
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const data = await withTenant(auth.tenantId, async (db) => {
      await assertLead(db, leadId);
      const stored = await putFile(auth.tenantId, 'sales-lead', file);
      await db.salesLeadDocument.create({
        data: {
          tenantId: auth.tenantId,
          leadId,
          kind,
          fileKey: stored.key,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
      });
      return documentsOf(db, leadId);
    });

    const payload: ApiSuccess<LeadDocumentsPayload> = { success: true, data };
    res.status(201).json(payload);
  },
);

salesLeadRouter.get(
  '/leads/:id/documents/:documentId',
  requirePermission(`${LEAD_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');
    const documentId = parseId(req.params.documentId, 'document');

    const doc = await withTenant(auth.tenantId, (db) =>
      db.salesLeadDocument.findFirst({
        where: { id: documentId, leadId, deletedAt: null },
        select: { fileKey: true },
      }),
    );
    if (doc === null) throw HttpError.notFound('Document not found.');

    const { stream, sizeBytes } = await openFile(auth.tenantId, doc.fileKey);
    const fileName = displayNameFromKey(doc.fileKey).replace(/"/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', sizeBytes);
    stream.pipe(res);
  },
);

/**
 * Removes an attachment from the lead. A soft delete (§4 rule 3): the file and
 * the row stay, so an RFQ removed by mistake can still be recovered.
 */
salesLeadRouter.delete(
  '/leads/:id/documents/:documentId',
  requirePermission(`${LEAD_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');
    const documentId = parseId(req.params.documentId, 'document');

    const data = await withTenant(auth.tenantId, async (db) => {
      const doc = await db.salesLeadDocument.findFirst({
        where: { id: documentId, leadId, deletedAt: null },
        select: { id: true },
      });
      if (doc === null) throw HttpError.notFound('Document not found.');
      await db.salesLeadDocument.update({
        where: { id: documentId },
        data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
      });
      return documentsOf(db, leadId);
    });

    const payload: ApiSuccess<LeadDocumentsPayload> = { success: true, data };
    res.json(payload);
  },
);

// ===========================================================================
// For the inquiry form
// ===========================================================================

/** Lead options for the New Inquiry form's optional "from lead" field. */
salesLeadRouter.get(
  '/lead-options',
  requirePermission('SALES.INQUIRY.VIEW'),
  async (req, res) => {
    const auth = req.auth!;
    const rows = await withTenant(auth.tenantId, (db) =>
      db.salesLead.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      }),
    );

    const payload: ApiSuccess<{ id: string; name: string }[]> = {
      success: true,
      data: rows.map((r) => ({ id: r.id.toString(), name: `${r.code} — ${r.name}` })),
    };
    res.json(payload);
  },
);
