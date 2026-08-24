import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { decideRoute, priceTeamAddresses, routeAndApply } from './inquiry-routing';
import { withTenant } from './tenant-client';

/**
 * §5.1 — the three branches, and the exception that hangs off one of them.
 *
 * The spec asks for tests on all of them, and it is right to: this is the rule
 * that decides whether an outside company gets an email, and getting it
 * backwards either spams every agent on a lane we can already price, or leaves a
 * lane unpriced because nobody was asked.
 *
 * Everything runs against a real database, because the interesting parts are
 * queries: does a rate cover this lane, who holds the permission, was anybody
 * actually shared with.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG = 'route-alpha';
let tenantId: bigint;
let polId: bigint;
let podId: bigint;
let goodsTypeId: bigint;
let otherGoodsTypeId: bigint;
let customerId: bigint;
let sourceId: bigint;
let agentId: bigint;
let agentPicId: bigint;
let carrierId: bigint;
let managerRoleId: bigint;
let salesRoleId: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(
    `UPDATE "user" SET role_id = NULL WHERE tenant_id IN ${scope}`,
  );
  for (const table of [
    'email_log',
    'inquiry_party_contact',
    'inquiry_party',
    'inquiry_commodity',
    'inquiry_volume',
    'inquiry',
    'rate_local_charge',
    'freight_rate_line',
    'freight_rate',
    'audit_log',
    'user_permission',
    'role_permission',
    '"user"',
    'role',
    'agent_pic',
    'agent',
    'customer',
    'industry_sector',
    'port',
    'carrier',
    'goods_type',
    'inquiry_source',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();
  tenantId = (
    await owner.tenant.create({
      data: { name: 'Route Alpha', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  const port = async (code: string, country: string) =>
    (
      await owner.port.create({
        data: { tenantId, code, name: `${code} Port`, portCode: code, country, type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  polId = await port('RTPOL', 'Denmark');
  podId = await port('RTPOD', 'Bangladesh');

  const goods = async (code: string, name: string) =>
    (
      await owner.goodsType.create({ data: { tenantId, code, name }, select: { id: true } })
    ).id;
  goodsTypeId = await goods('RT-TEX', 'Textile');
  otherGoodsTypeId = await goods('RT-DG', 'DG');

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'RT-ISC', name: 'Route Sector' },
    select: { id: true },
  });
  customerId = (
    await owner.customer.create({
      data: {
        tenantId,
        code: 'RT-CUS',
        name: 'Route Customer',
        country: 'Bangladesh',
        customerType: 'IMPORTER',
        businessArea: 'BOTH',
        industrySectorId: sector.id,
      },
      select: { id: true },
    })
  ).id;
  sourceId = (
    await owner.inquirySource.create({
      data: { tenantId, code: 'RT-SRC', name: 'Route Source' },
      select: { id: true },
    })
  ).id;

  agentId = (
    await owner.agent.create({
      data: { tenantId, code: 'RT-AGT', name: 'Route Agent', country: 'Denmark', agentType: 'GENERAL' },
      select: { id: true },
    })
  ).id;
  agentPicId = (
    await owner.agentPic.create({
      data: { tenantId, code: 'RT-PIC', agentId, name: 'Mette', email: 'mette@route.test' },
      select: { id: true },
    })
  ).id;

  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'RT-CAR', name: 'Route Lines', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;

  // One role that can buy rates and one that cannot — the whole point of
  // resolving the pricing team from a permission.
  const manageProfit = await owner.permission.findFirstOrThrow({
    where: { key: 'PURCHASE.RATE.MANAGE_PROFIT' },
    select: { id: true },
  });
  managerRoleId = (
    await owner.role.create({ data: { tenantId, code: 'RT-MGR', name: 'Pricing' }, select: { id: true } })
  ).id;
  await owner.rolePermission.create({
    data: { tenantId, roleId: managerRoleId, permissionId: manageProfit.id },
  });
  salesRoleId = (
    await owner.role.create({ data: { tenantId, code: 'RT-SLS', name: 'Sales' }, select: { id: true } })
  ).id;

  const user = async (code: string, email: string, roleId: bigint | null, extra = {}) =>
    (
      await owner.user.create({
        data: {
          tenantId,
          code,
          username: code.toLowerCase(),
          email,
          passwordHash: 'x',
          roleId,
          isActive: true,
          ...extra,
        },
        select: { id: true },
      })
    ).id;
  await user('RT-U1', 'pricer@route.test', managerRoleId);
  await user('RT-U2', 'salesman@route.test', salesRoleId);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

beforeEach(async () => {
  await owner.$executeRawUnsafe(
    `DELETE FROM inquiry_party_contact WHERE tenant_id = ${tenantId}`,
  );
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_party WHERE tenant_id = ${tenantId}`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry WHERE tenant_id = ${tenantId}`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id = ${tenantId}`);
});

let sequence = 0;
async function makeInquiry(over: {
  movementType: 'INBOUND' | 'OUTBOUND';
  goodsTypeId?: bigint | null;
  withAgent?: boolean;
  withContact?: boolean;
  status?: 'OPEN' | 'QUOTED';
}): Promise<bigint> {
  sequence += 1;
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `INQ-RT-${String(sequence).padStart(3, '0')}`,
      seriesYear: 2026,
      inquiryDate: new Date('2026-08-25'),
      sourceId,
      shipmentType: 'SEA',
      customerId,
      movementType: over.movementType,
      loadingType: 'FCL',
      polId,
      podId,
      goodsTypeId: over.goodsTypeId === undefined ? goodsTypeId : over.goodsTypeId,
      status: over.status ?? 'OPEN',
    },
    select: { id: true },
  });
  if (over.withAgent === true) {
    await owner.inquiryParty.create({ data: { tenantId, inquiryId: inquiry.id, agentId } });
  }
  if (over.withContact === true) {
    await owner.inquiryPartyContact.create({
      data: { tenantId, inquiryId: inquiry.id, agentPicId },
    });
  }
  return inquiry.id;
}

async function publishRate(over: { goodsTypeId?: bigint; expired?: boolean } = {}): Promise<void> {
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 86_400_000);
  const to = over.expired === true
    ? new Date(today.getTime() - 1 * 86_400_000)
    : new Date(today.getTime() + 30 * 86_400_000);
  await owner.freightRate.create({
    data: {
      tenantId,
      code: `FR-RT-${Math.random().toString(36).slice(2, 8)}`,
      mode: 'SEA_FCL',
      polId,
      podId,
      carrierId,
      goodsTypeId: over.goodsTypeId ?? goodsTypeId,
      currencyId: (await owner.currency.findFirstOrThrow({ select: { id: true } })).id,
      validFrom: from,
      validTo: to,
      status: 'PUBLISHED',
      // freight_rate_purchase_source_ck: a CARRIER rate must name the carrier
      // it was bought from, and nobody else.
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrierId,
    },
  });
}

const route = (id: bigint) => withTenant(tenantId, (db) => routeAndApply(db, id));
const statusOf = async (id: bigint) =>
  owner.inquiry.findFirstOrThrow({
    where: { id },
    select: { status: true, awaitingRate: true },
  });

describe('branch 1 — inbound, no rate on the lane', () => {
  it('shares it, asks the agents, and says RFQ_SENT', async () => {
    const id = await makeInquiry({ movementType: 'INBOUND', withAgent: true, withContact: true });
    const plan = await route(id);

    expect(plan.branch).toBe('INBOUND_SHARED');
    expect(plan.status).toBe('RFQ_SENT');
    expect(plan.agentEmails).toEqual(['mette@route.test']);
    expect(plan.priceTeamEmails).toEqual([]);
    expect(await statusOf(id)).toEqual({ status: 'RFQ_SENT', awaitingRate: false });
  });

  it('stays OPEN when nobody was actually shared with', async () => {
    // An inquiry claiming RFQ_SENT with no agent on it is a lie the board
    // would repeat every morning.
    const id = await makeInquiry({ movementType: 'INBOUND' });
    const plan = await route(id);

    expect(plan.branch).toBe('NOWHERE');
    expect(plan.agentEmails).toEqual([]);
    expect(await statusOf(id)).toEqual({ status: 'OPEN', awaitingRate: false });
  });
});

describe('branch 1, the exception — inbound where a rate already exists', () => {
  it('shares it but asks nobody', async () => {
    // The client states this outright: do not spam agents for lanes we can
    // already price.
    await publishRate();
    const id = await makeInquiry({ movementType: 'INBOUND', withAgent: true, withContact: true });
    const plan = await route(id);

    expect(plan.branch).toBe('INBOUND_RATE_EXISTS');
    expect(plan.liveRates).toBe(1);
    expect(plan.agentEmails).toEqual([]);
    // Still RFQ_SENT: the agents hold it on their screen and can still quote.
    // Only the chasing email was skipped.
    expect(plan.status).toBe('RFQ_SENT');
    expect(await statusOf(id)).toEqual({ status: 'RFQ_SENT', awaitingRate: false });
  });
});

describe('branch 2 — outbound with a live rate', () => {
  it('is PRICED, and nobody is written to', async () => {
    await publishRate();
    const id = await makeInquiry({ movementType: 'OUTBOUND' });
    const plan = await route(id);

    expect(plan.branch).toBe('OUTBOUND_PRICED');
    expect(plan.agentEmails).toEqual([]);
    expect(plan.priceTeamEmails).toEqual([]);
    expect(await statusOf(id)).toEqual({ status: 'PRICED', awaitingRate: false });
  });
});

describe('branch 3 — outbound with no rate', () => {
  it('asks the pricing team, stays OPEN, and is flagged awaiting-rate', async () => {
    const id = await makeInquiry({ movementType: 'OUTBOUND' });
    const plan = await route(id);

    expect(plan.branch).toBe('OUTBOUND_AWAITING_RATE');
    expect(plan.priceTeamEmails).toEqual(['pricer@route.test']);
    // The client is explicit that the status does not move: to the salesman it
    // is still an ordinary open inquiry.
    expect(await statusOf(id)).toEqual({ status: 'OPEN', awaitingRate: true });
  });

  it('does not count an expired rate as cover', async () => {
    await publishRate({ expired: true });
    const id = await makeInquiry({ movementType: 'OUTBOUND' });
    const plan = await route(id);
    expect(plan.branch).toBe('OUTBOUND_AWAITING_RATE');
    expect(plan.liveRates).toBe(0);
  });

  it('does not count a rate for a different goods type', async () => {
    // §5.1 matches on goods type as well as the lane. A textile rate does not
    // price a DG shipment, and treating it as cover would leave the pricing
    // team unasked for something they have to buy.
    await publishRate({ goodsTypeId: otherGoodsTypeId });
    const id = await makeInquiry({ movementType: 'OUTBOUND', goodsTypeId });
    const plan = await route(id);
    expect(plan.branch).toBe('OUTBOUND_AWAITING_RATE');
  });
});

describe('the pricing team is a permission, not an address list', () => {
  it('finds the holder of PURCHASE.RATE.MANAGE_PROFIT and nobody else', async () => {
    const to = await withTenant(tenantId, (db) => priceTeamAddresses(db));
    expect(to).toEqual(['pricer@route.test']);
    expect(to).not.toContain('salesman@route.test');
  });

  it('drops somebody whose role was deactivated', async () => {
    // §7 rule 5: an inactive role removes access. Mailing a person who cannot
    // act on it is worse than mailing nobody.
    await owner.role.update({ where: { id: managerRoleId }, data: { isActive: false } });
    expect(await withTenant(tenantId, (db) => priceTeamAddresses(db))).toEqual([]);
    await owner.role.update({ where: { id: managerRoleId }, data: { isActive: true } });
  });

  it('honours a per-user DENY over the role grant', async () => {
    const permission = await owner.permission.findFirstOrThrow({
      where: { key: 'PURCHASE.RATE.MANAGE_PROFIT' },
      select: { id: true },
    });
    const pricer = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'rt-u1' },
      select: { id: true },
    });
    await owner.userPermission.create({
      data: { tenantId, userId: pricer.id, permissionId: permission.id, effect: 'DENY' },
    });
    expect(await withTenant(tenantId, (db) => priceTeamAddresses(db))).toEqual([]);
    await owner.userPermission.deleteMany({ where: { tenantId, userId: pricer.id } });
  });

  it('picks up a per-user ALLOW without any role', async () => {
    const permission = await owner.permission.findFirstOrThrow({
      where: { key: 'PURCHASE.RATE.MANAGE_PROFIT' },
      select: { id: true },
    });
    const salesman = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'rt-u2' },
      select: { id: true },
    });
    await owner.userPermission.create({
      data: { tenantId, userId: salesman.id, permissionId: permission.id, effect: 'ALLOW' },
    });
    const to = await withTenant(tenantId, (db) => priceTeamAddresses(db));
    expect(to.sort()).toEqual(['pricer@route.test', 'salesman@route.test']);
    await owner.userPermission.deleteMany({ where: { tenantId, userId: salesman.id } });
  });
});

describe('re-routing an inquiry that has moved on', () => {
  it('does not drag a QUOTED inquiry back to PRICED', async () => {
    // Editing an inquiry re-runs the routing. Letting it reset the status would
    // erase what the sales team knows and what the board reports.
    await publishRate();
    const id = await makeInquiry({ movementType: 'OUTBOUND', status: 'QUOTED' });
    const plan = await route(id);
    expect(plan.status).toBe('QUOTED');
    expect((await statusOf(id)).status).toBe('QUOTED');
  });

  it('still refreshes the awaiting-rate flag on one', async () => {
    // Whether the lane has a rate is true or false regardless of how far the
    // inquiry has got, and the pricing team's worklist should say so.
    const id = await makeInquiry({ movementType: 'OUTBOUND', status: 'QUOTED' });
    await route(id);
    expect(await statusOf(id)).toEqual({ status: 'QUOTED', awaitingRate: true });
  });
});

describe('decideRoute writes nothing', () => {
  it('leaves the inquiry exactly as it found it', async () => {
    // The decision runs inside the save transaction and the caller applies it,
    // so this half has to be a pure read.
    const id = await makeInquiry({ movementType: 'OUTBOUND' });
    const before = await statusOf(id);
    await withTenant(tenantId, (db) =>
      decideRoute(db, {
        inquiryId: id,
        movementType: 'OUTBOUND',
        shipmentType: 'SEA',
        polId,
        podId,
        goodsTypeId,
      }),
    );
    expect(await statusOf(id)).toEqual(before);
  });
});
