import { PrismaPg } from '@prisma/adapter-pg';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Price List and its exports (docs/MODULE_PURCHASE_SALES.md §5.3, §4 rules 2,
 * 7 and 12).
 *
 * The export assertions matter most. §4 rule 12: "never include buy price or
 * profit in an export the user isn't permitted to see." A file is the worse
 * place to leak a margin than a screen is, because a spreadsheet gets
 * forwarded — so these open the generated workbook and read its cells.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG = 'pricelist-test';
const PREFIX = 'PLTEST-';

const LIST_PERMS = [
  'PURCHASE.PRICE_LIST_SEA_FCL.VIEW',
  'PURCHASE.PRICE_LIST_SEA_FCL.EXPORT',
];

let tenantId: bigint;
let tokenAll: string;
/** Price list access, but no VIEW_BUY_PRICE — the sales-executive shape. */
let tokenSales: string;
/** Can view the list but was never granted EXPORT. */
let tokenNoExport: string;

let polId: bigint;
let podAId: bigint;
let podBId: bigint;
let tierId: bigint;

async function makeUser(suffix: string, isSuperadmin: boolean, permissions: string[]) {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${suffix}`,
      username: `user-${suffix}`,
      email: `${suffix}@pl.test`,
      passwordHash: 'x',
      isSuperadmin,
    },
    select: { id: true },
  });
  return signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin,
    permissions,
    tokenVersion: 0,
  });
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM goods_type WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  await cleanup();

  tenantId = (
    await owner.tenant.create({
      data: { name: 'Price List Test', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  tokenAll = await makeUser(`super-${SLUG}`, true, []);
  tokenSales = await makeUser(`sales-${SLUG}`, false, LIST_PERMS);
  tokenNoExport = await makeUser(`noexport-${SLUG}`, false, [
    'PURCHASE.PRICE_LIST_SEA_FCL.VIEW',
  ]);

  const mkPort = async (suffix: string, name: string, portCode: string) =>
    (
      await owner.port.create({
        data: {
          code: `${PREFIX}${suffix}`,
          name,
          portCode,
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;

  polId = await mkPort('POL', 'List Origin', 'PLPOL1');
  podAId = await mkPort('PODA', 'List Dest A', 'PLPDA1');
  podBId = await mkPort('PODB', 'List Dest B', 'PLPDB1');

  const seaType = await owner.carrierType.findFirstOrThrow({
    where: { NOT: { name: { equals: 'Airline', mode: 'insensitive' } } },
    select: { id: true },
  });
  const carrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}CAR`, name: 'List Line', typeId: seaType.id },
      select: { id: true },
    })
  ).id;
  const goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'List Goods' },
      select: { id: true },
    })
  ).id;
  const currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;
  tierId = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}TIER`, mode: 'SEA_FCL', label: 'List Tier', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;

  const mkRate = async (
    code: string,
    podId: bigint,
    status: 'DRAFT' | 'PUBLISHED' | 'EXPIRED',
    validFrom: string,
    validTo: string,
    buyPrice: string,
    profitValue: string,
  ) =>
    owner.freightRate.create({
      data: {
        tenantId,
        code,
        mode: 'SEA_FCL',
        polId,
        podId,
        carrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
        currencyId,
        validFrom: new Date(validFrom),
        validTo: new Date(validTo),
        transitDays: 21,
        freeDays: 14,
        status,
        lines: { create: [{ tierId, buyPrice, profitType: 'FLAT', profitValue }] },
      },
    });

  // Published and current — the default view.
  await mkRate('RATE-PL-A', podAId, 'PUBLISHED', '2026-01-01', '2032-12-31', '1000.0000', '200.0000');
  await mkRate('RATE-PL-B', podBId, 'PUBLISHED', '2026-01-01', '2032-12-31', '3000.0000', '500.0000');
  // A draft — bought but not released to sales.
  await mkRate('RATE-PL-DRAFT', podAId, 'DRAFT', '2026-01-01', '2032-12-31', '9999.0000', '0.0000');
  // Expired — reachable only via Include expired.
  await mkRate('RATE-PL-OLD', podAId, 'EXPIRED', '2020-01-01', '2020-12-31', '500.0000', '50.0000');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function as(token: string) {
  return (path: string) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG);
}

const codesOf = (body: { data: { code: string }[] }): string[] => body.data.map((r) => r.code);

describe('§4 rule 2 — the price list shows what sales may actually quote', () => {
  it('defaults to published rates that are still valid', async () => {
    const response = await as(tokenAll)(
      '/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100',
    );
    expect(response.status).toBe(200);

    const codes = codesOf(response.body);
    expect(codes).toContain('RATE-PL-A');
    expect(codes).toContain('RATE-PL-B');
    // A draft is a bought rate, not a quotable one.
    expect(codes).not.toContain('RATE-PL-DRAFT');
    expect(codes).not.toContain('RATE-PL-OLD');
  });

  it('shows expired rates only when explicitly asked', async () => {
    const response = await as(tokenAll)(
      '/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100&includeExpired=true&status=EXPIRED',
    );
    expect(codesOf(response.body)).toContain('RATE-PL-OLD');
  });
});

describe('§4 rule 7 — multi-POD filtering', () => {
  it('filters to several destinations at once', async () => {
    const both = await as(tokenAll)(
      `/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100&podIds=${podAId},${podBId}`,
    );
    expect(codesOf(both.body).sort()).toEqual(['RATE-PL-A', 'RATE-PL-B']);

    const onlyB = await as(tokenAll)(
      `/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100&podIds=${podBId}`,
    );
    expect(codesOf(onlyB.body)).toEqual(['RATE-PL-B']);
  });
});

describe('§9 Q13 — transit and free days travel with the rate', () => {
  it('returns both on every row', async () => {
    const response = await as(tokenAll)(
      '/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100',
    );
    const rate = response.body.data.find((r: { code: string }) => r.code === 'RATE-PL-A');
    expect(rate.transitDays).toBe(21);
    expect(rate.freeDays).toBe(14);
  });
});

describe('§4 rule 5 — the list itself', () => {
  it('gives sales the sell price and nothing about cost', async () => {
    const response = await as(tokenSales)(
      '/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100',
    );
    expect(response.status).toBe(200);

    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('buyPrice');
    expect(raw).not.toContain('profitValue');
    expect(response.body.data[0].lines[0].sellPrice).toBe('1200.0000');
  });
});

describe('§4 rule 12 — the export carries the same restriction as the screen', () => {
  async function workbookFrom(token: string, query = ''): Promise<ExcelJS.Workbook> {
    const response = await request(app)
      .get(`/api/tenant/purchase/price-list/export?mode=SEA_FCL&format=xlsx${query}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=".*\.xlsx"/);

    // exceljs takes an ArrayBuffer, not a Node Buffer, so hand it the exact
    // slice this Buffer is a view over.
    const bytes = response.body as Buffer;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    return workbook;
  }

  function cellValues(workbook: ExcelJS.Workbook): string[] {
    const values: string[] = [];
    workbook.worksheets[0]!.eachRow((row) => {
      row.eachCell((cell) => values.push(String(cell.value ?? '')));
    });
    return values;
  }

  it('includes the buy price column for a permitted user', async () => {
    const workbook = await workbookFrom(tokenAll);
    const values = cellValues(workbook);

    expect(values.some((v) => v.includes('buy'))).toBe(true);
    expect(values).toContain('1000'); // the buy price, as a real number
    expect(values).toContain('1200'); // the sell price
  });

  it('omits the buy price column entirely for a sales user', async () => {
    const workbook = await workbookFrom(tokenSales);
    const values = cellValues(workbook);

    // No buy column header, and the cost figure appears nowhere in the file.
    expect(values.some((v) => v.toLowerCase().includes('buy'))).toBe(false);
    expect(values).not.toContain('1000');
    expect(values).not.toContain('3000');
    // What they are entitled to is intact.
    expect(values).toContain('1200');
    expect(values).toContain('3500');
  });

  it('exports exactly the filtered rows, not the whole table', async () => {
    const workbook = await workbookFrom(tokenAll, `&podIds=${podBId}`);
    const values = cellValues(workbook);

    expect(values).toContain('RATE-PL-B');
    expect(values).not.toContain('RATE-PL-A');
    // And the filters still exclude drafts and expired rates.
    expect(values).not.toContain('RATE-PL-DRAFT');
  });

  it('produces a PDF with the right content type', async () => {
    const response = await request(app)
      .get('/api/tenant/purchase/price-list/export?mode=SEA_FCL&format=pdf')
      .set('Authorization', `Bearer ${tokenAll}`)
      .set('X-Tenant-Slug', SLUG)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toMatch(/\.pdf"/);
    // A real PDF, not an error page with the wrong header.
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses the export to a user without EXPORT', async () => {
    const response = await as(tokenNoExport)(
      '/api/tenant/purchase/price-list/export?mode=SEA_FCL&format=xlsx',
    );
    expect(response.status).toBe(403);
  });

  it('still lets that user view the list', async () => {
    const response = await as(tokenNoExport)(
      '/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100',
    );
    expect(response.status).toBe(200);
  });
});

describe('§7 — the price list is its own permission', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request(app)
      .get('/api/tenant/purchase/price-list?mode=SEA_FCL')
      .set('X-Tenant-Slug', SLUG);
    expect(response.status).toBe(401);
  });

  it('does not let an FCL price list open the Air one', async () => {
    const response = await as(tokenSales)('/api/tenant/purchase/price-list?mode=AIR');
    expect(response.status).toBe(403);
  });
});
