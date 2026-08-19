import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * The Delete row action (docs/CR-002-delete-action.md), on Sea-Air Port — the
 * §13 reference implementation every other master screen copies.
 *
 * Four things have to hold, and only the first is about deleting:
 *
 *   - a row nothing points at goes away;
 *   - a row something points at does NOT, and the refusal says what is using
 *     it, because a dead-end is what operators file tickets about;
 *   - a shared system row is never deletable by a tenant (§7A rule 7);
 *   - none of it is a hard delete — the row keeps its id and its foreign keys,
 *     so §4 rule 3 is intact and history still resolves.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'del-alpha';
const SLUG_B = 'del-beta';

let tenantA: bigint;
let tokenA: string;
let tokenB: string;
/** Holds every port permission except DELETE. */
let tokenNoDelete: string;
let systemPort: bigint;

function as(token: string, slug: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    del: (path: string) =>
      request(app).delete(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
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
  return { tenantId: tenant.id, token, userId: user.id };
}

/** A port owned by the given tenant. */
async function makePort(tenantId: bigint, code: string, name: string): Promise<bigint> {
  const port = await owner.port.create({
    data: {
      tenantId,
      code,
      name,
      portCode: code.slice(-5),
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  return port.id;
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM carrier_service_port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM port WHERE code = 'DELTEST-SYS'`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenant('Del Alpha', SLUG_A);
  const b = await makeTenant('Del Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;
  tokenB = b.token;

  const limited = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-del-limited',
      username: 'limited-del',
      email: 'limited@del.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenNoDelete = await signAccessToken({
    sub: limited.id.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: false,
    permissions: [
      'SETTING.SEA_AIR_PORT.VIEW',
      'SETTING.SEA_AIR_PORT.CREATE',
      'SETTING.SEA_AIR_PORT.EDIT',
      'SETTING.SEA_AIR_PORT.TOGGLE_STATUS',
    ],
    tokenVersion: 0,
  });

  // A shared row: tenant_id NULL means every workspace sees it (§7A rule 7).
  const shared = await owner.port.create({
    data: {
      tenantId: null,
      code: 'DELTEST-SYS',
      name: 'Shared Test Port',
      portCode: 'ZZSYS',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  systemPort = shared.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('DELETE /setting/ports/:id', () => {
  it('removes a row nothing points at', async () => {
    const id = await makePort(tenantA, 'DELTEST-A1', 'Typo Port');

    const response = await as(tokenA, SLUG_A).del(`/api/tenant/setting/ports/${id}`);
    expect(response.status).toBe(200);

    const list = await as(tokenA, SLUG_A).get('/api/tenant/setting/ports?search=Typo Port');
    expect(list.body.data).toHaveLength(0);
  });

  it('is a SOFT delete — the row survives with its id (§4 rule 3)', async () => {
    const id = await makePort(tenantA, 'DELTEST-A2', 'Soft Delete Port');
    await as(tokenA, SLUG_A).del(`/api/tenant/setting/ports/${id}`);

    const row = await owner.port.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, isActive: true },
    });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.isActive).toBe(false);
  });

  it('refuses when something references the row, and names it', async () => {
    const id = await makePort(tenantA, 'DELTEST-A3', 'Used Port');
    // carrier.type is a lookup FK; any seeded value will do.
    const carrierType = await owner.carrierType.findFirst({ select: { id: true } });
    if (carrierType === null) throw new Error('seed the carrier_type lookup first');
    const carrier = await owner.carrier.create({
      data: {
        tenantId: tenantA,
        code: 'DELTEST-CAR',
        name: 'Del Carrier',
        typeId: carrierType.id,
      },
      select: { id: true },
    });
    await owner.carrierServicePort.create({
      data: {
        tenantId: tenantA,
        code: 'DELTEST-CSP',
        carrierId: carrier.id,
        portId: id,
        country: 'Bangladesh',
      },
    });

    const response = await as(tokenA, SLUG_A).del(`/api/tenant/setting/ports/${id}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('REFERENCED');
    // The operator has to be able to act on this without opening the schema.
    expect(response.body.error.message).toContain('Used Port');
    expect(response.body.error.message).toContain('carrier service port');
    expect(response.body.error.message).toContain('Deactivate');

    // And it really is still there.
    const row = await owner.port.findUnique({ where: { id }, select: { deletedAt: true } });
    expect(row?.deletedAt).toBeNull();
  });

  it('refuses a shared system row (§7A rule 7)', async () => {
    const response = await as(tokenA, SLUG_A).del(`/api/tenant/setting/ports/${systemPort}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SYSTEM_ROW');

    const row = await owner.port.findUnique({
      where: { id: systemPort },
      select: { deletedAt: true },
    });
    expect(row?.deletedAt).toBeNull();
  });

  it('refuses a user who holds every other port permission', async () => {
    const id = await makePort(tenantA, 'DELTEST-A4', 'Guarded Port');
    const response = await as(tokenNoDelete, SLUG_A).del(`/api/tenant/setting/ports/${id}`);
    expect(response.status).toBe(403);
  });

  it('cannot reach another workspace’s row', async () => {
    const id = await makePort(tenantA, 'DELTEST-A5', 'Alpha Only');
    const response = await as(tokenB, SLUG_B).del(`/api/tenant/setting/ports/${id}`);
    expect(response.status).toBe(404);

    const row = await owner.port.findUnique({ where: { id }, select: { deletedAt: true } });
    expect(row?.deletedAt).toBeNull();
  });
});
