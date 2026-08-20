import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * A shared master row switched off must disappear from the pickers.
 *
 * §7A rule 7 means deactivating a shared row cannot touch the row — it writes a
 * `tenant_master_override` instead. Every dropdown filtered on `is_active`
 * alone, so a workspace that had switched off eleven shared seaports was still
 * offered all eleven as POL and POD on the Sea Freight screen. Their own ports
 * vanished correctly, which is what made it look like a display quirk rather
 * than a hole in the query.
 *
 * The server-side check is the half that matters: a filtered dropdown is a
 * convenience, and the API has to refuse the id even when the client sends it
 * anyway.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'vis-alpha';

let tenantId: bigint;
let token: string;
let sharedPort: bigint;
let ownPort: bigint;

function as() {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
  };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(`DELETE FROM tenant_master_override WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM port WHERE code = 'VISTEST-SYS'`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Vis Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-vis',
      username: 'admin-vis',
      email: 'admin@vis.test',
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

  const shared = await owner.port.create({
    data: {
      tenantId: null,
      code: 'VISTEST-SYS',
      name: 'Vis Shared Seaport',
      portCode: 'ZVIS1',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  sharedPort = shared.id;

  const own = await owner.port.create({
    data: {
      tenantId,
      code: 'VISTEST-OWN',
      name: 'Vis Own Seaport',
      portCode: 'ZVIS2',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  ownPort = own.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

async function polPodOptions(): Promise<string[]> {
  const response = await as().get('/api/tenant/purchase/rate-options?mode=SEA_FCL');
  expect(response.status).toBe(200);
  return (response.body.data.ports as { id: string }[]).map((p) => p.id);
}

describe('shared rows switched off by a workspace', () => {
  it('are offered while they are active', async () => {
    const ids = await polPodOptions();
    expect(ids).toContain(sharedPort.toString());
    expect(ids).toContain(ownPort.toString());
  });

  it('disappear from POL/POD once deactivated', async () => {
    // Exactly what the Settings screen does to a shared row: it cannot write
    // to port.is_active, so it writes an override.
    const toggle = await as().post(`/api/tenant/setting/ports/${sharedPort}/toggle-status`);
    expect(toggle.status).toBe(200);

    // The row itself is untouched — which is why is_active alone missed this.
    const row = await owner.port.findUnique({
      where: { id: sharedPort },
      select: { isActive: true },
    });
    expect(row?.isActive).toBe(true);

    const ids = await polPodOptions();
    expect(ids).not.toContain(sharedPort.toString());
    // The workspace's own port is unaffected.
    expect(ids).toContain(ownPort.toString());
  });

  it('are refused by the server even if the client sends the id anyway', async () => {
    const carrier = await owner.carrier.findFirst({
      where: { deletedAt: null, isActive: true },
      select: { id: true },
    });
    const currency = await owner.currency.findFirst({
      where: { deletedAt: null, isActive: true },
      select: { id: true },
    });
    const goodsType = await owner.goodsType.findFirst({
      where: { deletedAt: null, isActive: true },
      select: { id: true },
    });
    const tier = await owner.rateTier.findFirst({
      where: { deletedAt: null, isActive: true, mode: 'SEA_FCL' },
      select: { id: true },
    });

    const response = await as()
      .post('/api/tenant/purchase/rates')
      .send({
        mode: 'SEA_FCL',
        polId: sharedPort.toString(),
        podId: ownPort.toString(),
        carrierId: carrier?.id.toString(),
        goodsTypeId: goodsType?.id.toString(),
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrier?.id.toString(),
        currencyId: currency?.id.toString(),
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        status: 'DRAFT',
        lines: [{ tierId: tier?.id.toString(), buyPrice: '100.0000' }],
        localCharges: [],
      });

    expect(response.status).toBe(400);
    // Not a schema complaint — the body is valid; the POL is simply not one of
    // this workspace's available ports any more.
    expect(response.body.error.message).toContain('available ports');
  });

  it('come back when switched on again', async () => {
    const toggle = await as().post(`/api/tenant/setting/ports/${sharedPort}/toggle-status`);
    expect(toggle.status).toBe(200);
    expect(await polPodOptions()).toContain(sharedPort.toString());
  });
});
