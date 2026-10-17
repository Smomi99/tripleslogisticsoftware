import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * A short name for agents, carriers and vendors (client, 2026-10-17).
 *
 * Entered beside the name on each form, and shown in the rate screens'
 * Purchase via column with the full name on hover. Not in §5/§6, so it is an
 * optional column: every party already in production has none, and blank has
 * to be an ordinary state that falls back to the full name.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'short-name';

let tenantId: bigint;
let token: string;
let carrierTypeId: bigint;
let vendorTypeId: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of ['freight_rate', 'goods_type', 'port', 'agent', 'vendor', 'carrier', '"user"']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();
  tenantId = (
    await owner.tenant.create({
      data: { name: 'Short Name', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${SLUG}`,
      username: `admin-${SLUG}`,
      email: `admin@${SLUG}.test`,
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  carrierTypeId = (
    await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })
  ).id;
  vendorTypeId = (
    await owner.vendorType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function call(method: 'get' | 'post' | 'patch', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Slug', SLUG);
}

describe('the short name on each party', () => {
  it('records an agent’s short name, finds the agent by it, and clears it on edit', async () => {
    const created = await call('post', '/api/tenant/crm/agents').send({
      name: 'Kuehne Logistics Singapore Pte Ltd',
      shortName: 'KLS',
      country: 'Singapore',
      agentType: 'GENERAL',
    });
    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
    expect(created.body.data.shortName).toBe('KLS');

    const found = await call('get', '/api/tenant/crm/agents?search=kls');
    expect(found.body.data.map((a: { name: string }) => a.name)).toContain(
      'Kuehne Logistics Singapore Pte Ltd',
    );

    const cleared = await call('patch', `/api/tenant/crm/agents/${created.body.data.id}`).send({
      name: 'Kuehne Logistics Singapore Pte Ltd',
      shortName: '',
      country: 'Singapore',
      agentType: 'GENERAL',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.shortName).toBeNull();
  });

  it('records a vendor’s short name', async () => {
    const created = await call('post', '/api/tenant/crm/vendors').send({
      name: 'Dhaka Air Consolidators Ltd',
      shortName: 'DAC Consol',
      country: 'Bangladesh',
      vendorTypeId: vendorTypeId.toString(),
    });
    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
    expect(created.body.data.shortName).toBe('DAC Consol');
  });

  it('records a carrier’s short name, and lists and finds it by it', async () => {
    const created = await call('post', '/api/tenant/setting/carriers').send({
      name: 'Mediterranean Shipping Company',
      shortName: 'MSC',
      typeId: carrierTypeId.toString(),
    });
    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
    expect(created.body.data.shortName).toBe('MSC');

    // The list is raw SQL, so it is the one place a new column can be missed.
    const listed = await call('get', '/api/tenant/setting/carriers?search=msc');
    const row = listed.body.data.find(
      (c: { name: string }) => c.name === 'Mediterranean Shipping Company',
    );
    expect(row?.shortName).toBe('MSC');
  });

  it('leaves it blank when not given', async () => {
    const created = await call('post', '/api/tenant/setting/carriers').send({
      name: 'Plain Lines',
      typeId: carrierTypeId.toString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.shortName).toBeNull();
  });

  it('refuses one longer than 50 characters, and says so', async () => {
    const response = await call('post', '/api/tenant/crm/agents').send({
      name: 'Long Ltd',
      shortName: 'x'.repeat(51),
      country: 'India',
      agentType: 'GENERAL',
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error)).toMatch(/50 characters/);
  });
});

describe('Purchase via on the rate screens', () => {
  it('carries the source’s short name beside its full name, and null when it has none', async () => {
    const port = (name: string, portCode: string) =>
      owner.port.create({
        data: { tenantId, code: `SN-${portCode}`, name, portCode, country: 'Bangladesh', type: 'SEAPORT' },
        select: { id: true },
      });
    const polId = (await port('SN Pol', 'SNPO1')).id;
    const podId = (await port('SN Pod', 'SNPO2')).id;
    const goodsTypeId = (
      await owner.goodsType.create({
        data: { tenantId, code: 'GDT-SN', name: 'SN Goods' },
        select: { id: true },
      })
    ).id;
    const currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;
    const carrier = await owner.carrier.create({
      data: { tenantId, code: 'SN-CAR', name: 'SN Carrier', typeId: carrierTypeId },
      select: { id: true },
    });
    const agent = await owner.agent.create({
      data: {
        tenantId,
        code: 'SN-AGT',
        name: 'Orient Freight Agencies Ltd',
        shortName: 'OFA',
        country: 'China',
        agentType: 'GENERAL',
      },
      select: { id: true },
    });

    const rate = (code: string, source: { agentId?: bigint; carrierId?: bigint }) =>
      owner.freightRate.create({
        data: {
          tenantId,
          code,
          mode: 'SEA_FCL',
          polId,
          podId,
          carrierId: carrier.id,
          goodsTypeId,
          currencyId,
          validFrom: new Date('2026-01-01'),
          validTo: new Date('2099-12-31'),
          // Draft, so the two rates on one lane do not collide as an overlap.
          status: 'DRAFT',
          purchaseSourceType: source.agentId === undefined ? 'CARRIER' : 'AGENT',
          purchaseAgentId: source.agentId ?? null,
          purchaseCarrierId: source.carrierId ?? null,
        },
      });
    await rate('SN-RATE-AGT', { agentId: agent.id });
    await rate('SN-RATE-CAR', { carrierId: carrier.id });

    const response = await call('get', '/api/tenant/purchase/rates?mode=SEA_FCL&includeExpired=true');
    expect(response.status).toBe(200);
    const byCode = new Map(
      response.body.data.map((r: { code: string }) => [r.code, r] as const),
    );

    expect(byCode.get('SN-RATE-AGT')).toMatchObject({
      purchaseSourceName: 'Orient Freight Agencies Ltd',
      purchaseSourceShortName: 'OFA',
    });
    expect(byCode.get('SN-RATE-CAR')).toMatchObject({
      purchaseSourceName: 'SN Carrier',
      purchaseSourceShortName: null,
    });
  });
});
