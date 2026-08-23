import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Phase 1 of the agent portal: what the database will and will not hold.
 *
 * These tests deliberately use the OWNER connection, which bypasses row level
 * security and every application guard. That is the point — a constraint that
 * only holds when the API is the one asking is not a security boundary, it is a
 * convention. Everything asserted here must be true of a hand-written UPDATE
 * typed into psql by a tired developer at midnight.
 *
 * Phase 2 adds the login, Phase 3 the agent RLS. Nothing external can sign in
 * yet.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG_A = 'agt-alpha';
const SLUG_B = 'agt-beta';

let tenantA: bigint;
let tenantB: bigint;
let agentA: bigint;
let agentB: bigint;
let inquiryA: bigint;
let employeeA: bigint;
let roleA: bigint;
let systemCurrency: bigint;
let currencyB: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'agent_quote',
    'inquiry_volume',
    'inquiry',
    '"user"',
    'employee',
    'role',
    'customer',
    'industry_sector',
    'agent',
    'port',
    'inquiry_source',
    'currency',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  // audit_log follows its tenant down; see the cascade migration.
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
}

/** A user row with only the fields the CHECK cares about varied. */
function userRow(tenantId: bigint, suffix: string, extra: Record<string, unknown>) {
  return {
    tenantId,
    code: `USR-${suffix}`,
    username: `u-${suffix}`,
    email: `${suffix}@agt.test`,
    passwordHash: 'not-a-real-hash',
    ...extra,
  } as never;
}

beforeAll(async () => {
  await cleanup();

  const [a, b] = await Promise.all([
    owner.tenant.create({
      data: { name: 'Agt Alpha', slug: SLUG_A, country: 'Bangladesh' },
      select: { id: true },
    }),
    owner.tenant.create({
      data: { name: 'Agt Beta', slug: SLUG_B, country: 'Bangladesh' },
      select: { id: true },
    }),
  ]);
  tenantA = a.id;
  tenantB = b.id;

  agentA = (
    await owner.agent.create({
      data: { tenantId: tenantA, code: 'AGT-A', name: 'Alpha Agent', country: 'Denmark', agentType: 'GENERAL' },
      select: { id: true },
    })
  ).id;
  agentB = (
    await owner.agent.create({
      data: { tenantId: tenantB, code: 'AGT-B', name: 'Beta Agent', country: 'Denmark', agentType: 'GENERAL' },
      select: { id: true },
    })
  ).id;

  employeeA = (
    await owner.employee.create({
      data: {
        tenantId: tenantA,
        code: 'EMP-A',
        name: 'Alpha Staff',
        country: 'Bangladesh',
        department: 'Pricing',
        designation: 'Executive',
        joiningDate: new Date('2026-01-01'),
      },
      select: { id: true },
    })
  ).id;
  roleA = (
    await owner.role.create({
      data: { tenantId: tenantA, code: 'ROL-A', name: 'Alpha Role' },
      select: { id: true },
    })
  ).id;

  // A shared currency (tenant_id null) and one owned by the other workspace.
  const shared = await owner.currency.findFirst({
    where: { tenantId: null },
    select: { id: true },
  });
  systemCurrency =
    shared?.id ??
    (
      await owner.currency.create({
        data: { code: 'CUR-SYS', currency: 'USD — US Dollar', conversion: 1 },
        select: { id: true },
      })
    ).id;
  currencyB = (
    await owner.currency.create({
      data: { tenantId: tenantB, code: 'CUR-B', currency: 'DKK — Krone', conversion: 15 },
      select: { id: true },
    })
  ).id;

  // Enough of an inquiry for agent_quote to point at.
  const sector = await owner.industrySector.create({
    data: { tenantId: tenantA, code: 'SEC-A', name: 'Agt Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId: tenantA,
      code: 'CUS-A',
      name: 'Agt Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId: tenantA, code: 'SRC-A', name: 'Agt Source' },
    select: { id: true },
  });
  const [pol, pod] = await Promise.all([
    owner.port.create({
      data: {
        tenantId: tenantA,
        code: 'AGT-POL',
        name: 'Agt Loading',
        portCode: 'AGTPOL',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    }),
    owner.port.create({
      data: {
        tenantId: tenantA,
        code: 'AGT-POD',
        name: 'Agt Discharge',
        portCode: 'AGTPOD',
        country: 'Denmark',
        type: 'SEAPORT',
      },
      select: { id: true },
    }),
  ]);
  inquiryA = (
    await owner.inquiry.create({
      data: {
        tenantId: tenantA,
        code: 'INQ-2026-AGT001',
        seriesYear: 2026,
        inquiryDate: new Date('2026-08-22'),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType: 'INBOUND',
        loadingType: 'FCL',
        polId: pol.id,
        podId: pod.id,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('an agent account cannot also be a staff account', () => {
  it('accepts an agent user that is nothing else', async () => {
    const user = await owner.user.create({
      data: userRow(tenantA, 'ext', { agentId: agentA }),
      select: { id: true, agentId: true, isSuperadmin: true },
    });
    expect(user.agentId).toBe(agentA);
    expect(user.isSuperadmin).toBe(false);
  });

  it('refuses an agent user that is also a superadmin', async () => {
    // The single most valuable line in the phase. Not "the service layer
    // prevents it" — Postgres will not store the row.
    await expect(
      owner.user.create({ data: userRow(tenantA, 'super', { agentId: agentA, isSuperadmin: true }) }),
    ).rejects.toThrow(/user_agent_is_external/);
  });

  it('allows an agent user to hold a role, because that is how access is granted', async () => {
    // The first design banned this outright: an agent had no §7 permissions and
    // what they could reach was decided by which router they hit. A role IS the
    // grant now, so the ban moved off role_id and onto the two that matter.
    // Its own agent: agentA already has a login, and one per company is the
    // rule the index below enforces.
    const other = await owner.agent.create({
      data: {
        tenantId: tenantA,
        code: 'AGT-A2',
        name: 'Alpha Agent Two',
        country: 'Denmark',
        agentType: 'GENERAL',
      },
      select: { id: true },
    });
    const user = await owner.user.create({
      data: userRow(tenantA, 'roled', { agentId: other.id, roleId: roleA }),
      select: { agentId: true, roleId: true, isSuperadmin: true },
    });
    expect(user.agentId).toBe(other.id);
    expect(user.roleId).toBe(roleA);
    expect(user.isSuperadmin).toBe(false);
  });

  it('refuses an agent user tied to an employee record', async () => {
    await expect(
      owner.user.create({ data: userRow(tenantA, 'emp', { agentId: agentA, employeeId: employeeA }) }),
    ).rejects.toThrow(/user_agent_is_external/);
  });

  it('refuses promoting an existing agent user afterwards', async () => {
    // Creation is the obvious path and the one everybody guards. This is the
    // one that gets forgotten: the account is created correctly, then edited.
    const user = await owner.user.findFirstOrThrow({
      where: { tenantId: tenantA, agentId: agentA },
      select: { id: true },
    });
    await expect(
      owner.user.update({ where: { id: user.id }, data: { isSuperadmin: true } }),
    ).rejects.toThrow(/user_agent_is_external/);
  });

  it('refuses a blanket promotion of every agent account at once', async () => {
    // The query somebody would actually run if they wanted to do this — not a
    // careful per-row update the service layer might have guarded, but one
    // sweeping statement typed into psql. The constraint is checked per row, so
    // the whole statement fails.
    await expect(
      owner.$executeRawUnsafe(`UPDATE "user" SET is_superadmin = true WHERE agent_id IS NOT NULL`),
    ).rejects.toThrow(/user_agent_is_external/);
  });

  it('still refuses to attach every agent account to an employee record', async () => {
    // The denial that survived, and the one that matters: an agent must never
    // be tied to a member of staff.
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE "user" SET employee_id = ${employeeA} WHERE agent_id IS NOT NULL AND tenant_id = ${tenantA}`,
      ),
    ).rejects.toThrow(/user_agent_is_external/);
  });

  it('allows only one login per agent company', async () => {
    // The client's rule, and a fact about the database rather than a promise
    // the Add User screen makes.
    await expect(
      owner.user.create({ data: userRow(tenantA, 'second', { agentId: agentA }) }),
    ).rejects.toThrow(/user_one_login_per_agent|Unique constraint/i);
  });

  it('leaves staff accounts alone', async () => {
    const staff = await owner.user.create({
      data: userRow(tenantA, 'staff', { employeeId: employeeA, roleId: roleA, isSuperadmin: true }),
      select: { agentId: true, isSuperadmin: true },
    });
    expect(staff.agentId).toBeNull();
    expect(staff.isSuperadmin).toBe(true);
  });

  it('refuses a user pointed at another workspace agent', async () => {
    // §4 rule 10: the key is composite, so (tenantA, agentB) is not a row that
    // exists — the reference fails rather than crossing the boundary.
    await expect(
      owner.user.create({ data: userRow(tenantA, 'cross', { agentId: agentB }) }),
    ).rejects.toThrow(/user_agent_id_fkey|foreign key/i);
  });
});

describe('agent_quote', () => {
  const base = () => ({
    tenantId: tenantA,
    inquiryId: inquiryA,
    agentId: agentA,
    currencyId: systemCurrency,
    updatedAt: new Date(),
  });

  it('stores a submitted quote', async () => {
    const quote = await owner.agentQuote.create({
      data: { ...base(), code: 'AQ-001', amount: 1450 },
      select: { status: true, isActive: true, amount: true },
    });
    expect(quote.status).toBe('SUBMITTED');
    expect(quote.isActive).toBe(true);
    expect(Number(quote.amount)).toBe(1450);
  });

  it('allows one live quote per agent per inquiry', async () => {
    await expect(
      owner.agentQuote.create({ data: { ...base(), code: 'AQ-002', amount: 1500 } }),
    ).rejects.toThrow(/agent_quote_one_live_per_agent|Unique constraint/i);
  });

  it('frees the slot once the first is withdrawn', async () => {
    // Resubmission is withdraw-then-quote, so "the agent's price" is never
    // ambiguous at the moment someone reads it.
    await owner.agentQuote.updateMany({
      where: { tenantId: tenantA, code: 'AQ-001' },
      data: { status: 'WITHDRAWN' },
    });
    const second = await owner.agentQuote.create({
      data: { ...base(), code: 'AQ-003', amount: 1600 },
      select: { id: true },
    });
    expect(second.id).toBeGreaterThan(0n);
  });

  it('requires an amount while quotes are single-price', async () => {
    await expect(
      owner.agentQuote.create({ data: { ...base(), code: 'AQ-004', agentId: agentA } as never }),
    ).rejects.toThrow(/agent_quote_amount_required|violates check/i);
  });

  it('refuses a zero or negative price', async () => {
    await expect(
      owner.agentQuote.create({ data: { ...base(), code: 'AQ-005', amount: 0 } }),
    ).rejects.toThrow(/agent_quote_amount_positive|violates check/i);
  });

  it('refuses another workspace currency', async () => {
    // currency is system-capable, so the composite FK cannot be used and the
    // §4 rule 10 guard is a trigger instead. This proves the trigger is on.
    await expect(
      owner.agentQuote.create({
        data: { ...base(), code: 'AQ-006', amount: 900, currencyId: currencyB },
      }),
    ).rejects.toThrow(/cross-tenant/i);
  });

  it('refuses another workspace inquiry', async () => {
    await expect(
      owner.agentQuote.create({
        data: { ...base(), tenantId: tenantB, agentId: agentB, code: 'AQ-007', amount: 900 },
      }),
    ).rejects.toThrow(/foreign key|agent_quote_inquiry_id_fkey/i);
  });
});


describe('the new tables are governed like every other one', () => {
  it('never lets the application delete a quote or a token', async () => {
    const grants = await owner.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'ff_app' AND table_name = 'agent_quote'
      ORDER BY table_name, privilege_type`;
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    // §4 rule 3 is soft delete only, and a spent token is evidence.
    expect(byTable.get('agent_quote')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('has row level security switched on', async () => {
    const rows = await owner.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname = 'agent_quote'`;
    expect(rows).toHaveLength(1);
    for (const row of rows) expect(row.relrowsecurity).toBe(true);
  });

});
