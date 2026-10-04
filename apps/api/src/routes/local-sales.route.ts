import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  customerActivityInputSchema,
  type CustomerActivityLogDto,
  isoCurrency,
  localSalesListQuerySchema,
  type LocalSalesRow,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { tenantDayOf } from '../lib/tenant-day';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Sales & Marketing → Local Sales (docs/DESIGN-UPDATE-2026-10-04.md §6).
 *
 * The list is the customer table as the sheet draws it (R7 "Table_Customer"),
 * every customer (§11 Q18), with what the sales team has recorded against
 * each. The customer itself is edited where it always is, on CRM → Customer;
 * this screen adds only the Activity Log.
 */

export const localSalesRouter: Router = Router();
localSalesRouter.use(authenticate);

const FEATURE = 'SALES.LOCAL_SALES';

const money = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toFixed(4));
const day = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString().slice(0, 10));

localSalesRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = localSalesListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.customerType === undefined ? {} : { customerType: query.customerType }),
      ...(query.businessArea === undefined ? {} : { businessArea: query.businessArea }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { country: { contains: query.search, mode: 'insensitive' } },
              { industrySector: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }),
    };
    const sortable: Record<string, Prisma.CustomerOrderByWithRelationInput> = {
      name: { name: query.sortOrder },
      country: { country: query.sortOrder },
    };
    const [found, counted] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: [sortable[query.sortBy ?? 'name'] ?? { name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          code: true,
          name: true,
          country: true,
          address: true,
          customerType: true,
          businessArea: true,
          exSeaVolumeTeuMonth: true,
          exAirVolumeKgMonth: true,
          imSeaVolumeTeuMonth: true,
          imAirVolumeKgMonth: true,
          weOwe: true,
          customerOwe: true,
          isActive: true,
          industrySector: { select: { name: true } },
          openingCurrency: { select: { currency: true } },
        },
      }),
      db.customer.count({ where }),
    ]);

    const ids = found.map((c) => c.id);
    const today = new Date(`${(await tenantDayOf(db, auth.tenantId))(new Date())}T00:00:00.000Z`);
    const [counts, upcoming] = await Promise.all([
      db.customerActivity.groupBy({
        by: ['customerId'],
        where: { customerId: { in: ids }, deletedAt: null },
        _count: { _all: true },
        _max: { activityAt: true },
      }),
      db.customerActivity.groupBy({
        by: ['customerId'],
        where: { customerId: { in: ids }, deletedAt: null, nextFollowupDate: { gte: today } },
        _min: { nextFollowupDate: true },
      }),
    ]);
    const countOf = new Map(counts.map((c) => [c.customerId.toString(), c]));
    const nextOf = new Map(upcoming.map((u) => [u.customerId.toString(), u._min.nextFollowupDate]));

    const data: LocalSalesRow[] = found.map((c) => {
      const tally = countOf.get(c.id.toString());
      return {
        id: c.id.toString(),
        code: c.code,
        name: c.name,
        country: c.country,
        address: c.address,
        customerType: c.customerType,
        commodityCategory: c.industrySector.name,
        businessArea: c.businessArea,
        exSeaVolumeTeuMonth: money(c.exSeaVolumeTeuMonth),
        exAirVolumeKgMonth: money(c.exAirVolumeKgMonth),
        imSeaVolumeTeuMonth: money(c.imSeaVolumeTeuMonth),
        imAirVolumeKgMonth: money(c.imAirVolumeKgMonth),
        weOwe: money(c.weOwe),
        customerOwe: money(c.customerOwe),
        openingCurrency: c.openingCurrency === null ? null : isoCurrency(c.openingCurrency.currency),
        isActive: c.isActive,
        activityCount: tally?._count._all ?? 0,
        lastActivityAt: tally?._max.activityAt?.toISOString() ?? null,
        nextFollowupDate: day(nextOf.get(c.id.toString()) ?? null),
      };
    });
    return { rows: data, total: counted };
  });

  const payload: ApiSuccess<LocalSalesRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

async function logOf(db: TenantDb, customerId: bigint): Promise<CustomerActivityLogDto> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    select: {
      id: true,
      name: true,
      pics: { where: { deletedAt: null, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } },
    },
  });
  if (customer === null) throw HttpError.notFound('Customer not found.');
  const activities = await db.customerActivity.findMany({
    where: { customerId, deletedAt: null },
    orderBy: [{ activityAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      activityAt: true,
      meetingSummary: true,
      nextFollowupDate: true,
      competitorAnalysis: true,
      businessPossibility: true,
      customerPic: { select: { name: true } },
      createdByUser: { select: { username: true } },
    },
  });
  return {
    customerId: customer.id.toString(),
    customerName: customer.name,
    pics: customer.pics.map((p) => ({ id: p.id.toString(), name: p.name })),
    activities: activities.map((a) => ({
      id: a.id.toString(),
      activityAt: a.activityAt.toISOString(),
      picName: a.customerPic?.name ?? null,
      meetingSummary: a.meetingSummary,
      nextFollowupDate: day(a.nextFollowupDate),
      competitorAnalysis: a.competitorAnalysis,
      businessPossibility: a.businessPossibility,
      recordedBy: a.createdByUser?.username ?? null,
    })),
  };
}

localSalesRouter.get('/:customerId/activities', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const customerId = parseId(req.params.customerId, 'customer');
  const data = await withTenant(auth.tenantId, (db) => logOf(db, customerId));
  const payload: ApiSuccess<CustomerActivityLogDto> = { success: true, data };
  res.json(payload);
});

/** The sheet's `Record`. */
localSalesRouter.post('/:customerId/activities', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const customerId = parseId(req.params.customerId, 'customer');
  const input = customerActivityInputSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const customer = await db.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } });
    if (customer === null) throw HttpError.notFound('Customer not found.');
    if (input.customerPicId !== null) {
      const pic = await db.customerPic.findFirst({
        where: { id: BigInt(input.customerPicId), customerId, deletedAt: null },
        select: { id: true },
      });
      if (pic === null) throw HttpError.badRequest('That contact is not one of this customer’s.');
    }
    await db.customerActivity.create({
      data: {
        tenantId: auth.tenantId,
        customerId,
        activityAt: new Date(input.activityAt),
        customerPicId: input.customerPicId === null ? null : BigInt(input.customerPicId),
        meetingSummary: input.meetingSummary,
        nextFollowupDate: input.nextFollowupDate === null ? null : new Date(`${input.nextFollowupDate}T00:00:00.000Z`),
        competitorAnalysis: input.competitorAnalysis ?? null,
        businessPossibility: input.businessPossibility ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
    });
    return logOf(db, customerId);
  });

  const payload: ApiSuccess<CustomerActivityLogDto> = { success: true, data };
  res.status(201).json(payload);
});
