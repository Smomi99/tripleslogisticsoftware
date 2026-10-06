import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * CRM → Agent → Email prices, through HTTP (2026-10-06).
 *
 * The screen, the rates and the letter are the customer's, and
 * customer-price-email.route.test covers them in depth. What is the agent's
 * own is worth a test each: it writes to exactly the agents the Agent list's
 * filters select; it needs the agent permission, not the customer one; the
 * letter is recorded against the agent, selling side only; and nothing crosses
 * into another workspace.
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

const SLUG = 'ape-alpha';
const OTHER = 'ape-beta';
const BASE = '/api/tenant/crm/agent-price-email';

let tenantId: bigint;
let token: string;
/** Customer VIEW and PRICE_EMAIL, and the Price List — but nothing of the agent's. */
let tokenCustomerOnly: string;

const agent: Record<'hamburg' | 'rotterdam' | 'exclusive' | 'inactive' | 'bare', bigint> = {
  hamburg: 0n,
  rotterdam: 0n,
  exclusive: 0n,
  inactive: 0n,
  bare: 0n,
};
let pol: bigint;
let hamburg: bigint;
const rateId = { hamburg: '' };

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG}', '${OTHER}'))`;
  await owner.$executeRawUnsafe(
    `UPDATE tenant SET currency_id = NULL WHERE slug IN ('${SLUG}', '${OTHER}')`,
  );
  for (const table of [
    'email_log',
    'notification_setting',
    'agent_pic',
    'agent',
    'freight_rate_line',
    'freight_rate',
    'audit_log',
    '"user"',
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

async function makeAgent(
  t: bigint,
  code: string,
  name: string,
  over: { agentType?: 'GENERAL' | 'EXCLUSIVE'; isActive?: boolean; country?: string } = {},
): Promise<bigint> {
  return (
    await owner.agent.create({
      data: {
        tenantId: t,
        code,
        name,
        country: over.country ?? 'Germany',
        agentType: over.agentType ?? 'GENERAL',
        isActive: over.isActive ?? true,
      },
      select: { id: true },
    })
  ).id;
}

async function pic(
  t: bigint,
  agentId: bigint,
  code: string,
  email: string,
  over: { isActive?: boolean; deletedAt?: Date } = {},
): Promise<void> {
  await owner.agentPic.create({
    data: { tenantId: t, agentId, code, name: `PIC ${code}`, email, ...over },
  });
}

beforeAll(async () => {
  await cleanup();
  tenantId = (
    await owner.tenant.create({
      data: { name: 'APE Alpha', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  const admin = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-ape',
      username: 'admin-ape',
      email: 'a@ape.test',
      passwordHash: 'x',
      isSuperadmin: true,
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
      code: 'USR-ape-2',
      username: 'limited-ape',
      email: 'l@ape.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenCustomerOnly = await signAccessToken({
    sub: limited.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [
      'CRM.CUSTOMER.VIEW',
      'CRM.CUSTOMER.PRICE_EMAIL',
      'CRM.AGENT.VIEW',
      'PURCHASE.PRICE_LIST_SEA_FCL.VIEW',
    ],
    tokenVersion: 0,
  });

  await owner.notificationSetting.create({
    data: { tenantId, priceTeamEmails: 'pricing@ape.test', signatureBlock: 'APE Freight Ltd' },
  });

  // ----------------------------------------------------------------- agents
  agent.hamburg = await makeAgent(tenantId, 'APE-1', 'APE Hamburg Partner');
  // Two addresses in one field, a repeat in another case, one malformed, and
  // two contacts that must not be read at all.
  await pic(tenantId, agent.hamburg, 'P1', 'ops@ham.test; md@ham.test');
  await pic(tenantId, agent.hamburg, 'P2', 'OPS@ham.test');
  await pic(tenantId, agent.hamburg, 'P3', 'bad-address');
  await pic(tenantId, agent.hamburg, 'P4', 'hidden@ham.test', { isActive: false });
  await pic(tenantId, agent.hamburg, 'P5', 'gone@ham.test', { deletedAt: new Date() });

  agent.rotterdam = await makeAgent(tenantId, 'APE-2', 'APE Rotterdam Partner', {
    country: 'Netherlands',
  });
  await pic(tenantId, agent.rotterdam, 'P6', 'x@nowhere.test');

  agent.exclusive = await makeAgent(tenantId, 'APE-3', 'APE Exclusive', {
    agentType: 'EXCLUSIVE',
  });
  await pic(tenantId, agent.exclusive, 'P7', 'c@excl.test');

  agent.inactive = await makeAgent(tenantId, 'APE-4', 'APE Inactive', { isActive: false });
  await pic(tenantId, agent.inactive, 'P8', 'd@four.test');

  agent.bare = await makeAgent(tenantId, 'APE-5', 'APE No Contact');

  // ------------------------------------------------------------------ rates
  const port = async (code: string, name: string) =>
    (
      await owner.port.create({
        data: { tenantId, code, name, portCode: code, country: 'X', type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  pol = await port('APEPOL', 'Chattogram');
  hamburg = await port('APEHAM', 'Hamburg');

  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  const carrier = (
    await owner.carrier.create({
      data: { tenantId, code: 'APE-CA', name: 'Alpha Lines', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  const goods = (
    await owner.goodsType.create({
      data: { tenantId, code: 'APE-GD', name: 'General' },
      select: { id: true },
    })
  ).id;
  const usd = (
    await owner.currency.create({
      data: { tenantId, code: 'APE-USD', currency: 'USD — US Dollar', conversion: '1.0000' },
      select: { id: true },
    })
  ).id;
  const tier = await owner.rateTier.findFirstOrThrow({
    where: { code: 'FCL-20STD' },
    select: { id: true },
  });

  const day = 86_400_000;
  const made = await owner.freightRate.create({
    data: {
      tenantId,
      code: 'APE-R1',
      mode: 'SEA_FCL',
      polId: pol,
      podId: hamburg,
      carrierId: carrier,
      goodsTypeId: goods,
      currencyId: usd,
      validFrom: new Date(Date.now() - day),
      validTo: new Date(Date.now() + 30 * day),
      status: 'PUBLISHED',
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrier,
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
  rateId.hamburg = made.id.toString();

  // ------------------------------------------- another workspace, alike
  const other = (
    await owner.tenant.create({
      data: { name: 'APE Beta', slug: OTHER, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;
  const stranger = await makeAgent(other, 'APE-9', 'APE Hamburg Stranger');
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
  it('selects what the Agent list filters select, active agents only', async () => {
    const res = await get('/recipients?agentType=GENERAL').expect(200);
    expect(recipientsOf(res).map((a) => a.partyName)).toEqual([
      'APE Hamburg Partner',
      'APE No Contact',
      'APE Rotterdam Partner',
    ]);
  });

  it('reaches the same fields with the search box — the country included', async () => {
    const res = await get('/recipients?search=netherlands').expect(200);
    expect(recipientsOf(res).map((a) => a.partyName)).toEqual(['APE Rotterdam Partner']);
  });

  it('splits, de-duplicates and checks every address on the active contacts', async () => {
    const res = await get('/recipients?search=Partner').expect(200);
    const [ham, rot] = recipientsOf(res);

    expect(ham?.partyId).toBe(agent.hamburg.toString());
    expect(ham?.emails.map((e) => [e.address, e.valid])).toEqual([
      ['ops@ham.test', true],
      ['md@ham.test', true],
      ['bad-address', false],
    ]);
    expect(ham?.emails[2]?.reason).toMatch(/Missing the @/);
    expect(rot?.emails[0]?.valid).toBe(false);
    expect(rot?.emails[0]?.reason).toMatch(/nowhere\.test does not exist/);
  });

  it('never lists another workspace’s agent', async () => {
    const res = await get('/recipients?search=Stranger').expect(200);
    expect(recipientsOf(res)).toEqual([]);
  });

  it('needs the agent’s PRICE_EMAIL — the customer’s does not reach it', async () => {
    await get('/recipients', tokenCustomerOnly).expect(403);
    await get('/context', tokenCustomerOnly).expect(403);
    await post('/check', { addresses: ['ok@ham.test'] }, tokenCustomerOnly).expect(403);
  });
});

describe('the rates', () => {
  it('reads the Price List’s rows, and never the buying side', async () => {
    const res = await get(`/rates?mode=SEA_FCL&polIds=${pol}&podIds=${hamburg}`).expect(200);
    const rates = res.body.data.rates as { code: string; lines: { sellPrice: string }[] }[];
    expect(rates.map((r) => r.code)).toEqual(['APE-R1']);
    expect(rates[0]?.lines[0]?.sellPrice).toBe('1250.0000');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('buyPrice');
    expect(raw).not.toContain('profitValue');
  });

  it('names the Price team, and signs off with the email signature alone', async () => {
    const res = await get('/context').expect(200);
    expect(res.body.data).toEqual({
      priceTeamEmails: ['pricing@ape.test'],
      signOff: 'APE Freight Ltd',
      modes: ['SEA_FCL', 'SEA_LCL', 'AIR'],
    });
  });
});

describe('sending', () => {
  // A function: the rate id exists only once beforeAll has run.
  const letter = () => ({
    subject: 'Sea FCL rates: Chattogram to Hamburg',
    message: 'Please find our latest rates.',
    mode: 'SEA_FCL',
    rateIds: [rateId.hamburg],
    includeLocalCharges: true,
  });

  it('writes one letter per agent, to their own addresses, replies to the Price team', async () => {
    const res = await post('/send', {
      ...letter(),
      recipients: [
        { partyId: agent.hamburg.toString(), emails: ['ops@ham.test', 'md@ham.test'] },
        { partyId: agent.exclusive.toString(), emails: ['c@excl.test'] },
      ],
    }).expect(200);
    expect(res.body.data).toEqual({ queued: 2 });

    const rows = await owner.emailLog.findMany({
      where: { tenantId, templateKey: 'AGENT_PRICE_OFFER' },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.toAddresses)).toEqual([['c@excl.test'], ['ops@ham.test', 'md@ham.test']]);
    for (const row of rows) {
      expect(row.replyToAddresses).toEqual(['pricing@ape.test']);
      expect(row.subject).toBe(letter().subject);
      expect(row.bodyText).toContain('• 20STD: USD 1,250.00 per container');
      expect(row.bodyText.startsWith('Dear Sir/Madam,\n')).toBe(true);
      expect(row.bodyText.endsWith('\n\nAPE Freight Ltd')).toBe(true);
      expect(row.bodyHtml).toContain('>1,250.00</td>');
      // Selling side only, to an agent as to a customer.
      expect(row.bodyHtml).not.toContain('1,100');
      expect(row.bodyText).not.toContain('1,100');
      for (const part of [row.bodyText, row.bodyHtml ?? '']) {
        expect(part).not.toContain('APE Hamburg Partner');
        expect(part).not.toContain('APE Exclusive');
      }
      expect(row.relatedType).toBe('agent');
    }
    // Recorded against each agent, in the order they were listed: by name.
    expect(rows.map((r) => r.relatedId)).toEqual([agent.exclusive, agent.hamburg]);
  });

  it('refuses an inactive agent, and another workspace’s', async () => {
    await post('/send', {
      ...letter(),
      recipients: [{ partyId: agent.inactive.toString(), emails: ['d@four.test'] }],
    }).expect(400);

    const stranger = await owner.agent.findFirstOrThrow({
      where: { name: 'APE Hamburg Stranger' },
      select: { id: true },
    });
    await post('/send', {
      ...letter(),
      recipients: [{ partyId: stranger.id.toString(), emails: ['stranger@beta.test'] }],
    }).expect(400);
    expect(await owner.emailLog.count({ where: { toAddresses: { has: 'stranger@beta.test' } } })).toBe(0);
  });

  it('refuses a malformed address, naming it, and sends nothing', async () => {
    const before = await owner.emailLog.count({ where: { tenantId } });
    const res = await post('/send', {
      ...letter(),
      recipients: [{ partyId: agent.hamburg.toString(), emails: ['ops@ham.test', 'bad-address'] }],
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain('bad-address');
    expect(await owner.emailLog.count({ where: { tenantId } })).toBe(before);
  });

  it('refuses to send while no Price team is set, naming agents', async () => {
    await owner.notificationSetting.updateMany({ where: { tenantId }, data: { priceTeamEmails: null } });
    try {
      const res = await post('/send', {
        ...letter(),
        recipients: [{ partyId: agent.exclusive.toString(), emails: ['c@excl.test'] }],
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('agent replies go there');
    } finally {
      await owner.notificationSetting.updateMany({
        where: { tenantId },
        data: { priceTeamEmails: 'pricing@ape.test' },
      });
    }
  });

  it('needs the agent’s PRICE_EMAIL', async () => {
    await post(
      '/send',
      {
        ...letter(),
        recipients: [{ partyId: agent.exclusive.toString(), emails: ['c@excl.test'] }],
      },
      tokenCustomerOnly,
    ).expect(403);
  });
});
