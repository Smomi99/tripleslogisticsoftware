import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Customising a shared master row (CR-003).
 *
 * The rule being protected is §7A rule 7: a row with a NULL tenant_id belongs
 * to every workspace on the server. Customising must therefore leave it byte
 * for byte unchanged, and must leave every OTHER workspace still seeing and
 * still pointing at it. That is the assertion that matters here — the copy
 * being editable is the easy half.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'cust-alpha';
const SLUG_B = 'cust-beta';

let tenantA: bigint;
let tenantB: bigint;
let tokenA: string;
let sharedPort: bigint;
/** Another shared port, used to prove B is unaffected. */
let sharedPort2: bigint;

function as(token: string, slug: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
  };
}

async function makeTenant(name: string, slug: string) {
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  const user = await owner.user.create({
    data: {
      tenantId: tenant.id,
      code: `USR-${slug}`,
      username: `admin-${slug}`,
      email: `admin@${slug}.test`,
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  const token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  return { tenantId: tenant.id, token };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_volume WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier_service_port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant_master_override WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM port WHERE code LIKE 'CUSTTEST-%'`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();
  const a = await makeTenant('Cust Alpha', SLUG_A);
  const b = await makeTenant('Cust Beta', SLUG_B);
  tenantA = a.tenantId;
  tenantB = b.tenantId;
  tokenA = a.token;

  const p1 = await owner.port.create({
    data: {
      tenantId: null,
      code: 'CUSTTEST-1',
      name: 'Shared Chittagong',
      portCode: 'ZCGP1',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  sharedPort = p1.id;

  const p2 = await owner.port.create({
    data: {
      tenantId: null,
      code: 'CUSTTEST-2',
      name: 'Shared Singapore',
      portCode: 'ZSIN1',
      country: 'Singapore',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  sharedPort2 = p2.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('POST /setting/ports/:id/customise', () => {
  it('copies the shared row and leaves the original untouched', async () => {
    const before = await owner.port.findUnique({
      where: { id: sharedPort },
      select: { name: true, portCode: true, tenantId: true, deletedAt: true },
    });

    const response = await as(tokenA, SLUG_A).post(
      `/api/tenant/setting/ports/${sharedPort}/customise`,
    );
    expect(response.status).toBe(201);
    const copyId = BigInt(response.body.data.id as string);

    const copy = await owner.port.findUnique({
      where: { id: copyId },
      select: { tenantId: true, name: true, portCode: true, code: true },
    });
    expect(copy?.tenantId).toBe(tenantA);
    expect(copy?.name).toBe('Shared Chittagong');
    // Its own business code, not the shared row's.
    expect(copy?.code).not.toBe('CUSTTEST-1');

    // §7A rule 7: the shared row is exactly as it was.
    const after = await owner.port.findUnique({
      where: { id: sharedPort },
      select: { name: true, portCode: true, tenantId: true, deletedAt: true },
    });
    expect(after).toEqual(before);
  });

  it('hides the shared row for this workspace and records what replaced it', async () => {
    const override = await owner.tenantMasterOverride.findFirst({
      where: { tenantId: tenantA, tableName: 'port', recordId: sharedPort },
      select: { isActive: true, replacedBy: true },
    });
    expect(override?.isActive).toBe(false);
    expect(override?.replacedBy).not.toBeNull();

    const list = await as(tokenA, SLUG_A).get(
      '/api/tenant/setting/ports?search=Shared Chittagong',
    );
    // One row, and it is the copy — the shared original is gone from view.
    const rows = list.body.data as { id: string; isSystem: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isSystem).toBe(false);
  });

  it('leaves other workspaces pointing at the shared row', async () => {
    const overrideForB = await owner.tenantMasterOverride.findFirst({
      where: { tenantId: tenantB, tableName: 'port', recordId: sharedPort },
    });
    expect(overrideForB).toBeNull();

    const stillShared = await owner.port.findUnique({
      where: { id: sharedPort },
      select: { tenantId: true },
    });
    expect(stillShared?.tenantId).toBeNull();
  });

  it('moves this workspace’s references onto the copy', async () => {
    // A carrier of A's own, serving the SHARED port.
    const carrierType = await owner.carrierType.findFirst({ select: { id: true } });
    const carrier = await owner.carrier.create({
      data: {
        tenantId: tenantA,
        code: 'CUSTTEST-CAR',
        name: 'Cust Carrier',
        typeId: carrierType!.id,
      },
      select: { id: true },
    });
    const link = await owner.carrierServicePort.create({
      data: {
        tenantId: tenantA,
        code: 'CUSTTEST-CSP',
        carrierId: carrier.id,
        portId: sharedPort2,
        country: 'Singapore',
      },
      select: { id: true },
    });

    const response = await as(tokenA, SLUG_A).post(
      `/api/tenant/setting/ports/${sharedPort2}/customise`,
    );
    expect(response.status).toBe(201);
    const copyId = BigInt(response.body.data.id as string);

    const moved = await owner.carrierServicePort.findUnique({
      where: { id: link.id },
      select: { portId: true },
    });
    expect(moved?.portId).toBe(copyId);
  });

  it('refuses to customise the same row twice', async () => {
    const response = await as(tokenA, SLUG_A).post(
      `/api/tenant/setting/ports/${sharedPort}/customise`,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_CUSTOMISED');
  });

  it('refuses a row the workspace already owns', async () => {
    const own = await owner.port.create({
      data: {
        tenantId: tenantA,
        code: 'CUSTTEST-OWN',
        name: 'Already Mine',
        portCode: 'ZOWN1',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    });
    const response = await as(tokenA, SLUG_A).post(
      `/api/tenant/setting/ports/${own.id}/customise`,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_OWN');
  });
});
