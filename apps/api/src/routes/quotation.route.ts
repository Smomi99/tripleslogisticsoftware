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
  quotationNotes,
} from '@ff/shared';
import { Router } from 'express';

import { amountInWords } from '../lib/amount-in-words';
import { recordAudit } from '../lib/audit';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { isoCurrency } from '../lib/currency-label';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { nextQuotationNo, seriesYearOf } from '../lib/inquiry-no';
import { HttpError } from '../lib/http-error';
import { Prisma } from '../generated/prisma/client';
import { pullQuotationLines } from '../lib/quotation-pull';
import { parseId, parseRefId } from '../lib/request';
import { queueMail } from '../lib/email-queue';
import { renderQuotationPdf } from '../lib/quotation-pdf';
import { renderVolumes } from '../lib/render-volumes';
import { openFile } from '../lib/storage';
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
       * §7A rule 7: a workspace cannot deactivate a shared master row, so
       * switching one off writes a tenant_master_override instead of touching
       * is_active. Filtering on the column alone offered currencies, carriers
       * and sizes this workspace had already turned off in Settings — the
       * screen said inactive and the quotation grid went on listing them.
       *
       * Only the system-capable tables need it. Vessel and Cost Head are
       * tenant-owned, so nothing shared exists for an override to point at.
       */
      const hidden = await inactiveMasters(db);
      const visible = (table: string) => ({ ...active, ...excludeInactive(hidden, table) });

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
          db.carrier.findMany({ where: visible('carrier'), orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.vessel.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.currency.findMany({
            where: visible('currency'),
            orderBy: { currency: 'asc' },
            select: { id: true, currency: true, conversion: true },
          }),
          db.costHead.findMany({ where: active, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.containerSize.findMany({ where: visible('container_size'), orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.costUnit.findMany({ where: visible('cost_unit'), orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.tos.findMany({ where: visible('tos'), orderBy: { name: 'asc' }, select: { id: true, name: true } }),
          db.mode.findMany({ where: visible('mode'), orderBy: { name: 'asc' }, select: { id: true, name: true } }),
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
        canExportPdf: auth.isSuperadmin || auth.permissions.has(`${FEATURE}.EXPORT_PDF`),
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
 * GET /api/tenant/cs/quotations/:id/pdf — §6.6's document.
 *
 * §6.6's one structural instruction: the header "must come from the tenant, not
 * be hardcoded". So the name, the logo and the standing notes are all read from
 * the workspace here and handed to a renderer that knows nothing about any
 * particular forwarder.
 *
 * §2.2's rule holds too: every figure printed is the one the row stored. The
 * totals, the frozen conversion rate and the words are read, never recomputed —
 * a document that disagrees with the record behind it is worse than none.
 */
quotationRouter.get(
  '/quotations/:id/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'quotation');

    const { pdf, code } = await withTenant(auth.tenantId, async (db) => {
      // Scoped like every other read of a quotation (§4 rule 10's row scope).
      const row = await findScoped(db, auth, id);
      const dto = toDto(row);

      const [settings, tenant, customer, inquiry] = await Promise.all([
        db.notificationSetting.findFirst({
          select: { signatureBlock: true, quotationNotes: true },
        }),
        db.tenant.findFirst({
          where: { id: auth.tenantId },
          select: { name: true, logoFile: true },
        }),
        db.customer.findFirst({
          where: { id: BigInt(dto.customerId) },
          select: { address: true },
        }),
        db.inquiry.findFirst({
          where: { id: BigInt(dto.inquiryId) },
          select: { inquiryDate: true },
        }),
      ]);

      // §6.6's logo. A workspace that has not uploaded one still gets a
      // letterhead — the name carries it — so a missing or unreadable file is
      // never a reason to withhold the quotation.
      let logo: Buffer | null = null;
      if (tenant?.logoFile != null && tenant.logoFile !== '') {
        try {
          const file = await openFile(auth.tenantId, tenant.logoFile);
          const parts: Buffer[] = [];
          for await (const chunk of file.stream) {
            parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          logo = Buffer.concat(parts);
        } catch {
          logo = null;
        }
      }

      const isAir = dto.shipmentType === 'AIR';
      const pdfBuffer = await renderQuotationPdf({
        companyName: tenant?.name ?? 'Freight Forwarder',
        companyAddress: settings?.signatureBlock ?? null,
        logo,
        inquiryNo: dto.inquiryCode,
        inquiryDate: inquiry?.inquiryDate.toISOString().slice(0, 10) ?? null,
        quotationNo: dto.code,
        revisionNo: dto.revisionNo,
        quotationDate: dto.quotationDate,
        validTill: dto.validityDate,
        customerName: dto.customerName,
        customerAddress: customer?.address ?? null,
        shipmentType: isAir ? 'Air' : 'Sea',
        isAir,
        polName: dto.polName ?? '—',
        podName: dto.podName ?? '—',
        goodsTypeName: dto.goodsTypeName,
        commodity: dto.commodities.map((c) => c.commodityName).join(', ') || '—',
        loadingType: dto.loadingType,
        tosName: dto.tosName,
        modeName: dto.modeName,
        carrierName: dto.carrierName,
        firstVesselName: dto.firstVesselName,
        transitType: dto.transitType,
        etd: dto.etd,
        eta: dto.eta,
        conversionRate: dto.conversionRate,
        localCurrencyCode: dto.localCurrencyCode ?? 'BDT',
        lines: dto.lines.map((line) => ({
          description: line.costHeadName,
          containerSize: line.containerSizeName,
          unit: line.unitName,
          quantity: line.quantity,
          sellingPrice: line.sellingPrice,
          total: line.totalAmount,
          currencyCode: line.currencyCode,
        })),
        totalUsd: dto.totalAmountUsd ?? '0.0000',
        totalLocal: dto.totalAmountLocal ?? '0.0000',
        // §5.3 rule 7 generated these words on save; printing them is reading.
        amountInWords: dto.amountInWords ?? amountInWords(dto.totalAmountUsd ?? '0'),
        notes: quotationNotes(settings?.quotationNotes),
      });

      return { pdf: pdfBuffer, code: dto.code };
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${code}.pdf"`);
    res.send(pdf);
  },
);

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

    /*
     * §6.5's "Save & Send" — the send half, which this endpoint has never done.
     * Until now it marked the quotation SENT, rewrote the recipient list and
     * answered the inquiry, and no letter ever left the building: a customer
     * waiting on a price got nothing, and the record said it had gone.
     *
     * Queued after the transaction commits, like every other notification here.
     * A customer told about a quotation that rolled back would be reading a
     * letter about nothing.
     */
    const sent = await withTenant(auth.tenantId, (db) => findScoped(db, auth, id));
    const dto = toDto(sent);
    const to = input.recipients.filter((r) => r.kind === 'TO').map((r) => r.email);
    const cc = input.recipients.filter((r) => r.kind === 'CC').map((r) => r.email);

    if (to.length > 0) {
      await queueMail({
        tenantId: auth.tenantId,
        templateKey: 'QUOTATION_SENT',
        to,
        cc,
        variables: {
          customerName: dto.customerName,
          quotationNo:
            dto.revisionNo > 1 ? `${dto.code} (rev ${dto.revisionNo})` : dto.code,
          polName: dto.polName ?? '—',
          podName: dto.podName ?? '—',
          shipmentType: dto.shipmentType === 'AIR' ? 'Air' : 'Sea',
          commodity: dto.commodities.map((c) => c.commodityName).join(', ') || '—',
          totalUsd: dto.totalAmountUsd ?? '0.0000',
          amountInWords: dto.amountInWords ?? '—',
          validityDate: dto.validityDate ?? 'on request',
        },
        relatedType: 'quotation',
        relatedId: id,
        actorId: auth.userId,
        fallback: {
          subject: `Quotation ${dto.code}`,
          bodyText:
            `Our quotation ${dto.code} for ${dto.polName ?? '—'} to ${dto.podName ?? '—'} ` +
            `comes to USD ${dto.totalAmountUsd ?? '0.0000'}.`,
        },
      });
    }

    await recordAudit({
      tenantId: auth.tenantId,
      action: 'UPDATE',
      tableName: 'quotation',
      recordId: id,
      actorId: auth.userId,
      details: { sent: true, recipients: input.recipients.length },
    });

    const payload: ApiSuccess<QuotationDto> = { success: true, data: dto };
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
