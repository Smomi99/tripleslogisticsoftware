import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * CRM → Customer → Email prices, through HTTP (2026-09-29).
 *
 * The properties worth a test each: it writes to exactly the customers the
 * list's filters select; it reads exactly what the Price List offers, selling
 * side only; every customer gets their own letter with replies to the Price
 * team; and nothing crosses into another workspace.
 *
 * DNS is replaced — `nowhere.test` does not exist, every other domain takes
 * mail — so the suite does not depend on the public internet.
 */

vi.mock('../lib/email-domain', () => ({
  domainVerdict: (domain: string) =>
    Promise.resolve(domain === 'nowhere.test' ? 'no-such-domain' : 'accepts-mail'),
}));

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'cpe-alpha';
const OTHER = 'cpe-beta';
const BASE = '/api/tenant/crm/customer-price-email';

let tenantId: bigint;
let token: string;
/** Customer VIEW and PRICE_EMAIL, but no Price List at all. */
let tokenNoPriceList: string;
/** Customer VIEW only. */
let tokenNoEmail: string;

let garments: bigint;
const customer: Record<'one' | 'two' | 'leather' | 'inactive' | 'bare', bigint> = {
  one: 0n,
  two: 0n,
  leather: 0n,
  inactive: 0n,
  bare: 0n,
};
let pol: bigint;
let hamburg: bigint;
let rotterdam: bigint;
let antwerp: bigint;
let airportId: bigint;
let closedId: bigint;
let quietId: bigint;
let carrierA: bigint;
let carrierB: bigint;
const rateId = { hamburg: '', rotterdam: '', lapsed: '', draft: '' };

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG}', '${OTHER}'))`;
  await owner.$executeRawUnsafe(
    `UPDATE tenant SET currency_id = NULL WHERE slug IN ('${SLUG}', '${OTHER}')`,
  );
  for (const table of [
    'email_log',
    'notification_setting',
    'customer_pic',
    'customer',
    'industry_sector',
    'rate_local_charge',
    'freight_rate_line',
    'freight_rate',
    'cost_head',
    'audit_log',
    '"user"',
    'employee',
    'goods_type',
    'currency',
    'carrier',
    'port',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG}', '${OTHER}')`);
}

const get = (path: string, bearer = token) =>
  request(app).get(`${BASE}${path}`).set('Authorization', `Bearer ${bearer}`).set('X-Tenant-Slug', SLUG);
const post = (path: string, body: object, bearer = token) =>
  request(app)
    .post(`${BASE}${path}`)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Tenant-Slug', SLUG)
    .send(body);

async function makeCustomer(
  t: bigint,
  code: string,
  name: string,
  sector: bigint,
  over: { customerType?: 'EXPORTER' | 'IMPORTER'; isActive?: boolean } = {},
): Promise<bigint> {
  return (
    await owner.customer.create({
      data: {
        tenantId: t,
        code,
        name,
        country: 'Bangladesh',
        customerType: over.customerType ?? 'EXPORTER',
        businessArea: 'BOTH',
        industrySectorId: sector,
        isActive: over.isActive ?? true,
      },
      select: { id: true },
    })
  ).id;
}

async function pic(
  t: bigint,
  customerId: bigint,
  code: string,
  email: string,
  over: { isActive?: boolean; deletedAt?: Date } = {},
): Promise<void> {
  await owner.customerPic.create({
    data: { tenantId: t, customerId, code, name: `PIC ${code}`, email, ...over },
  });
}

beforeAll(async () => {
  await cleanup();
  tenantId = (
    await owner.tenant.create({
      data: { name: 'CPE Alpha', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  const employee = await owner.employee.create({
    data: {
      tenantId,
      code: 'EMP-CPE',
      name: 'Rahim Uddin',
      country: 'Bangladesh',
      designation: 'Pricing Manager',
    },
    select: { id: true },
  });
  const admin = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-cpe',
      username: 'admin-cpe',
      email: 'a@cpe.test',
      passwordHash: 'x',
      isSuperadmin: true,
      employeeId: employee.id,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: admin.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  const limited = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-cpe-2',
      username: 'limited-cpe',
      email: 'l@cpe.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  const limitedToken = (permissions: string[]) =>
    signAccessToken({
      sub: limited.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      permissions,
      tokenVersion: 0,
    });
  tokenNoPriceList = await limitedToken(['CRM.CUSTOMER.VIEW', 'CRM.CUSTOMER.PRICE_EMAIL']);
  tokenNoEmail = await limitedToken(['CRM.CUSTOMER.VIEW']);

  await owner.notificationSetting.create({
    data: { tenantId, priceTeamEmails: 'pricing@cpe.test', signatureBlock: 'CPE Freight Ltd' },
  });

  // -------------------------------------------------------------- customers
  garments = (
    await owner.industrySector.create({
      data: { tenantId, code: 'CPE-G', name: 'Garments' },
      select: { id: true },
    })
  ).id;
  const leather = (
    await owner.industrySector.create({
      data: { tenantId, code: 'CPE-L', name: 'Leather' },
      select: { id: true },
    })
  ).id;

  customer.one = await makeCustomer(tenantId, 'CPE-1', 'CPE Garments One', garments);
  // Two addresses in one field, a repeat in another case, one malformed, and
  // two contacts that must not be read at all.
  await pic(tenantId, customer.one, 'P1', 'ops@one.test; md@one.test');
  await pic(tenantId, customer.one, 'P2', 'OPS@one.test');
  await pic(tenantId, customer.one, 'P3', 'bad-address');
  await pic(tenantId, customer.one, 'P4', 'hidden@one.test', { isActive: false });
  await pic(tenantId, customer.one, 'P5', 'gone@one.test', { deletedAt: new Date() });

  customer.two = await makeCustomer(tenantId, 'CPE-2', 'CPE Garments Two', garments);
  await pic(tenantId, customer.two, 'P6', 'x@nowhere.test');

  customer.leather = await makeCustomer(tenantId, 'CPE-3', 'CPE Leather', leather, {
    customerType: 'IMPORTER',
  });
  await pic(tenantId, customer.leather, 'P7', 'c@three.test');

  customer.inactive = await makeCustomer(tenantId, 'CPE-4', 'CPE Inactive', garments, {
    isActive: false,
  });
  await pic(tenantId, customer.inactive, 'P8', 'd@four.test');

  customer.bare = await makeCustomer(tenantId, 'CPE-5', 'CPE No Contact', garments);

  // ------------------------------------------------------------------ rates
  const port = async (
    code: string,
    name: string,
    over: { type?: 'SEAPORT' | 'AIRPORT'; isActive?: boolean } = {},
  ) =>
    (
      await owner.port.create({
        data: {
          tenantId,
          code,
          name,
          portCode: code,
          country: 'X',
          type: over.type ?? 'SEAPORT',
          isActive: over.isActive ?? true,
        },
        select: { id: true },
      })
    ).id;
  pol = await port('CPEPOL', 'Chattogram');
  hamburg = await port('CPEHAM', 'Hamburg');
  rotterdam = await port('CPEROT', 'Rotterdam');
  antwerp = await port('CPEANR', 'Antwerp');
  // No rate touches these three; only the last is a sea port that may be offered.
  airportId = await port('CPEDAC', 'Dhaka Airport', { type: 'AIRPORT' });
  closedId = await port('CPEOLD', 'Closed Port', { isActive: false });
  quietId = await port('CPEQUI', 'Quiet Harbour');

  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  const carrier = async (code: string, name: string) =>
    (
      await owner.carrier.create({
        data: { tenantId, code, name, typeId: carrierType.id },
        select: { id: true },
      })
    ).id;
  carrierA = await carrier('CPE-CA', 'Alpha Lines');
  carrierB = await carrier('CPE-CB', 'Beta Lines');

  const goods = (
    await owner.goodsType.create({
      data: { tenantId, code: 'CPE-GD', name: 'General' },
      select: { id: true },
    })
  ).id;
  const usd = (
    await owner.currency.create({
      data: { tenantId, code: 'CPE-USD', currency: 'USD — US Dollar', conversion: '1.0000' },
      select: { id: true },
    })
  ).id;
  const tier = await owner.rateTier.findFirstOrThrow({
    where: { code: 'FCL-20STD' },
    select: { id: true },
  });

  const day = 86_400_000;
  const rate = async (
    code: string,
    podId: bigint,
    carrierId: bigint,
    over: { status?: 'PUBLISHED' | 'DRAFT'; validFrom?: Date; validTo?: Date } = {},
  ) => {
    const made = await owner.freightRate.create({
      data: {
        tenantId,
        code,
        mode: 'SEA_FCL',
        polId: pol,
        podId,
        carrierId,
        goodsTypeId: goods,
        currencyId: usd,
        validFrom: over.validFrom ?? new Date(Date.now() - day),
        validTo: over.validTo ?? new Date(Date.now() + 30 * day),
        status: over.status ?? 'PUBLISHED',
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
      },
      select: { id: true },
    });
    // sell_price is GENERATED from buy + profit: 1100 + 150 = 1250.
    await owner.freightRateLine.create({
      data: {
        tenantId,
        rateId: made.id,
        tierId: tier.id,
        buyPrice: '1100.0000',
        profitType: 'FLAT',
        profitValue: '150.0000',
      },
    });
    return made.id.toString();
  };
  rateId.hamburg = await rate('CPE-R1', hamburg, carrierA);
  rateId.rotterdam = await rate('CPE-R2', rotterdam, carrierB);
  // Lapsed, and never published: neither is on offer.
  rateId.lapsed = await rate('CPE-R3', hamburg, carrierA, {
    validFrom: new Date(Date.now() - 60 * day),
    validTo: new Date(Date.now() - 3 * day),
  });
  rateId.draft = await rate('CPE-R4', antwerp, carrierA, { status: 'DRAFT' });
  // Charges on the Hamburg rate, for the second table in the email.
  const unit = await owner.costUnit.findFirstOrThrow({ select: { id: true } });
  const thc = await owner.costHead.create({
    data: { tenantId, code: 'CPE-CH', name: 'Terminal Handling', category: 'SERVICE', unitId: unit.id },
    select: { id: true },
  });
  await owner.rateLocalCharge.create({
    data: {
      tenantId,
      rateId: BigInt(rateId.hamburg),
      costHeadId: thc.id,
      side: 'POL',
      amount: '85.0000',
      currencyId: usd,
    },
  });

  // ------------------------------------------- another workspace, alike
  const other = (
    await owner.tenant.create({
      data: { name: 'CPE Beta', slug: OTHER, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;
  const otherSector = (
    await owner.industrySector.create({
      data: { tenantId: other, code: 'CPE-G', name: 'Garments' },
      select: { id: true },
    })
  ).id;
  const stranger = await makeCustomer(other, 'CPE-9', 'CPE Garments Stranger', otherSector);
  await pic(other, stranger, 'P9', 'stranger@beta.test');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

type Recipient = {
  partyId: string;
  partyName: string;
  emails: { address: string; valid: boolean; reason: string | null }[];
};
const recipientsOf = (res: request.Response) =>
  (res.body as { data: { recipients: Recipient[] } }).data.recipients;

describe('who it goes to', () => {
  it('selects what the Customer list filters select, active customers only', async () => {
    const res = await get(`/recipients?customerType=EXPORTER&industrySectorId=${garments}`).expect(
      200,
    );
    expect(recipientsOf(res).map((c) => c.partyName)).toEqual([
      'CPE Garments One',
      'CPE Garments Two',
      'CPE No Contact',
    ]);
  });

  it('reaches the same fields with the search box', async () => {
    const res = await get('/recipients?search=leather').expect(200);
    expect(recipientsOf(res).map((c) => c.partyName)).toEqual(['CPE Leather']);
  });

  it('splits, de-duplicates and checks every address on the active contacts', async () => {
    const res = await get('/recipients?search=CPE%20Garments').expect(200);
    const [one, two] = recipientsOf(res);

    expect(one?.emails.map((e) => [e.address, e.valid])).toEqual([
      ['ops@one.test', true],
      ['md@one.test', true],
      ['bad-address', false],
    ]);
    expect(one?.emails[2]?.reason).toMatch(/Missing the @/);
    expect(two?.emails[0]?.valid).toBe(false);
    expect(two?.emails[0]?.reason).toMatch(/nowhere\.test does not exist/);
  });

  it('never lists another workspace’s customer', async () => {
    const res = await get('/recipients?search=Stranger').expect(200);
    expect(recipientsOf(res)).toEqual([]);
  });

  it('checks a corrected address the same way', async () => {
    const res = await post('/check', { addresses: ['x@nowhere.test', 'ok@one.test'] }).expect(200);
    expect((res.body.data as { valid: boolean }[]).map((r) => r.valid)).toEqual([false, true]);
  });

  it('needs PRICE_EMAIL', async () => {
    await get('/recipients', tokenNoEmail).expect(403);
  });
});

describe('the rates', () => {
  it('offers every active port of the mode, rate or no rate — as the Price List does', async () => {
    const res = await get('/options?mode=SEA_FCL').expect(200);
    const data = res.body.data as {
      pols: { id: string; name: string }[];
      pods: { id: string }[];
      carriers: { id: string }[];
    };
    const pols = data.pols.map((p) => p.id);
    // Every sea port, including one no rate touches.
    for (const id of [pol, hamburg, rotterdam, antwerp, quietId]) expect(pols).toContain(id.toString());
    expect(data.pols.find((p) => p.id === quietId.toString())?.name).toBe('Quiet Harbour (CPEQUI)');
    // Not an airport on a sea list, and not a port somebody switched off.
    expect(pols).not.toContain(airportId.toString());
    expect(pols).not.toContain(closedId.toString());
    expect(data.pods.map((p) => p.id)).toEqual(pols);
    expect(data.carriers.map((c) => c.id)).toEqual(
      expect.arrayContaining([carrierA.toString(), carrierB.toString()]),
    );
  });

  it('offers airports, not sea ports, for Air', async () => {
    const res = await get('/options?mode=AIR').expect(200);
    const pols = (res.body.data as { pols: { id: string }[] }).pols.map((p) => p.id);
    expect(pols).toContain(airportId.toString());
    expect(pols).not.toContain(pol.toString());
  });

  it('reads the Price List’s rows, and never the buying side', async () => {
    const res = await get(`/rates?mode=SEA_FCL&polIds=${pol}&podIds=${hamburg},${rotterdam}`).expect(
      200,
    );
    const rates = res.body.data.rates as { code: string; lines: { sellPrice: string }[] }[];
    expect(rates.map((r) => r.code).sort()).toEqual(['CPE-R1', 'CPE-R2']);
    expect(rates[0]?.lines[0]?.sellPrice).toBe('1250.0000');
    // Even for a superadmin, who may see cost on the Price List screen itself.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('buyPrice');
    expect(raw).not.toContain('profitType');
    expect(raw).not.toContain('profitValue');
  });

  it('narrows to a carrier when one is picked', async () => {
    const res = await get(
      `/rates?mode=SEA_FCL&polIds=${pol}&podIds=${hamburg},${rotterdam}&carrierId=${carrierB}`,
    ).expect(200);
    expect((res.body.data.rates as { code: string }[]).map((r) => r.code)).toEqual(['CPE-R2']);
  });

  it('takes one end alone, or just a carrier, since the lanes are optional (2026-10-07)', async () => {
    const codes = (res: { body: { data: { rates: { code: string }[] } } }) =>
      res.body.data.rates.map((r) => r.code).sort();
    expect(codes(await get(`/rates?mode=SEA_FCL&polIds=${pol}`).expect(200))).toEqual([
      'CPE-R1',
      'CPE-R2',
    ]);
    expect(codes(await get(`/rates?mode=SEA_FCL&podIds=${hamburg}`).expect(200))).toEqual(['CPE-R1']);
    expect(codes(await get(`/rates?mode=SEA_FCL&carrierId=${carrierB}`).expect(200))).toEqual([
      'CPE-R2',
    ]);
  });

  it('looks nothing up with nothing picked', async () => {
    await get('/rates?mode=SEA_FCL').expect(400);
  });

  it('refuses a list at both ends', async () => {
    await get(
      `/rates?mode=SEA_FCL&polIds=${pol},${antwerp}&podIds=${hamburg},${rotterdam}`,
    ).expect(400);
  });

  it('needs the Price List as well — nobody emails prices they may not see', async () => {
    const res = await get(`/rates?mode=SEA_FCL&polIds=${pol}&podIds=${hamburg}`, tokenNoPriceList);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('Sea FCL price list');
  });

  it('names the Price team, and signs off with the email signature alone', async () => {
    const res = await get('/context').expect(200);
    // The sender is employee Rahim Uddin, Pricing Manager — deliberately not
    // in the sign-off: the signature already says who is writing.
    expect(res.body.data).toEqual({
      priceTeamEmails: ['pricing@cpe.test'],
      signOff: 'CPE Freight Ltd',
      modes: ['SEA_FCL', 'SEA_LCL', 'AIR'],
    });
  });
});

describe('sending', () => {
  // A function: the rate ids exist only once beforeAll has run.
  const letter = (rateIds = [rateId.hamburg]) => ({
    subject: 'Sea FCL rates: Chattogram to Hamburg',
    message: 'Please find our latest rates.',
    mode: 'SEA_FCL',
    rateIds,
    includeLocalCharges: true,
  });

  it('writes one letter per customer, to their own addresses, replies to the Price team', async () => {
    const res = await post('/send', {
      ...letter(),
      recipients: [
        { partyId: customer.one.toString(), emails: ['ops@one.test', 'md@one.test'] },
        { partyId: customer.leather.toString(), emails: ['c@three.test'] },
      ],
    }).expect(200);
    expect(res.body.data).toEqual({ queued: 2 });

    const rows = await owner.emailLog.findMany({
      where: { tenantId, templateKey: 'CUSTOMER_PRICE_OFFER' },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.toAddresses)).toEqual([
      ['ops@one.test', 'md@one.test'],
      ['c@three.test'],
    ]);
    for (const row of rows) {
      expect(row.replyToAddresses).toEqual(['pricing@cpe.test']);
      expect(row.subject).toBe(letter().subject);
      // The text part, for clients that will not show the table.
      expect(row.bodyText).toContain('• 20STD: USD 1,250.00 per container');
      // Opened generically, signed with the email signature alone.
      expect(row.bodyText.startsWith('Dear Sir/Madam,\n')).toBe(true);
      expect(row.bodyText.endsWith('\n\nCPE Freight Ltd')).toBe(true);
      expect(row.bodyText).not.toContain('Kind regards');
      expect(row.bodyHtml).not.toContain('Kind regards');
      expect(row.bodyHtml).toContain('>Dear Sir/Madam,</p>');
      for (const part of [row.bodyText, row.bodyHtml ?? '']) {
        expect(part).not.toContain('Rahim Uddin');
        expect(part).not.toContain('Pricing Manager');
        expect(part).not.toContain('CPE Garments One');
        expect(part).not.toContain('CPE Leather');
      }
      // The table, read back from the Price List rather than taken from the screen.
      expect(row.bodyHtml).toContain('<table');
      expect(row.bodyHtml).toContain('Chattogram to Hamburg');
      expect(row.bodyHtml).toContain('prices in USD per container');
      expect(row.bodyHtml).toContain('>1,250.00</td>');
      expect(row.bodyHtml).toContain('Origin and destination charges');
      expect(row.bodyHtml).toContain('Terminal Handling');
      expect(row.bodyHtml).not.toContain('1,100');
      expect(row.relatedType).toBe('customer');
    }
    // The same letter, but each still recorded against its own customer.
    expect(rows[0]?.bodyHtml).toBe(rows[1]?.bodyHtml);
    expect(rows.map((r) => r.relatedId)).toEqual([customer.one, customer.leather]);
  });

  it('leaves the charges table out when asked', async () => {
    await post('/send', {
      ...letter(),
      includeLocalCharges: false,
      recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
    }).expect(200);
    const row = await owner.emailLog.findFirstOrThrow({
      where: { tenantId, templateKey: 'CUSTOMER_PRICE_OFFER' },
      orderBy: { id: 'desc' },
    });
    expect(row.bodyHtml).toContain('>1,250.00</td>');
    expect(row.bodyHtml).not.toContain('Terminal Handling');
  });

  it('sends a message only when no rate is picked (2026-10-07), Price List or not', async () => {
    for (const bearer of [token, tokenNoPriceList]) {
      await post(
        '/send',
        {
          subject: 'Office closed on Friday',
          message: 'Our office is closed this Friday.',
          rateIds: [],
          recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
        },
        bearer,
      ).expect(200);
      const row = await owner.emailLog.findFirstOrThrow({
        where: { tenantId, templateKey: 'CUSTOMER_PRICE_OFFER' },
        orderBy: { id: 'desc' },
      });
      expect(row.subject).toBe('Office closed on Friday');
      expect(row.bodyHtml).toContain('Our office is closed this Friday.');
      expect(row.bodyHtml).not.toContain('<table');
      expect(row.bodyText).not.toContain('•');
      expect(row.replyToAddresses).toEqual(['pricing@cpe.test']);
    }
  });

  it('still needs a mode when rates are picked', async () => {
    const { mode: _mode, ...noMode } = letter();
    await post('/send', {
      ...noMode,
      recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
    }).expect(400);
  });

  it('refuses a rate that is not on offer — lapsed or never published — and sends nothing', async () => {
    const before = await owner.emailLog.count({ where: { tenantId } });
    for (const stale of [rateId.lapsed, rateId.draft]) {
      const res = await post('/send', {
        ...letter([rateId.hamburg, stale]),
        recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('no longer on offer');
    }
    expect(await owner.emailLog.count({ where: { tenantId } })).toBe(before);
  });

  it('needs the Price List for the mode it sends', async () => {
    await post(
      '/send',
      {
        ...letter(),
        recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
      },
      tokenNoPriceList,
    ).expect(403);
  });

  it('refuses a malformed address, naming it, and sends nothing', async () => {
    const before = await owner.emailLog.count({ where: { tenantId } });
    const res = await post('/send', {
      ...letter(),
      recipients: [{ partyId: customer.one.toString(), emails: ['ops@one.test', 'bad-address'] }],
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain('bad-address');
    expect(await owner.emailLog.count({ where: { tenantId } })).toBe(before);
  });

  it('refuses an inactive customer, and another workspace’s', async () => {
    await post('/send', {
      ...letter(),
      recipients: [{ partyId: customer.inactive.toString(), emails: ['d@four.test'] }],
    }).expect(400);

    const stranger = await owner.customer.findFirstOrThrow({
      where: { name: 'CPE Garments Stranger' },
      select: { id: true },
    });
    await post('/send', {
      ...letter(),
      recipients: [{ partyId: stranger.id.toString(), emails: ['stranger@beta.test'] }],
    }).expect(400);
    expect(await owner.emailLog.count({ where: { toAddresses: { has: 'stranger@beta.test' } } })).toBe(0);
  });

  it('refuses to send while no Price team is set', async () => {
    await owner.notificationSetting.updateMany({ where: { tenantId }, data: { priceTeamEmails: null } });
    try {
      const res = await post('/send', {
        ...letter(),
        recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('Price team');
    } finally {
      await owner.notificationSetting.updateMany({
        where: { tenantId },
        data: { priceTeamEmails: 'pricing@cpe.test' },
      });
    }
  });

  it('needs PRICE_EMAIL', async () => {
    await post(
      '/send',
      {
        ...letter(),
        recipients: [{ partyId: customer.leather.toString(), emails: ['c@three.test'] }],
      },
      tokenNoEmail,
    ).expect(403);
  });
});
