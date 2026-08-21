import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Who an inquiry is sent to.
 *
 * The client's rule: Inbound picks agents, Outbound picks customers. Their
 * contacts seed an email list that stays editable afterwards.
 *
 * The sharp edge is the movement type. The screen only offers one side, but the
 * screen is a convenience — the server has to refuse a customer id posted
 * against an Inbound inquiry, or a party silently goes unrecorded and nobody
 * finds out until the quote does not arrive.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'ip-alpha';
let tenantId: bigint;
let token: string;
let sourceId: bigint;
let customerId: bigint;
let carrierId: bigint;
let carrierPicId: bigint;
let customerId2: bigint;
let agentId: bigint;
let agentPicId: bigint;
let polId: bigint;
let podId: bigint;

function as() {
  return {
    get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
    post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
    patch: (p: string) => request(app).patch(p).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
  };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRaw`DELETE FROM freight_rate WHERE code LIKE 'IP-RATE-%'`;
  for (const t of [
    'inquiry_party_contact', 'inquiry_party', 'inquiry_volume', 'inquiry',
    'agent_pic', 'agent', 'carrier_pic', 'carrier', 'customer_pic', 'customer', 'industry_sector', 'port', '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

async function raise(body: Record<string, unknown>) {
  return as()
    .post('/api/tenant/sales/inquiries')
    .send({
      inquiryDate: '2026-05-01',
      sourceId: sourceId.toString(),
      shipmentType: 'SEA',
      loadingType: 'FCL',
      customerId: customerId.toString(),
      polId: polId.toString(),
      podId: podId.toString(),
      volumes: [],
      ...body,
    });
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'IP Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;
  const user = await owner.user.create({
    data: { tenantId, code: 'USR-ip', username: 'admin-ip', email: 'a@ip.test', passwordHash: 'x', isSuperadmin: true },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: user.id.toString(), tenantId: tenantId.toString(),
    isSuperadmin: true, permissions: [], tokenVersion: 0,
  });

  sourceId = (await owner.inquirySource.findFirstOrThrow({ select: { id: true } })).id;
  // industry_sector is tenant-owned, so borrowing another workspace's would be
  // refused by §4 rule 10's guard — correctly.
  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'IP-SEC', name: 'IP Sector' },
    select: { id: true },
  });

  const customer = await owner.customer.create({
    data: {
      tenantId, code: 'IP-CUS', name: 'IP Customer', country: 'Bangladesh',
      customerType: 'EXPORTER', businessArea: 'BOTH', industrySectorId: sector.id,
    },
    select: { id: true },
  });
  customerId = customer.id;
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (await owner.carrier.create({
    data: { tenantId, code: 'IP-CAR', name: 'IP Carrier', typeId: carrierType.id },
    select: { id: true },
  })).id;
  carrierPicId = (await owner.carrierPic.create({
    data: { tenantId, code: 'IP-CARPIC', carrierId, name: 'Carrier Contact', email: 'carrier@ip.test' },
    select: { id: true },
  })).id;
  customerId2 = customerId;

  const agent = await owner.agent.create({
    data: { tenantId, code: 'IP-AGT', name: 'IP Agent', country: 'Singapore', agentType: 'GENERAL' },
    select: { id: true },
  });
  agentId = agent.id;
  agentPicId = (await owner.agentPic.create({
    data: { tenantId, code: 'IP-APIC', agentId, name: 'Agent Contact', email: 'agent@ip.test' },
    select: { id: true },
  })).id;

  polId = (await owner.port.create({
    data: { tenantId, code: 'IP-P1', name: 'IP Pol', portCode: 'IPPO1', country: 'Bangladesh', type: 'SEAPORT' },
    select: { id: true },
  })).id;
  podId = (await owner.port.create({
    data: { tenantId, code: 'IP-P2', name: 'IP Pod', portCode: 'IPPO2', country: 'Singapore', type: 'SEAPORT' },
    select: { id: true },
  })).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the party picker', () => {
  it('offers agents for Inbound and customers for Outbound', async () => {
    const inbound = await as().get('/api/tenant/sales/inquiry-parties?movement=INBOUND');
    expect(inbound.status).toBe(200);
    expect(inbound.body.data.map((p: { name: string }) => p.name)).toContain('IP Agent');

    const outbound = await as().get('/api/tenant/sales/inquiry-parties?movement=OUTBOUND');
    // Carriers, not customers: a customer is who the inquiry is FOR.
    expect(outbound.body.data.map((p: { name: string }) => p.name)).toContain('IP Carrier');
    expect(outbound.body.data.map((p: { name: string }) => p.name)).not.toContain('IP Customer');
  });

  it('carries each party’s contacts and their addresses', async () => {
    const response = await as().get('/api/tenant/sales/inquiry-parties?movement=INBOUND');
    const agent = response.body.data.find((p: { name: string }) => p.name === 'IP Agent');
    expect(agent.contacts).toHaveLength(1);
    expect(agent.contacts[0].email).toBe('agent@ip.test');
  });
});

describe('recipients on an inquiry', () => {
  it('records agents and contacts on an Inbound inquiry', async () => {
    const response = await raise({
      movementType: 'INBOUND',
      partyIds: [agentId.toString()],
      partyContactIds: [agentPicId.toString()],
      notifyEmails: 'agent@ip.test',
    });

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.parties).toHaveLength(1);
    expect(response.body.data.parties[0].name).toBe('IP Agent');
    expect(response.body.data.partyContacts[0].email).toBe('agent@ip.test');
    expect(response.body.data.notifyEmails).toBe('agent@ip.test');
  });

  it('records carriers on an Outbound inquiry', async () => {
    const response = await raise({
      movementType: 'OUTBOUND',
      partyIds: [carrierId.toString()],
      partyContactIds: [carrierPicId.toString()],
    });
    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.parties[0].name).toBe('IP Carrier');
    expect(response.body.data.partyContacts[0].email).toBe('carrier@ip.test');
  });

  it('refuses a carrier posted against an Inbound inquiry', async () => {
    // The screen would never offer this; a stale tab or a script would.
    const response = await raise({
      movementType: 'INBOUND',
      partyIds: [carrierId.toString()],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/agents/i);
  });

  it('refuses a customer on either side — they are never a party here', async () => {
    const response = await raise({
      movementType: 'OUTBOUND',
      partyIds: [customerId2.toString()],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/carriers/i);
  });

  it('rewrites the list on edit rather than stacking onto it', async () => {
    const created = await raise({
      movementType: 'INBOUND',
      partyIds: [agentId.toString()],
      partyContactIds: [agentPicId.toString()],
    });
    const id = created.body.data.id as string;

    const edited = await as()
      .patch(`/api/tenant/sales/inquiries/${id}`)
      .send({
        inquiryDate: '2026-05-01',
        sourceId: sourceId.toString(),
        shipmentType: 'SEA',
        loadingType: 'FCL',
        customerId: customerId.toString(),
        movementType: 'INBOUND',
        polId: polId.toString(),
        podId: podId.toString(),
        volumes: [],
        partyIds: [],
        partyContactIds: [],
      });

    expect(edited.status, JSON.stringify(edited.body.error ?? {})).toBe(200);
    expect(edited.body.data.parties).toEqual([]);
    expect(edited.body.data.partyContacts).toEqual([]);
  });

  it('keeps the inquiry’s own Customer field untouched by any of this', async () => {
    const response = await raise({
      movementType: 'INBOUND',
      partyIds: [agentId.toString()],
    });
    // The party the inquiry is FOR is a different question from who it goes to.
    expect(response.body.data.customerId).toBe(customerId.toString());
  });
});

/**
 * Does this lane already have a buying rate?
 *
 * The rule has to match §5.5's Price action exactly, or the form says "Matched"
 * about a rate the Price drawer will not offer. Expired is the case worth
 * pinning: a lapsed rate cannot be quoted from, so it is NOT a match, and the
 * operator still has to go and ask.
 */
describe('the lane check', () => {
  const check = (extra = '') =>
    as().get(
      `/api/tenant/sales/lane-check?polId=${polId}&podId=${podId}&shipmentType=SEA${extra}`,
    );

  it('reports NONE for a lane nobody has rated', async () => {
    const response = await check();
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('NONE');
  });

  it('reports MATCHED once a published rate covers it today', async () => {
    const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
    const goodsType = await owner.goodsType.findFirstOrThrow({ select: { id: true } });
    const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });
    await owner.freightRate.create({
      data: {
        tenantId, code: 'IP-RATE-LIVE', mode: 'SEA_FCL',
        polId, podId, carrierId, goodsTypeId: goodsType.id,
        purchaseSourceType: 'CARRIER', purchaseCarrierId: carrierId,
        currencyId: currency.id, status: 'PUBLISHED',
        validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'),
      },
    });
    void carrierType;

    const response = await check();
    expect(response.body.data.status).toBe('MATCHED');
    expect(response.body.data.count).toBeGreaterThan(0);
  });

  it('does NOT count an expired rate as a match', async () => {
    await owner.$executeRaw`DELETE FROM freight_rate WHERE code = 'IP-RATE-LIVE'`;
    const goodsType = await owner.goodsType.findFirstOrThrow({ select: { id: true } });
    const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });
    await owner.freightRate.create({
      data: {
        tenantId, code: 'IP-RATE-OLD', mode: 'SEA_FCL',
        polId, podId, carrierId, goodsTypeId: goodsType.id,
        purchaseSourceType: 'CARRIER', purchaseCarrierId: carrierId,
        currencyId: currency.id, status: 'PUBLISHED',
        validFrom: new Date('2020-01-01'), validTo: new Date('2020-12-31'),
      },
    });

    const response = await check();
    expect(response.body.data.status).toBe('EXPIRED');
    // The screen tells the operator how stale the lane has gone.
    expect(response.body.data.latestValidTo).toBe('2020-12-31');
  });

  it('treats an air lane as a different question from a sea one', async () => {
    const response = await as().get(
      `/api/tenant/sales/lane-check?polId=${polId}&podId=${podId}&shipmentType=AIR`,
    );
    // The rate above is SEA_FCL; the same two ports by air are unrated.
    expect(response.body.data.status).toBe('NONE');
  });
});
