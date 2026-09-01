import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type CustomerDto,
  customerInputSchema,
  CUSTOMER_TYPE_LABEL,
  CUSTOMER_TYPES,
  type CustomerType,
  customerListQuerySchema,
  type CustomerPicDto,
  customerPicInputSchema,
  listQuerySchema,
  type LookupOption,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/** CRM → Customer, with its contacts (CLAUDE.md §6, §8). Tenant-owned throughout. */
export const customerRouter: Router = Router();

customerRouter.use(authenticate);

const FEATURE = 'CRM.CUSTOMER';

/** Opening figures are NUMERIC(18,4) (§4 rule 6); blank means "not set". */
const money = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(4);
const moneyIn = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();
const refIn = (value: string | undefined): bigint | null =>
  value === undefined || value.trim() === '' ? null : BigInt(value);

const SELECT = {
  id: true,
  code: true,
  name: true,
  country: true,
  address: true,
  customerType: true,
  businessArea: true,
  industrySectorId: true,
  exSeaVolumeTeuMonth: true,
  exAirVolumeKgMonth: true,
  imSeaVolumeTeuMonth: true,
  imAirVolumeKgMonth: true,
  openingBalance: true,
  openingCurrencyId: true,
  openingCurrency: { select: { code: true } },
  notes: true,
  salesmanId: true,
  salesman: { select: { name: true } },
  isActive: true,
  industrySector: { select: { name: true } },
  _count: { select: { pics: true } },
} as const;

type CustomerRow = {
  id: bigint;
  code: string;
  name: string;
  country: string;
  address: string | null;
  customerType: 'IMPORTER' | 'EXPORTER' | 'TRADER';
  businessArea: 'INBOUND' | 'OUTBOUND' | 'BOTH';
  industrySectorId: bigint;
  exSeaVolumeTeuMonth: Prisma.Decimal | null;
  exAirVolumeKgMonth: Prisma.Decimal | null;
  imSeaVolumeTeuMonth: Prisma.Decimal | null;
  imAirVolumeKgMonth: Prisma.Decimal | null;
  openingBalance: Prisma.Decimal | null;
  openingCurrencyId: bigint | null;
  openingCurrency: { code: string } | null;
  notes: string | null;
  salesmanId: bigint | null;
  salesman: { name: string } | null;
  isActive: boolean;
  industrySector: { name: string };
  _count: { pics: number };
};

const decimal = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(4);

function toDto(row: CustomerRow): CustomerDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    country: row.country,
    address: row.address,
    customerType: row.customerType,
    businessArea: row.businessArea,
    industrySectorId: row.industrySectorId.toString(),
    industrySectorName: row.industrySector.name,
    exSeaVolumeTeuMonth: decimal(row.exSeaVolumeTeuMonth),
    exAirVolumeKgMonth: decimal(row.exAirVolumeKgMonth),
    imSeaVolumeTeuMonth: decimal(row.imSeaVolumeTeuMonth),
    imAirVolumeKgMonth: decimal(row.imAirVolumeKgMonth),
    openingBalance: money(row.openingBalance),
    openingCurrencyId: row.openingCurrencyId?.toString() ?? null,
    openingCurrencyCode: row.openingCurrency?.code ?? null,
    notes: row.notes,
    salesmanId: row.salesmanId?.toString() ?? null,
    salesmanName: row.salesman?.name ?? null,
    isActive: row.isActive,
    picCount: row._count.pics,
  };
}

const volume = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

async function assertSectorVisible(db: TenantDb, id: bigint): Promise<void> {
  const sector = await db.industrySector.findFirst({
    where: { id, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (sector === null) throw HttpError.badRequest('That commodity category is not available.');
}

/**
 * The customer types a search term names.
 *
 * Type is an enum column, so `contains` cannot reach it — Postgres will not
 * pattern-match an enum, and casting it in a Prisma filter is not expressible.
 * Matching the term against the values here and passing the survivors as an
 * `in` gets the same answer with a plain equality test.
 *
 * Both the stored value and the label are matched: an operator looking for
 * exporters types "export", not "EXPORTER", and would be equally right either
 * way. An empty result means the term names no type, and the caller leaves the
 * clause out rather than passing `in: []`, which would match nothing at all and
 * quietly break the other search terms beside it.
 */
function typesMatching(term: string): CustomerType[] {
  const needle = term.trim().toLowerCase();
  if (needle === '') return [];
  return CUSTOMER_TYPES.filter(
    (type) =>
      type.toLowerCase().includes(needle) ||
      CUSTOMER_TYPE_LABEL[type].toLowerCase().includes(needle),
  );
}

customerRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = customerListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.customerType !== undefined ? { customerType: query.customerType } : {}),
      // The client calls the commodity category "commodity"; it is the same
      // industry_sector the form already asks for.
      ...(query.industrySectorId !== undefined
        ? { industrySectorId: BigInt(query.industrySectorId) }
        : {}),
      ...(query.businessArea !== undefined ? { businessArea: query.businessArea } : {}),
      /*
       * The search box reaches the type and the commodity as well as the name,
       * because that is what an operator types into it: "garments", or
       * "exporter", expecting the list to narrow. The dropdowns beside it stay
       * — they are for picking one exactly, this is for finding.
       */
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
              { country: { contains: query.search, mode: 'insensitive' as const } },
              {
                industrySector: {
                  name: { contains: query.search, mode: 'insensitive' as const },
                },
              },
              ...(typesMatching(query.search).length > 0
                ? [{ customerType: { in: typesMatching(query.search) } }]
                : []),
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.customer.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.customer.count({ where }),
    ]);
    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<CustomerDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** Options for the commodity-category dropdown. */
/**
 * GET .../currencies — the currency a party's opening balance is entered in.
 *
 * Served from this route rather than reused from Settings so it follows THIS
 * screen's permission: someone who maintains customers should not need
 * SETTING.CURRENCY.VIEW to fill in an opening balance.
 */
customerRouter.get('/currencies', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const rows = await withTenant(auth.tenantId, async (db) => {
    const inactive = await inactiveMasters(db);
    return db.currency.findMany({
      where: { ...excludeInactive(inactive, 'currency'), deletedAt: null, isActive: true },
      select: { id: true, code: true, currency: true },
      orderBy: { code: 'asc' },
    });
  });
  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: rows.map((c) => ({ id: c.id.toString(), name: c.currency })),
  };
  res.json(payload);
});

/**
 * The employees a customer can be assigned to.
 *
 * Behind CRM.CUSTOMER.VIEW rather than the employee feature: this is a picker
 * on the customer form, and whoever may open that form has to be able to fill
 * it in. It returns names and nothing else, so it discloses no more than the
 * customer list already does.
 */
customerRouter.get('/salesmen', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const employees = await withTenant(auth.tenantId, (db) =>
    db.employee.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );
  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: employees.map((e) => ({ id: e.id.toString(), name: e.name })),
  };
  res.json(payload);
});

customerRouter.get('/sectors', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const sectors = await withTenant(auth.tenantId, (db) =>
    db.industrySector.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );
  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: sectors.map((s) => ({ id: s.id.toString(), name: s.name })),
  };
  res.json(payload);
});

customerRouter.get('/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'customer');
  const customer = await withTenant(auth.tenantId, async (db) => {
    const row = await db.customer.findFirst({ where: { id, deletedAt: null }, select: SELECT });
    if (row === null) throw HttpError.notFound('Customer not found.');
    return row;
  });
  const payload: ApiSuccess<CustomerDto> = { success: true, data: toDto(customer) };
  res.json(payload);
});

customerRouter.get('/:id/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'customer');
  const customer = await withTenant(auth.tenantId, async (db) => {
    const row = await db.customer.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true },
    });
    if (row === null) throw HttpError.notFound('Customer not found.');
    return row;
  });
  const payload: ApiSuccess<{ id: string; name: string }> = {
    success: true,
    data: { id: customer.id.toString(), name: customer.name },
  };
  res.json(payload);
});

customerRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = customerInputSchema.parse(req.body);
  const sectorId = parseRefId(input.industrySectorId, 'commodity category');

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertSectorVisible(db, sectorId);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'customer', CODE_PREFIX.customer, auth.tenantId);
      try {
        return await db.customer.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            country: input.country,
            address: input.address || null,
            customerType: input.customerType,
            businessArea: input.businessArea,
            industrySectorId: sectorId,
            exSeaVolumeTeuMonth: volume(input.exSeaVolumeTeuMonth),
            exAirVolumeKgMonth: volume(input.exAirVolumeKgMonth),
            imSeaVolumeTeuMonth: volume(input.imSeaVolumeTeuMonth),
            imAirVolumeKgMonth: volume(input.imAirVolumeKgMonth),
            openingBalance: moneyIn(input.openingBalance),
            openingCurrencyId: refIn(input.openingCurrencyId),
            notes: input.notes || null,
            salesmanId: refIn(input.salesmanId),
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a customer code.');
  });

  const payload: ApiSuccess<CustomerDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

customerRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'customer');
  const input = customerInputSchema.parse(req.body);
  const sectorId = parseRefId(input.industrySectorId, 'commodity category');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.customer.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Customer not found.');
    await assertSectorVisible(db, sectorId);

    return db.customer.update({
      where: { id },
      data: {
        name: input.name,
        country: input.country,
        address: input.address || null,
        customerType: input.customerType,
        businessArea: input.businessArea,
        industrySectorId: sectorId,
        exSeaVolumeTeuMonth: volume(input.exSeaVolumeTeuMonth),
        exAirVolumeKgMonth: volume(input.exAirVolumeKgMonth),
        imSeaVolumeTeuMonth: volume(input.imSeaVolumeTeuMonth),
        imAirVolumeKgMonth: volume(input.imAirVolumeKgMonth),
        openingBalance: moneyIn(input.openingBalance),
        openingCurrencyId: refIn(input.openingCurrencyId),
        notes: input.notes || null,
        salesmanId: refIn(input.salesmanId),
        updatedBy: auth.userId,
      },
      select: SELECT,
    });
  });

  const payload: ApiSuccess<CustomerDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

customerRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'customer');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.customer.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Customer not found.');
      const updated = await db.customer.update({
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
// Customer → PIC
// ===========================================================================

const PIC_SELECT = {
  id: true,
  code: true,
  name: true,
  department: true,
  designation: true,
  mobile: true,
  email: true,
  isActive: true,
} as const;

function picToDto(row: {
  id: bigint;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  mobile: string | null;
  email: string | null;
  isActive: boolean;
}): CustomerPicDto {
  return { ...row, id: row.id.toString() };
}

async function findCustomer(db: TenantDb, id: bigint) {
  const customer = await db.customer.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (customer === null) throw HttpError.notFound('Customer not found.');
  return customer;
}

customerRouter.get('/:id/pics', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const customerId = parseId(req.params.id, 'customer');
  const query = listQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    await findCustomer(db, customerId);
    const where = {
      customerId,
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.customerPic.findMany({
        where,
        select: PIC_SELECT,
        orderBy: [{ name: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.customerPic.count({ where }),
    ]);
    return { rows: rows.map(picToDto), total };
  });

  const payload: ApiSuccess<CustomerPicDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

customerRouter.post('/:id/pics', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const customerId = parseId(req.params.id, 'customer');
  const input = customerPicInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    await findCustomer(db, customerId);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'customerPic', CODE_PREFIX.customerPic, auth.tenantId);
      try {
        return await db.customerPic.create({
          data: {
            tenantId: auth.tenantId,
            code,
            customerId,
            name: input.name,
            department: input.department || null,
            designation: input.designation || null,
            mobile: input.mobile || null,
            email: input.email || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: PIC_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a contact code.');
  });

  const payload: ApiSuccess<CustomerPicDto> = { success: true, data: picToDto(created) };
  res.status(201).json(payload);
});

customerRouter.patch(
  '/:id/pics/:picId',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = parseId(req.params.id, 'customer');
    const picId = parseId(req.params.picId, 'contact');
    const input = customerPicInputSchema.parse(req.body);

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.customerPic.findFirst({
        where: { id: picId, customerId, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) throw HttpError.notFound('Contact not found.');
      return db.customerPic.update({
        where: { id: picId },
        data: {
          name: input.name,
          department: input.department || null,
          designation: input.designation || null,
          mobile: input.mobile || null,
          email: input.email || null,
          updatedBy: auth.userId,
        },
        select: PIC_SELECT,
      });
    });

    const payload: ApiSuccess<CustomerPicDto> = { success: true, data: picToDto(updated) };
    res.json(payload);
  },
);

customerRouter.post(
  '/:id/pics/:picId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = parseId(req.params.id, 'customer');
    const picId = parseId(req.params.picId, 'contact');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.customerPic.findFirst({
        where: { id: picId, customerId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Contact not found.');
      const updated = await db.customerPic.update({
        where: { id: picId },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/**
 * DELETE /api/tenant/.../:id/pics/:picId — CR-002, extended to the contacts.
 *
 * Deactivate retires a contact who was real and has left; Delete removes one
 * that never was — the typo, the duplicate line. Soft, like every delete here
 * (§4 rule 3), so the audit trail and any historical foreign key survive, and
 * refused outright while anything still points at the row: a contact an RFQ
 * was addressed to is part of that record and stays.
 */
customerRouter.delete(
  '/:id/pics/:picId',
  requirePermission(`${FEATURE}.DELETE`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = parseId(req.params.id, 'customer');
    const picId = parseId(req.params.picId, 'contact');

    await withTenant(auth.tenantId, async (db) => {
      const existing = await db.customerPic.findFirst({
        where: { id: picId, customerId, deletedAt: null },
        select: { id: true, tenantId: true, name: true },
      });
      await assertRowDeletable(
        db,
        'customer_pic',
        picId,
        existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
        'Contact not found.',
      );

      await db.customerPic.update({
        where: { id: picId },
        data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
      });
    });

    const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
    res.json(payload);
  },
);

/**
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a customer entered by mistake.
 */
customerRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'customer');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.customer.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'customer',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Customer not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'customer', id, auth.userId);

    await db.customer.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
