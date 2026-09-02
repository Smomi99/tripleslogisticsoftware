import {
  type ApiSuccess,
  buildMeta,
  inquiryFollowupInputSchema,
  type InquiryFollowupDto,
  type QuotationCommodityDto,
  quotationCreateSchema,
  type QuotationDto,
  quotationIsEditable,
  type QuotationLineDto,
  type QuotationListItemDto,
  quotationListQuerySchema,
  type QuotationRecipientDto,
  quotationSendSchema,
  type QuotationStatus,
  quotationUpdateSchema,
} from '@ff/shared';
import { Router } from 'express';

import { amountInWords } from '../lib/amount-in-words';
import { recordAudit } from '../lib/audit';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { isoCurrency } from '../lib/currency-label';
import { nextQuotationNo, seriesYearOf } from '../lib/inquiry-no';
import { HttpError } from '../lib/http-error';
import { Prisma } from '../generated/prisma/client';
import { pullQuotationLines } from '../lib/quotation-pull';
import { parseId, parseRefId } from '../lib/request';
import { renderVolumes } from '../lib/render-volumes';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * §6.5 and §6.7 — the quotation, and the list of them.
 *
 * The document that leaves the building. Three rules run through every handler
 * here and are worth stating once:
 *
 *  1. Money is snapshotted onto the line, never joined (§2.2). A quotation
 *     issued today must read the same next year.
 *  2. The conversion rate is frozen at creation and editable only before the
 *     quotation is sent (§5.4). After that it is part of an offer somebody
 *     holds us to.
 *  3. Editing a SENT quotation does not edit it — it issues revision 2 and
 *     supersedes revision 1 (§5.3 rule 8). Both are kept and the number is
 *     never reused.
 */

export const quotationRouter: Router = Router();
quotationRouter.use(authenticate);

const FEATURE = 'CUSTOMER_SERVICE.QUOTATION';
const LINE_FEATURE = 'CUSTOMER_SERVICE.QUOTATION_LINE';

const QUOTATION_INCLUDE = {
  inquiry: { select: { code: true } },
  customer: { select: { name: true } },
  pol: { select: { name: true, portCode: true } },
  pod: { select: { name: true, portCode: true } },
  goodsType: { select: { name: true } },
  tos: { select: { name: true } },
  mode: { select: { name: true } },
  carrier: { select: { name: true } },
  firstVessel: { select: { name: true } },
  localCurrency: { select: { currency: true } },
  commodities: {
    where: { isActive: true },
    select: { id: true, commodityItemId: true, commodityName: true, hsCode: true },
  },
  recipients: {
    where: { isActive: true },
    select: { id: true, email: true, kind: true, source: true },
  },
  lines: {
    where: { deletedAt: null },
    orderBy: [{ lineGroup: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true,
      lineGroup: true,
      sortOrder: true,
      costHeadId: true,
      costHeadName: true,
      containerSizeId: true,
      containerSizeName: true,
      costUnitId: true,
      unitName: true,
      quantity: true,
      sellingPrice: true,
      currencyId: true,
      currencyCode: true,
      totalAmount: true,
      conversionRate: true,
      billAmountLocal: true,
      source: true,
      // Carried so a revision, and a save that round-trips the grid, can keep
      // an AUTO line's provenance. Without it the line is indistinguishable
      // from one somebody typed — and quotation_line_auto_has_source_ck, quite
      // rightly, refuses to store it as AUTO.
      priceSourceRateLineId: true,
      priceSourceLocalChargeId: true,
      remarks: true,
    },
  },
} satisfies Prisma.QuotationInclude;

type QuotationRow = Prisma.QuotationGetPayload<{ include: typeof QUOTATION_INCLUDE }>;

const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const num = (value: Prisma.Decimal | null) => value?.toString() ?? null;

function lineToDto(row: QuotationRow['lines'][number]): QuotationLineDto {
  return {
    id: row.id.toString(),
    lineGroup: row.lineGroup,
    sortOrder: row.sortOrder,
    costHeadId: row.costHeadId.toString(),
    costHeadName: row.costHeadName,
    containerSizeId: row.containerSizeId?.toString() ?? null,
    containerSizeName: row.containerSizeName,
    costUnitId: row.costUnitId?.toString() ?? null,
    unitName: row.unitName,
    quantity: row.quantity.toString(),
    sellingPrice: row.sellingPrice.toString(),
    currencyId: row.currencyId.toString(),
    currencyCode: row.currencyCode,
    totalAmount: num(row.totalAmount) ?? '0',
    conversionRate: row.conversionRate.toString(),
    billAmountLocal: num(row.billAmountLocal) ?? '0',
    source: row.source,
    remarks: row.remarks,
  };
}

function toDto(row: QuotationRow): QuotationDto {
  return {
    id: row.id.toString(),
    code: row.code,
    revisionNo: row.revisionNo,
    inquiryId: row.inquiryId.toString(),
    inquiryCode: row.inquiry.code,
    quotationDate: day(row.quotationDate) ?? '',
    validityDate: day(row.validityDate),

    customerId: row.customerId.toString(),
    customerName: row.customer.name,
    shipmentType: row.shipmentType,
    movementType: row.movementType,
    polId: row.polId.toString(),
    polName: row.pol?.name ?? null,
    polCode: row.pol?.portCode ?? null,
    podId: row.podId.toString(),
    podName: row.pod?.name ?? null,
    podCode: row.pod?.portCode ?? null,
    goodsTypeId: row.goodsTypeId?.toString() ?? null,
    goodsTypeName: row.goodsType?.name ?? null,
    placeOfReceipt: row.placeOfReceipt,
    loadingType: row.loadingType,
    tosId: row.tosId?.toString() ?? null,
    tosName: row.tos?.name ?? null,
    modeId: row.modeId?.toString() ?? null,
    modeName: row.mode?.name ?? null,

    carrierId: row.carrierId.toString(),
    carrierName: row.carrier?.name ?? null,
    firstVesselId: row.firstVesselId?.toString() ?? null,
    firstVesselName: row.firstVessel?.name ?? null,
    transitType: row.transitType,
    etd: day(row.etd),
    eta: day(row.eta),

    localCurrencyId: row.localCurrencyId.toString(),
    localCurrencyCode: isoCurrency(row.localCurrency?.currency ?? '') ?? null,
    conversionRate: row.conversionRate.toString(),

    sourceAgentQuoteId: row.sourceAgentQuoteId?.toString() ?? null,

    totalAmountUsd: num(row.totalAmountUsd),
    totalAmountLocal: num(row.totalAmountLocal),
    amountInWords: row.amountInWords,

    status: row.status,
    sentAt: row.sentAt?.toISOString() ?? null,

    commodities: row.commodities.map<QuotationCommodityDto>((c) => ({
      id: c.id.toString(),
      commodityItemId: c.commodityItemId.toString(),
      commodityName: c.commodityName,
      hsCode: c.hsCode,
    })),
    lines: row.lines.map(lineToDto),
    recipients: row.recipients.map<QuotationRecipientDto>((r) => ({
      id: r.id.toString(),
      email: r.email,
      kind: r.kind,
      source: r.source,
    })),
  };
}

/**
 * Totals, recomputed from the lines and stored on the header (§5.3 rule 6).
 *
 * Read back from the database rather than added up from what the caller sent:
 * total_amount and bill_amount_local are GENERATED columns, so Postgres is the
 * only thing that has actually done this arithmetic, and the PDF should agree
 * with it rather than with a second opinion computed here.
 */
async function retotal(db: TenantDb, quotationId: bigint): Promise<void> {
  const rows = await db.quotationLine.findMany({
    where: { quotationId, deletedAt: null },
    select: { totalAmount: true, billAmountLocal: true, currencyCode: true },
  });

  const usd = rows.reduce(
    (sum, r) => sum.plus(r.totalAmount ?? 0),
    new Prisma.Decimal(0),
  );
  const local = rows.reduce(
    (sum, r) => sum.plus(r.billAmountLocal ?? 0),
    new Prisma.Decimal(0),
  );

  await db.quotation.update({
    where: { id: quotationId },
    data: {
      totalAmountUsd: usd,
      totalAmountLocal: local,
      amountInWords: amountInWords(usd.toString()),
    },
  });
}

/**
 * §7's VIEW_ALL: without it you see the quotations you raised, and the ones on
 * inquiries you are the salesman for.
 *
 * The employee id comes from the user row rather than the token, the same way
 * the inquiry's own scope clause reads it — a token outlives a reassignment.
 */
async function scopeFor(db: TenantDb, auth: AuthContext): Promise<Prisma.QuotationWhereInput> {
  if (auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`)) return {};

  const user = await db.user.findFirst({
    where: { id: auth.userId },
    select: { employeeId: true },
  });

  if (user?.employeeId == null) return { createdBy: auth.userId };
  return {
    OR: [{ createdBy: auth.userId }, { inquiry: { salesmanId: user.employeeId } }],
  };
}

async function findScoped(db: TenantDb, auth: AuthContext, id: bigint): Promise<QuotationRow> {
  const row = await db.quotation.findFirst({
    where: { id, deletedAt: null, ...(await scopeFor(db, auth)) },
    include: QUOTATION_INCLUDE,
  });
  if (row === null) throw HttpError.notFound('That quotation no longer exists.');
  return row;
}

/**
 * POST /api/tenant/cs/quotations
 *
 * §5.3 rules 1–3: the inquiry is mandatory, its header is copied down, and the
 * lines are pulled from the price table. Copied, not referenced — §5.3 rule 2
 * says edits here do not write back to the inquiry, and §2.2 says the document
 * must not move when the inquiry does.
 */
quotationRouter.post('/quotations', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = quotationCreateSchema.parse(req.body);
  const inquiryId = parseId(input.inquiryId, 'inquiry');

  const created = await withTenant(auth.tenantId, async (db) => {
    const inquiry = await db.inquiry.findFirst({
      where: { id: inquiryId, deletedAt: null },
      select: {
        id: true,
        code: true,
        customerId: true,
        shipmentType: true,
        movementType: true,
        polId: true,
        podId: true,
        goodsTypeId: true,
        placeOfReceipt: true,
        loadingType: true,
        tosId: true,
        modeId: true,
        status: true,
        commodities: {
          where: { isActive: true },
          select: {
            commodityItemId: true,
            hsCode: true,
            commodityItem: { select: { name: true } },
          },
        },
      },
    });
    if (inquiry === null) throw HttpError.notFound('That inquiry no longer exists.');
    if (inquiry.status === 'CANCELLED') {
      throw HttpError.conflict(`${inquiry.code} was cancelled and cannot be quoted.`);
    }

    /*
     * §5.4 — the booking rate, frozen here and never re-read. `conversion` on
     * the currency master is what it is worth today; the quotation is what it
     * was worth the day we committed to it.
     */
    const currencyId = parseRefId(input.localCurrencyId, 'currency');
    const currency = await db.currency.findFirst({
      where: { id: currencyId, deletedAt: null },
      select: { id: true, conversion: true },
    });
    if (currency === null) throw HttpError.notFound('That currency no longer exists.');
    const conversionRate = currency.conversion;
    if (conversionRate.lessThanOrEqualTo(0)) {
      throw HttpError.conflict(
        'That currency has no conversion rate set. Set one on Settings → Currency first.',
      );
    }

    const carrierId = parseRefId(input.carrierId, 'carrier');
    const quotationDate = new Date(`${input.quotationDate}T00:00:00.000Z`);

    const pulled = await pullQuotationLines(db, {
      polId: inquiry.polId,
      podId: inquiry.podId,
      goodsTypeId: inquiry.goodsTypeId,
      carrierId,
      inquiryId: inquiry.id,
      freightCostHeadId:
        input.freightCostHeadId === null || input.freightCostHeadId === undefined
          ? null
          : parseRefId(input.freightCostHeadId, 'cost head'),
    });

    // Addresses default from the customer, per the client's own note on the
    // wireframe: "email id automatically come from customer table".
    const contacts = await db.customerPic.findMany({
      where: { customerId: inquiry.customerId, deletedAt: null, isActive: true },
      select: { email: true },
    });
    const emails = [...new Set(contacts.map((c) => c.email).filter((e): e is string => !!e))];

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const seriesYear = seriesYearOf(quotationDate);
      const code = await nextQuotationNo(db, auth.tenantId, seriesYear);
      try {
        return await db.quotation.create({
          data: {
            tenantId: auth.tenantId,
            code,
            seriesYear,
            inquiryId: inquiry.id,
            quotationDate,
            validityDate:
              input.validityDate == null ? null : new Date(`${input.validityDate}T00:00:00.000Z`),
            customerId: inquiry.customerId,
            shipmentType: inquiry.shipmentType,
            movementType: inquiry.movementType,
            polId: inquiry.polId,
            podId: inquiry.podId,
            goodsTypeId: inquiry.goodsTypeId,
            placeOfReceipt: inquiry.placeOfReceipt,
            loadingType: inquiry.loadingType,
            tosId: inquiry.tosId,
            modeId: inquiry.modeId,
            carrierId,
            firstVesselId:
              input.firstVesselId == null ? null : parseRefId(input.firstVesselId, 'vessel'),
            transitType: input.transitType ?? null,
            etd: input.etd == null ? null : new Date(`${input.etd}T00:00:00.000Z`),
            eta: input.eta == null ? null : new Date(`${input.eta}T00:00:00.000Z`),
            localCurrencyId: currency.id,
            conversionRate,
            sourceAgentQuoteId:
              input.sourceAgentQuoteId == null
                ? null
                : parseRefId(input.sourceAgentQuoteId, 'agent quote'),
            createdBy: auth.userId,
            updatedBy: auth.userId,
            commodities: {
              create: inquiry.commodities.map((c) => ({
                commodityItemId: c.commodityItemId,
                commodityName: c.commodityItem?.name ?? '—',
                hsCode: c.hsCode,
              })),
            },
            recipients: {
              create: emails.map((email) => ({
                email,
                kind: 'TO' as const,
                source: 'CUSTOMER' as const,
                createdBy: auth.userId,
              })),
            },
            lines: {
              create: pulled.lines.map((line) => ({
                lineGroup: line.lineGroup,
                sortOrder: line.sortOrder,
                costHeadId: line.costHeadId,
                costHeadName: line.costHeadName,
                containerSizeId: line.containerSizeId,
                containerSizeName: line.containerSizeName,
                costUnitId: line.costUnitId,
                unitName: line.unitName,
                quantity: line.quantity,
                sellingPrice: line.sellingPrice,
                currencyId: line.currencyId,
                currencyCode: line.currencyCode,
                conversionRate,
                source: line.source,
                priceSourceRateLineId: line.priceSourceRateLineId,
                priceSourceLocalChargeId: line.priceSourceLocalChargeId,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              })),
            },
          },
          select: { id: true },
        });
      } catch (caught) {
        // Two callers raced for the same number. The unique index is the real
        // guarantee; this just goes round again.
        if (isUniqueViolation(caught) && attempt < CODE_RETRY_LIMIT - 1) continue;
        throw caught;
      }
    }
    throw HttpError.conflict('Could not allocate a quotation number. Try again.');
  });

  await withTenant(auth.tenantId, (db) => retotal(db, created.id));
  const row = await withTenant(auth.tenantId, (db) => findScoped(db, auth, created.id));

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'CREATE',
    tableName: 'quotation',
    recordId: created.id,
    actorId: auth.userId,
    details: { inquiryId: inquiryId.toString() },
  });

  const payload: ApiSuccess<QuotationDto> = { success: true, data: toDto(row) };
  res.status(201).json(payload);
});


/**
 * GET /api/tenant/cs/quotation-options
 *
 * Everything the §6.5 form needs to render its dropdowns, in one round trip.
 *
 * The inquiry list here is deliberately narrow: an inquiry that has been won,
 * lost or cancelled is not something to raise a new price against, and offering
 * it would invite exactly that mistake.
 */
quotationRouter.get(
  '/quotation-options',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;

    const data = await withTenant(auth.tenantId, async (db) => {
      const active = { deletedAt: null, isActive: true } as const;

      /*
       * Which inquiries this person may quote against.
       *
       * VIEW_ALL widens it to the team, exactly as it does on the inquiry list
       * itself. Without it you are offered the ones you raised and the ones you
       * are the salesman for — offering more here would leak, through a
       * dropdown, the rows §7 keeps off the list screen.
       */
      const seesAll = auth.isSuperadmin || auth.permissions.has(`${FEATURE}.VIEW_ALL`);
      const me = await db.user.findFirst({
        where: { id: auth.userId },
        select: { employeeId: true },
      });
      const inquiryScope: Prisma.InquiryWhereInput = seesAll
        ? {}
        : me?.employeeId == null
          ? { createdBy: auth.userId }
          : { OR: [{ createdBy: auth.userId }, { salesmanId: me.employeeId }] };
      const label = (rows: { id: bigint; name: string }[]) =>
        rows.map((r) => ({ id: r.id.toString(), label: r.name }));

      const [inquiries, carriers, vessels, currencies, costHeads, sizes, units, tos, modes] =
        await Promise.all([
          db.inquiry.findMany({
            where: {
              deletedAt: null,
              status: { notIn: ['WON', 'LOST', 'CANCELLED', 'EXPIRED'] },
              ...inquiryScope,
            },
            orderBy: [{ inquiryDate: 'desc' }, { id: 'desc' }],
            take: 200,
            select: {
              id: true,
              code: true,
              customer: { select: { name: true } },
              pol: { select: { portCode: true } },
              pod: { select: { portCode: true } },
            },
          }),
          db.carrier.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.vessel.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.currency.findMany({
            where: active,
            orderBy: { currency: 'asc' },
            select: { id: true, currency: true, conversion: true },
          }),
          db.costHead.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.containerSize.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.costUnit.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.tos.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.mode.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
        ]);

      return {
        inquiries: inquiries.map((i) => ({
          id: i.id.toString(),
          // The number alone is not enough to pick from a list of two hundred.
          label: `${i.code} — ${i.customer?.name ?? ''} ${i.pol?.portCode ?? ''}→${i.pod?.portCode ?? ''}`.trim(),
        })),
        carriers: label(carriers),
        vessels: label(vessels),
        currencies: currencies.map((c) => ({
          id: c.id.toString(),
          label: isoCurrency(c.currency) ?? c.currency,
          conversion: c.conversion.toString(),
        })),
        costHeads: label(costHeads),
        containerSizes: label(sizes),
        costUnits: label(units),
        termsOfShipment: label(tos),
        modes: label(modes),
        canAddCharge:
          auth.isSuperadmin || auth.permissions.has(`${LINE_FEATURE}.ADD_ADDITIONAL`),
        canTypePrice:
          auth.isSuperadmin || auth.permissions.has(`${LINE_FEATURE}.MANUAL_PRICE`),
        canSend: auth.isSuperadmin || auth.permissions.has(`${FEATURE}.SEND`),
      };
    });

    const payload: ApiSuccess<typeof data> = { success: true, data };
    res.json(payload);
  },
);

/** GET /api/tenant/cs/quotations — §6.7. */
quotationRouter.get('/quotations', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = quotationListQuerySchema.parse(req.query);

  const buildWhere = async (db: TenantDb): Promise<Prisma.QuotationWhereInput> => ({
    deletedAt: null,
    ...(await scopeFor(db, auth)),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.customerId === undefined
      ? {}
      : { customerId: parseId(query.customerId, 'customer') }),
    ...(query.search === undefined || query.search === ''
      ? {}
      : {
          OR: [
            { code: { contains: query.search, mode: 'insensitive' } },
            { inquiry: { code: { contains: query.search, mode: 'insensitive' } } },
            { customer: { name: { contains: query.search, mode: 'insensitive' } } },
          ],
        }),
  });

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where = await buildWhere(db);
    const [rows, total] = await Promise.all([
      db.quotation.findMany({
        where,
        orderBy: [{ quotationDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          code: true,
          revisionNo: true,
          inquiryId: true,
          quotationDate: true,
          validityDate: true,
          shipmentType: true,
          status: true,
          totalAmountUsd: true,
          customer: { select: { name: true } },
          pol: { select: { name: true, portCode: true } },
          pod: { select: { name: true, portCode: true } },
          commodities: { where: { isActive: true }, select: { commodityName: true } },
          inquiry: {
            select: {
              code: true,
              volumes: {
                where: { deletedAt: null, isActive: true },
                select: {
                  quantity: true,
                  cbm: true,
                  weightKg: true,
                  containerSizeNote: true,
                  containerSize: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      db.quotation.count({ where }),
    ]);
    return { rows, total };
  });

  const data = rows.map<QuotationListItemDto>((row) => ({
    id: row.id.toString(),
    code: row.code,
    revisionNo: row.revisionNo,
    inquiryId: row.inquiryId.toString(),
    inquiryCode: row.inquiry.code,
    quotationDate: day(row.quotationDate) ?? '',
    customerName: row.customer.name,
    commodities: row.commodities.map((c) => c.commodityName),
    shipmentType: row.shipmentType,
    polCode: row.pol?.portCode ?? null,
    polName: row.pol?.name ?? null,
    podCode: row.pod?.portCode ?? null,
    podName: row.pod?.name ?? null,
    requiredContainer: renderVolumes(row.inquiry.volumes),
    validityDate: day(row.validityDate),
    status: row.status,
    totalAmountUsd: num(row.totalAmountUsd),
  }));

  const payload: ApiSuccess<QuotationListItemDto[]> = {
    success: true,
    data,
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});


/** GET /api/tenant/cs/quotations/:id */
quotationRouter.get('/quotations/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'quotation');
  const row = await withTenant(auth.tenantId, (db) => findScoped(db, auth, id));
  const payload: ApiSuccess<QuotationDto> = { success: true, data: toDto(row) };
  res.json(payload);
});

/**
 * PATCH /api/tenant/cs/quotations/:id
 *
 * §5.3 rule 8 is the whole shape of this handler. Editing a DRAFT edits it.
 * Editing a SENT quotation does not: it copies the document forward as revision
 * 2, applies the edit there, and marks revision 1 SUPERSEDED. A customer
 * holding revision 1 must still be able to find the thing they were sent.
 */
quotationRouter.patch('/quotations/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'quotation');
  const input = quotationUpdateSchema.parse(req.body);

  const mayType = auth.isSuperadmin || auth.permissions.has(`${LINE_FEATURE}.MANUAL_PRICE`);
  const mayAdd = auth.isSuperadmin || auth.permissions.has(`${LINE_FEATURE}.ADD_ADDITIONAL`);

  const targetId = await withTenant(auth.tenantId, async (db) => {
    const current = await findScoped(db, auth, id);
    if (!quotationIsEditable(current.status)) {
      throw HttpError.conflict(
        `This quotation is ${current.status.toLowerCase()} and can no longer be changed.`,
      );
    }

    const revising = current.status === 'SENT';
    let workingId = current.id;

    if (revising) {
      /*
       * Supersede the original BEFORE inserting its replacement.
       *
       * `quotation_live_revision_key` allows one non-superseded issue per
       * number, and a partial unique index is checked per statement — it cannot
       * be deferred to the end of the transaction the way a constraint can. So
       * the order is forced: retire revision 1, then issue revision 2. Doing it
       * the other way round is a unique violation every time.
       */
      await db.quotation.update({
        where: { id: current.id },
        data: { status: 'SUPERSEDED', updatedBy: auth.userId },
      });

      const next = await db.quotation.create({
        data: {
          tenantId: auth.tenantId,
          code: current.code,
          seriesYear: current.seriesYear,
          revisionNo: current.revisionNo + 1,
          inquiryId: current.inquiryId,
          quotationDate: current.quotationDate,
          validityDate: current.validityDate,
          customerId: current.customerId,
          shipmentType: current.shipmentType,
          movementType: current.movementType,
          polId: current.polId,
          podId: current.podId,
          goodsTypeId: current.goodsTypeId,
          placeOfReceipt: current.placeOfReceipt,
          loadingType: current.loadingType,
          tosId: current.tosId,
          modeId: current.modeId,
          carrierId: current.carrierId,
          firstVesselId: current.firstVesselId,
          transitType: current.transitType,
          etd: current.etd,
          eta: current.eta,
          localCurrencyId: current.localCurrencyId,
          conversionRate: current.conversionRate,
          sourceAgentQuoteId: current.sourceAgentQuoteId,
          createdBy: auth.userId,
          updatedBy: auth.userId,
          commodities: {
            create: current.commodities.map((c) => ({
              commodityItemId: c.commodityItemId,
              commodityName: c.commodityName,
              hsCode: c.hsCode,
            })),
          },
          recipients: {
            // Nested under the quotation, so tenant_id comes from the parent.
            create: current.recipients.map((r) => ({
              email: r.email,
              kind: r.kind,
              source: r.source,
              createdBy: auth.userId,
            })),
          },
        },
        select: { id: true },
      });
      workingId = next.id;

      // Carry the lines over, so an edit that only touches the header does not
      // silently issue an empty revision.
      if (input.lines === undefined) {
        for (const line of current.lines) {
          await db.quotationLine.create({
            data: {
              tenantId: auth.tenantId,
              quotationId: workingId,
              lineGroup: line.lineGroup,
              sortOrder: line.sortOrder,
              costHeadId: line.costHeadId,
              costHeadName: line.costHeadName,
              containerSizeId: line.containerSizeId,
              containerSizeName: line.containerSizeName,
              costUnitId: line.costUnitId,
              unitName: line.unitName,
              quantity: line.quantity,
              sellingPrice: line.sellingPrice,
              currencyId: line.currencyId,
              currencyCode: line.currencyCode,
              conversionRate: line.conversionRate,
              source: line.source,
              priceSourceRateLineId: line.priceSourceRateLineId,
              priceSourceLocalChargeId: line.priceSourceLocalChargeId,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
          });
        }
      }
    }

    // §5.4: the frozen rate moves only while the quotation is still a draft.
    if (input.conversionRate !== undefined && !revising) {
      await db.quotation.update({
        where: { id: workingId },
        data: { conversionRate: new Prisma.Decimal(input.conversionRate) },
      });
      // Every line carries its own copy, and they must agree with the header.
      await db.quotationLine.updateMany({
        where: { quotationId: workingId, deletedAt: null },
        data: { conversionRate: new Prisma.Decimal(input.conversionRate) },
      });
    }

    await db.quotation.update({
      where: { id: workingId },
      data: {
        ...(input.quotationDate === undefined
          ? {}
          : { quotationDate: new Date(`${input.quotationDate}T00:00:00.000Z`) }),
        ...(input.validityDate === undefined
          ? {}
          : {
              validityDate:
                input.validityDate === null
                  ? null
                  : new Date(`${input.validityDate}T00:00:00.000Z`),
            }),
        ...(input.carrierId === undefined
          ? {}
          : { carrierId: parseRefId(input.carrierId, 'carrier') }),
        ...(input.firstVesselId === undefined
          ? {}
          : {
              firstVesselId:
                input.firstVesselId === null
                  ? null
                  : parseRefId(input.firstVesselId, 'vessel'),
            }),
        ...(input.transitType === undefined ? {} : { transitType: input.transitType ?? null }),
        ...(input.etd === undefined
          ? {}
          : { etd: input.etd === null ? null : new Date(`${input.etd}T00:00:00.000Z`) }),
        ...(input.eta === undefined
          ? {}
          : { eta: input.eta === null ? null : new Date(`${input.eta}T00:00:00.000Z`) }),
        ...(input.placeOfReceipt === undefined
          ? {}
          : { placeOfReceipt: input.placeOfReceipt ?? null }),
        ...(input.tosId === undefined
          ? {}
          : { tosId: input.tosId === null ? null : parseRefId(input.tosId, 'TOS') }),
        ...(input.modeId === undefined
          ? {}
          : { modeId: input.modeId === null ? null : parseRefId(input.modeId, 'mode') }),
        ...(input.goodsTypeId === undefined
          ? {}
          : {
              goodsTypeId:
                input.goodsTypeId === null
                  ? null
                  : parseRefId(input.goodsTypeId, 'goods type'),
            }),
        updatedBy: auth.userId,
      },
    });

    if (input.lines !== undefined) {
      const header = await db.quotation.findFirstOrThrow({
        where: { id: workingId },
        select: { conversionRate: true },
      });

      /*
       * §7 splits the two ways a line can leave the price table behind.
       *
       * Adding a charge nobody quoted needs ADD_ADDITIONAL; typing a price the
       * rate table does not hold needs MANUAL_PRICE. Checked here rather than
       * only in the UI, because a hidden button is a courtesy and this is the
       * control.
       */
      const existing = new Map(current.lines.map((l) => [l.id.toString(), l]));
      for (const line of input.lines) {
        const was = line.id === undefined ? undefined : existing.get(line.id);
        const isNew = was === undefined;
        if (isNew && line.lineGroup === 'ADDITIONAL' && !mayAdd) {
          throw HttpError.forbidden('You cannot add charges to a quotation.');
        }
        const typed =
          line.source === 'MANUAL' &&
          (isNew || was.sellingPrice.toString() !== line.sellingPrice);
        if (typed && !mayType) {
          throw HttpError.forbidden('You cannot type a selling price by hand.');
        }
      }

      // Replace wholesale: the grid is edited as a whole and a diff would let a
      // stale client resurrect a line somebody else deleted.
      await db.quotationLine.updateMany({
        where: { quotationId: workingId, deletedAt: null },
        data: { deletedAt: new Date(), updatedBy: auth.userId },
      });

      let sortOrder = 0;
      for (const line of input.lines) {
        const costHeadId = parseRefId(line.costHeadId, 'cost head');
        const head = await db.costHead.findFirst({
          where: { id: costHeadId, deletedAt: null },
          select: { name: true, unitId: true, unit: { select: { name: true } } },
        });
        const currencyId = parseRefId(line.currencyId, 'currency');
        const currency = await db.currency.findFirst({
          where: { id: currencyId, deletedAt: null },
          select: { currency: true },
        });
        const containerSizeId =
          line.containerSizeId == null ? null : parseRefId(line.containerSizeId, 'container size');
        const containerSize =
          containerSizeId === null
            ? null
            : await db.containerSize.findFirst({
                where: { id: containerSizeId },
                select: { name: true },
              });

        /*
         * Where this line's price came from.
         *
         * The grid does not send provenance back — it has no business carrying
         * rate ids around — so an AUTO line inherits it from the row it was
         * loaded from. One that claims AUTO and can show nothing is recorded as
         * MANUAL, because that is what it is: a number with no price list
         * behind it, and §6.5 marks it accordingly.
         */
        const was = line.id === undefined ? undefined : existing.get(line.id);
        const inherited = {
          rateLineId: was?.priceSourceRateLineId ?? null,
          localChargeId: was?.priceSourceLocalChargeId ?? null,
        };
        const provenance =
          line.source === 'AUTO' &&
          (inherited.rateLineId !== null || inherited.localChargeId !== null)
            ? { source: 'AUTO' as const, ...inherited }
            : { source: 'MANUAL' as const, rateLineId: null, localChargeId: null };

        await db.quotationLine.create({
          data: {
            tenantId: auth.tenantId,
            quotationId: workingId,
            lineGroup: line.lineGroup,
            sortOrder: (sortOrder += 1),
            costHeadId,
            // Snapshotted at write time (§2.2), not read back on display.
            costHeadName: head?.name ?? '—',
            containerSizeId,
            containerSizeName: containerSize?.name ?? null,
            costUnitId: line.costUnitId == null ? head?.unitId ?? null : parseRefId(line.costUnitId, 'unit'),
            unitName: head?.unit?.name ?? null,
            quantity: new Prisma.Decimal(line.quantity),
            sellingPrice: new Prisma.Decimal(line.sellingPrice),
            currencyId,
            currencyCode: isoCurrency(currency?.currency ?? '') ?? '',
            conversionRate: header.conversionRate,
            source: provenance.source,
            priceSourceRateLineId: provenance.rateLineId,
            priceSourceLocalChargeId: provenance.localChargeId,
            remarks: line.remarks ?? null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
        });
      }
    }

    await retotal(db, workingId);
    return workingId;
  });

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'UPDATE',
    tableName: 'quotation',
    recordId: targetId,
    actorId: auth.userId,
    details: targetId === id ? {} : { revisedFrom: id.toString() },
  });

  const row = await withTenant(auth.tenantId, (db) => findScoped(db, auth, targetId));
  const payload: ApiSuccess<QuotationDto> = { success: true, data: toDto(row) };
  res.json(payload);
});

/**
 * POST /api/tenant/cs/quotations/:id/send
 *
 * §5.3 rule 9: status → SENT, the inquiry → QUOTED, the addresses recorded.
 * Behind its own permission: drafting a price and committing the company to it
 * in front of a customer are different acts.
 *
 * The PDF and the mail itself are Phase J. What lands here now is the state
 * change and the recipient record, so the document is auditable from the moment
 * it is sent rather than from whenever the mailer arrives.
 */
quotationRouter.post(
  '/quotations/:id/send',
  requirePermission(`${FEATURE}.SEND`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'quotation');
    const input = quotationSendSchema.parse(req.body);

    await withTenant(auth.tenantId, async (db) => {
      const current = await findScoped(db, auth, id);
      if (current.status !== 'DRAFT') {
        throw HttpError.conflict(
          `${current.code} is already ${current.status.toLowerCase()}.`,
        );
      }
      if (current.lines.length === 0) {
        throw HttpError.conflict('Add at least one charge before sending this quotation.');
      }

      // The addresses as they were at send time, replacing the defaults.
      await db.quotationRecipient.updateMany({
        where: { quotationId: id },
        data: { isActive: false },
      });
      for (const recipient of input.recipients) {
        await db.quotationRecipient.upsert({
          where: {
            tenantId_quotationId_email_kind: {
              tenantId: auth.tenantId,
              quotationId: id,
              email: recipient.email,
              kind: recipient.kind,
            },
          },
          create: {
            tenantId: auth.tenantId,
            quotationId: id,
            email: recipient.email,
            kind: recipient.kind,
            source: 'MANUAL',
            createdBy: auth.userId,
          },
          update: { isActive: true },
        });
      }

      await db.quotation.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date(), sentBy: auth.userId, updatedBy: auth.userId },
      });
      // §5.3 rule 9, the other half: the inquiry has been answered.
      await db.inquiry.update({
        where: { id: current.inquiryId },
        data: { status: 'QUOTED', quotedPrice: current.totalAmountUsd, updatedBy: auth.userId },
      });
    });

    await recordAudit({
      tenantId: auth.tenantId,
      action: 'UPDATE',
      tableName: 'quotation',
      recordId: id,
      actorId: auth.userId,
      details: { sent: true, recipients: input.recipients.length },
    });

    const row = await withTenant(auth.tenantId, (db) => findScoped(db, auth, id));
    const payload: ApiSuccess<QuotationDto> = { success: true, data: toDto(row) };
    res.json(payload);
  },
);

// ------------------------------------------------------- Follow up (§6.7)
// The same conversation inquiry_followup records, one step later: chasing a
// customer for an answer on a price we have already given them.

quotationRouter.get(
  '/quotations/:id/followups',
  requirePermission(`${FEATURE}.FOLLOWUP`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'quotation');

    const rows = await withTenant(auth.tenantId, async (db) => {
      await findScoped(db, auth, id);
      return db.quotationFollowup.findMany({
        where: { quotationId: id, deletedAt: null },
        orderBy: [{ followupDate: 'desc' }, { id: 'desc' }],
      });
    });

    const payload: ApiSuccess<InquiryFollowupDto[]> = {
      success: true,
      data: rows.map((row) => ({
        id: row.id.toString(),
        followupDate: day(row.followupDate) ?? '',
        contactMode: row.contactMode,
        contactPerson: row.contactPerson,
        notes: row.notes,
        nextFollowupDate: day(row.nextFollowupDate),
        createdBy: row.createdBy?.toString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
    res.json(payload);
  },
);

quotationRouter.post(
  '/quotations/:id/followups',
  requirePermission(`${FEATURE}.FOLLOWUP`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'quotation');
    const input = inquiryFollowupInputSchema.parse(req.body);

    const created = await withTenant(auth.tenantId, async (db) => {
      await findScoped(db, auth, id);
      return db.quotationFollowup.create({
        data: {
          tenantId: auth.tenantId,
          quotationId: id,
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
        select: { id: true },
      });
    });

    await recordAudit({
      tenantId: auth.tenantId,
      action: 'CREATE',
      tableName: 'quotation_followup',
      recordId: created.id,
      actorId: auth.userId,
      details: { quotationId: id.toString() },
    });

    const payload: ApiSuccess<{ id: string }> = {
      success: true,
      data: { id: created.id.toString() },
    };
    res.status(201).json(payload);
  },
);

export type { QuotationStatus };
