import { PrismaPg } from '@prisma/adapter-pg';
import { CARRIER_PORT_PAIR_SORT_FIELDS } from '@ff/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Carrier → Port Pair (CR-001 §3–§6).
 *
 * The CR's build order asks for isolation and permission tests before the
 * screen ships, and §4's six validation rules are the substance of the module —
 * the table alone is five columns and a constraint.
 *
 * The isolation case is the sharp one, and it is the same shape that makes
 * carrier_service_port interesting: the carrier is SHARED, so two forwarders
 * rank the very same carrier row on the very same lane with different numbers.
 * A rank is a commercial judgement about a competitor's supplier. Leaking it
 * across the join would be worse than leaking a contact name.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'cpp-alpha';
const SLUG_B = 'cpp-beta';
const PAIR_PERMS = [
  'SETTING.CARRIER.VIEW',
  'SETTING.CARRIER.CREATE',
  'SETTING.CARRIER.EDIT',
  'SETTING.CARRIER.TOGGLE_STATUS',
];

let tenantA: bigint;
let tokenA: string;
let tokenB: string;
/** Holds every SETTING.CARRIER permission but none for the pair screen. */
let tokenCarrierOnly: string;
let seaCarrier: bigint;
let airCarrier: bigint;
/** A carrier tenant B added itself — invisible to A (§7A rule 7). */
let carrierOwnedByB: bigint;
/** A port tenant B added itself. */
let portOwnedByB: bigint;
let cgp: bigint;
let sin: bigint;
let dac: bigint;
/** A seaport nobody has added to a carrier's service ports. */
let unserved: bigint;

function as(token: string, slug: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    patch: (path: string) =>
      request(app).patch(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
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
  await owner.$executeRawUnsafe(`DELETE FROM carrier_port_pair WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier_service_port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM carrier WHERE code IN ('CPPTEST-SEA', 'CPPTEST-AIR', 'CPPTEST-OWN')`;
  await owner.$executeRaw`DELETE FROM port WHERE code LIKE 'CPPTEST-%'`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

/** Records the carrier as serving the port, for this tenant. */
async function serve(tenantId: bigint, carrierId: bigint, portId: bigint, code: string) {
  await owner.carrierServicePort.create({
    data: { tenantId, code, carrierId, portId, country: 'x' },
  });
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenant('CPP Alpha', SLUG_A);
  const b = await makeTenant('CPP Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;
  tokenB = b.token;

  const carrierOnly = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-caronly-cpp',
      username: `caronly-${SLUG_A}`,
      email: `caronly@${SLUG_A}.test`,
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenCarrierOnly = await signAccessToken({
    sub: carrierOnly.id.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: false,
    permissions: PAIR_PERMS,
    tokenVersion: 0,
  });

  // Carrier types are seeded system rows; §4 rule 6 keys off their names.
  const mlo = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null, name: 'MLO' } });
  const airline = await owner.carrierType.findFirstOrThrow({
    where: { tenantId: null, name: 'Airline' },
  });

  seaCarrier = (
    await owner.carrier.create({
      data: { code: 'CPPTEST-SEA', name: 'CPP Sea Line', typeId: mlo.id },
      select: { id: true },
    })
  ).id;
  airCarrier = (
    await owner.carrier.create({
      data: { code: 'CPPTEST-AIR', name: 'CPP Air Line', typeId: airline.id },
      select: { id: true },
    })
  ).id;

  carrierOwnedByB = (
    await owner.carrier.create({
      data: { tenantId: b.tenantId, code: 'CPPTEST-OWN', name: 'Beta Private Line', typeId: mlo.id },
      select: { id: true },
    })
  ).id;

  const port = async (code: string, name: string, portCode: string, type: 'SEAPORT' | 'AIRPORT') =>
    (
      await owner.port.create({
        data: { code, name, portCode, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;

  cgp = await port('CPPTEST-1', 'CPP Chittagong', 'CPPCGP', 'SEAPORT');
  sin = await port('CPPTEST-2', 'CPP Singapore', 'CPPSIN', 'SEAPORT');
  dac = await port('CPPTEST-3', 'CPP Dhaka Air', 'CPPDAC', 'AIRPORT');
  unserved = await port('CPPTEST-4', 'CPP Hamburg', 'CPPHAM', 'SEAPORT');

  portOwnedByB = (
    await owner.port.create({
      data: {
        tenantId: b.tenantId,
        code: 'CPPTEST-5',
        name: 'Beta Private Port',
        portCode: 'CPPPRV',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    })
  ).id;
  await serve(b.tenantId, seaCarrier, portOwnedByB, 'CSP-B3');

  // Both workspaces record the shared sea carrier as calling at CGP and SIN.
  await serve(tenantA, seaCarrier, cgp, 'CSP-A1');
  await serve(tenantA, seaCarrier, sin, 'CSP-A2');
  await serve(a.tenantId, airCarrier, dac, 'CSP-A3');
  await serve(a.tenantId, airCarrier, cgp, 'CSP-A4'); // a seaport on an airline
  await serve(b.tenantId, seaCarrier, cgp, 'CSP-B1');
  await serve(b.tenantId, seaCarrier, sin, 'CSP-B2');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const lanes = (carrierId: bigint) => `/api/tenant/setting/carriers/${carrierId}/port-pairs`;

describe('§4 rule 1 — a lane may only use ports the carrier serves', () => {
  it('rejects a port that is not on the service port list, and names it', async () => {
    const res = await as(tokenA, SLUG_A)
      .post(lanes(seaCarrier))
      .send({ polId: cgp.toString(), podId: unserved.toString() });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'Add CPP Hamburg to this carrier\'s service ports before pairing it.',
    );
  });

  it('offers only the served ports as options', async () => {
    const res = await as(tokenA, SLUG_A).get(
      `/api/tenant/setting/carriers/${seaCarrier}/lane-ports`,
    );
    expect(res.status).toBe(200);
    const codes = res.body.data.ports.map((p: { portCode: string }) => p.portCode);
    expect(codes.sort()).toEqual(['CPPCGP', 'CPPSIN']);
    expect(res.body.data.excludedByType).toBe(0);
  });
});

describe('§4 rule 2 — POL and POD are different ports', () => {
  it('rejects a lane from a port to itself', async () => {
    const res = await as(tokenA, SLUG_A)
      .post(lanes(seaCarrier))
      .send({ polId: cgp.toString(), podId: cgp.toString() });

    expect(res.status).toBe(400);
    // The shared schema attaches it to podId so the form can render it.
    expect(res.body.error.fields.podId[0]).toBe('A lane runs between two different ports.');
  });
});

describe('§4 rule 6 — ports match the carrier type', () => {
  it('refuses a seaport on an airline', async () => {
    const res = await as(tokenA, SLUG_A)
      .post(lanes(airCarrier))
      .send({ polId: dac.toString(), podId: cgp.toString() });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('CPP Chittagong is a seaport, and this carrier flies.');
  });

  it('leaves an airport out of a sea carrier lane options', async () => {
    const res = await as(tokenA, SLUG_A).get(
      `/api/tenant/setting/carriers/${airCarrier}/lane-ports`,
    );
    const codes = res.body.data.ports.map((p: { portCode: string }) => p.portCode);
    // CGP is on this airline's service port list but is a seaport, so it is
    // filtered server-side — not merely hidden in the dropdown.
    expect(codes).toEqual(['CPPDAC']);
    // And the screen is told WHY it is missing, so it can say something better
    // than "add it on the Service Port screen" about a port already there.
    expect(res.body.data.excludedByType).toBe(1);
    expect(res.body.data.requiredPortType).toBe('AIRPORT');
  });
});

describe('§3 and §5 — ranks', () => {
  let created: string;

  it('stores a decimal rank and reads it back unpadded', async () => {
    const res = await as(tokenA, SLUG_A).post(lanes(seaCarrier)).send({
      polId: cgp.toString(),
      podId: sin.toString(),
      lowPricePosition: '1.5',
      servicePosition: '2',
      remarks: 'Weekly sailing',
    });

    expect(res.status).toBe(201);
    // 1.5 is the whole point of NUMERIC(5,2) — it slots between ranks 1 and 2
    // without renumbering the lane. And 2 must not come back as "2.00".
    expect(res.body.data.lowPricePosition).toBe('1.5');
    expect(res.body.data.servicePosition).toBe('2');
    expect(res.body.data.rankSource).toBe('MANUAL');
    expect(res.body.data.code).toMatch(/^CPP-\d+$/);
    created = res.body.data.id;
  });

  it('accepts a pair with no rank at all', async () => {
    const res = await as(tokenA, SLUG_A)
      .post(lanes(seaCarrier))
      .send({ polId: sin.toString(), podId: cgp.toString() });

    expect(res.status).toBe(201);
    expect(res.body.data.lowPricePosition).toBeNull();
  });

  it('sorts unranked lanes last, not as though they were zero', async () => {
    const res = await as(tokenA, SLUG_A).get(`${lanes(seaCarrier)}?limit=100`);
    const ranks = res.body.data.map((r: { lowPricePosition: string | null }) => r.lowPricePosition);
    expect(ranks).toEqual(['1.5', null]);
  });

  it('accepts every sort field the list declares', async () => {
    // The screen sends sortBy on every request, so a field the schema does not
    // know is a 400 on page load rather than a mis-sorted table. Found in the
    // browser: ChildScreen defaulted every child list to sortBy=name.
    for (const sortBy of CARRIER_PORT_PAIR_SORT_FIELDS) {
      const res = await as(tokenA, SLUG_A).get(`${lanes(seaCarrier)}?sortBy=${sortBy}&limit=100`);
      expect(res.status, sortBy).toBe(200);
    }
  });

  it('rejects a rank the column cannot hold', async () => {
    const res = await as(tokenA, SLUG_A)
      .patch(`${lanes(seaCarrier)}/${created}`)
      .send({ polId: cgp.toString(), podId: sin.toString(), lowPricePosition: '1234' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.lowPricePosition[0]).toContain('three digits');
  });
});

describe('§4 rule 3 — one live pair per lane', () => {
  it('returns the existing row id so the screen can edit it instead', async () => {
    const res = await as(tokenA, SLUG_A)
      .post(lanes(seaCarrier))
      .send({ polId: cgp.toString(), podId: sin.toString() });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'This carrier already has a CPP Chittagong → CPP Singapore pair. Editing it instead.',
    );

    const existingId = res.body.error.fields.existingId[0];
    const existing = await as(tokenA, SLUG_A).get(`${lanes(seaCarrier)}/${existingId}`);
    expect(existing.status).toBe(200);
    expect(existing.body.data.polId).toBe(cgp.toString());
  });

  it('does not create a second row', async () => {
    const count = await owner.carrierPortPair.count({
      where: { tenantId: tenantA, carrierId: seaCarrier, polId: cgp, podId: sin, deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it('treats the reverse direction as its own lane (§8 Q5)', async () => {
    const list = await as(tokenA, SLUG_A).get(`${lanes(seaCarrier)}?limit=100`);
    const pairs = list.body.data.map((r: { polCode: string; podCode: string }) =>
      `${r.polCode}->${r.podCode}`,
    );
    expect(pairs.sort()).toEqual(['CPPCGP->CPPSIN', 'CPPSIN->CPPCGP']);
  });
});

describe('§4 rule 5 — deactivating a served port never touches its lanes', () => {
  it('names the affected lanes on the service port row', async () => {
    const res = await as(tokenA, SLUG_A).get(
      `/api/tenant/setting/carriers/${seaCarrier}/service-ports?limit=100`,
    );
    const cgpRow = res.body.data.find((r: { portCode: string }) => r.portCode === 'CPPCGP');
    expect(cgpRow.activePairs.sort()).toEqual(['CPPCGP → CPPSIN', 'CPPSIN → CPPCGP']);
  });

  it('lets the deactivation through and leaves the pairs alone', async () => {
    const list = await as(tokenA, SLUG_A).get(
      `/api/tenant/setting/carriers/${seaCarrier}/service-ports?limit=100`,
    );
    const cgpRow = list.body.data.find((r: { portCode: string }) => r.portCode === 'CPPCGP');

    const res = await as(tokenA, SLUG_A).post(
      `/api/tenant/setting/carriers/${seaCarrier}/service-ports/${cgpRow.id}/toggle-status`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);

    const pairs = await owner.carrierPortPair.count({
      where: { tenantId: tenantA, carrierId: seaCarrier, deletedAt: null },
    });
    expect(pairs).toBe(2);

    // Put it back, so the ordering of later tests does not depend on this one.
    await as(tokenA, SLUG_A).post(
      `/api/tenant/setting/carriers/${seaCarrier}/service-ports/${cgpRow.id}/toggle-status`,
    );
  });
});

describe('§7A rule 4 — two workspaces ranking the same shared carrier', () => {
  it('each sees only its own lanes', async () => {
    const b = await as(tokenB, SLUG_B).post(lanes(seaCarrier)).send({
      polId: cgp.toString(),
      podId: sin.toString(),
      lowPricePosition: '9',
    });
    // The same carrier on the same lane: not a duplicate, a different company's
    // opinion of it.
    expect(b.status).toBe(201);

    const listA = await as(tokenA, SLUG_A).get(`${lanes(seaCarrier)}?limit=100`);
    expect(listA.body.data).toHaveLength(2);
    expect(
      listA.body.data.map((r: { lowPricePosition: string | null }) => r.lowPricePosition),
    ).not.toContain('9');

    const listB = await as(tokenB, SLUG_B).get(`${lanes(seaCarrier)}?limit=100`);
    expect(listB.body.data).toHaveLength(1);
    expect(listB.body.data[0].lowPricePosition).toBe('9');
  });

  it('cannot edit the other workspace lane', async () => {
    const listB = await as(tokenB, SLUG_B).get(`${lanes(seaCarrier)}?limit=100`);
    const betaId = listB.body.data[0].id;

    const attempt = await as(tokenA, SLUG_A)
      .patch(`${lanes(seaCarrier)}/${betaId}`)
      .send({ polId: cgp.toString(), podId: sin.toString(), lowPricePosition: '1' });
    expect(attempt.status).toBe(404);

    const untouched = await owner.carrierPortPair.findUniqueOrThrow({
      where: { id: BigInt(betaId) },
    });
    expect(untouched.lowPricePosition?.toString()).toBe('9');
  });
});

describe('§4 rule 10 — the carrier a pair points at', () => {
  /**
   * carrier is system-capable, so carrier_port_pair.carrier_id is a plain FK to
   * carrier(id) rather than the composite (tenant_id, id) §4 rule 10 prefers —
   * a shared carrier has tenant_id NULL and the composite cannot resolve. The
   * database therefore does not stop a pair from naming another workspace's
   * private carrier. These are the checks that do.
   */
  it('cannot create a pair against a carrier the workspace cannot see', async () => {
    const res = await as(tokenA, SLUG_A)
      .post(lanes(carrierOwnedByB))
      .send({ polId: cgp.toString(), podId: sin.toString() });

    expect(res.status).toBe(404);
    const leaked = await owner.carrierPortPair.count({
      where: { tenantId: tenantA, carrierId: carrierOwnedByB },
    });
    expect(leaked).toBe(0);
  });

  it('cannot list, read options for, or reach lanes on that carrier', async () => {
    const A = as(tokenA, SLUG_A);
    expect((await A.get(lanes(carrierOwnedByB))).status).toBe(404);
    expect(
      (await A.get(`/api/tenant/setting/carriers/${carrierOwnedByB}/lane-ports`)).status,
    ).toBe(404);
  });

  it('cannot use another workspace private port as one end of a lane', async () => {
    // B serves the shared carrier at its own private port. A shares that
    // carrier, so nothing but scoping keeps that port out of A's lanes.
    const res = await as(tokenA, SLUG_A)
      .post(lanes(seaCarrier))
      .send({ polId: cgp.toString(), podId: portOwnedByB.toString() });

    expect(res.status).toBe(400);
    // Not "Beta Private Port is not on the list" — A cannot see the port at
    // all, so the message must not name it. §4 rule 1's check doubles as the
    // scoping guard here.
    expect(res.body.error.message).toBe(
      "Choose a port of discharge from this carrier's service ports.",
    );
  });

  it('keeps each workspace pair pointed at its own tenant row', async () => {
    const rows = await owner.carrierPortPair.findMany({
      select: { tenantId: true, carrier: { select: { tenantId: true } } },
    });
    // Every pair either names a shared carrier or one of its own tenant's.
    for (const row of rows) {
      const carrierTenant = row.carrier.tenantId;
      expect(carrierTenant === null || carrierTenant === row.tenantId).toBe(true);
    }
  });
});

describe('§7 — the pair screen has its own permission', () => {
  const routes: [string, 'get' | 'post' | 'patch'][] = [
    ['', 'get'],
    ['', 'post'],
    ['/1', 'get'],
    ['/1', 'patch'],
    ['/1/toggle-status', 'post'],
  ];

  it('refuses a user who holds every SETTING.CARRIER permission but no pair one', async () => {
    // The whole reason the CR asked for a separate feature: maintaining carrier
    // contacts must not imply the right to move a lane ranking.
    const client = as(tokenCarrierOnly, SLUG_A);
    for (const [suffix, method] of routes) {
      const res = await client[method](`${lanes(seaCarrier)}${suffix}`);
      expect(res.status, `${method} ${suffix}`).toBe(403);
    }
    const options = await client.get(`/api/tenant/setting/carriers/${seaCarrier}/lane-ports`);
    expect(options.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get(lanes(seaCarrier)).set('X-Tenant-Slug', SLUG_A);
    expect(res.status).toBe(401);
  });
});
