import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Phase 3 of the agent portal: row level security, tested at the database.
 *
 * **Nothing in this file goes through the application.** No Express, no Prisma
 * client extension, no route guard, no DTO. It opens a raw connection as the
 * runtime role `ff_app`, sets `app.tenant_id` and `app.agent_id` by hand, and
 * asks Postgres directly — which is exactly what an attacker holding a database
 * credential, or a developer who forgot a `where`, would get.
 *
 * If a query here returns a row it should not, no amount of correct application
 * code makes the product safe. That is the whole point of the layer.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

/** The runtime role. It owns nothing, so RLS actually applies to it (§7A). */
let app: Client;

const SLUG_A = 'rls-alpha';
const SLUG_B = 'rls-beta';

let tenantA: bigint;
let tenantB: bigint;
/** Two agents inside the same workspace — the pair decision 5 is about. */
let nordic: bigint;
let baltic: bigint;
/** An agent belonging to an entirely different forwarder. */
let foreign: bigint;

let sharedInquiry: bigint;
let balticInquiry: bigint;
let unsentInquiry: bigint;
let nordicQuote: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'agent_quote',
    'inquiry_party_contact',
    'inquiry_party',
    'inquiry_volume',
    'inquiry',
    'freight_rate_line',
    'freight_rate',
    '"user"',
    'agent_pic',
    'agent',
    'customer',
    'industry_sector',
    'port',
    'carrier',
    'cost_head',
    'cost_unit',
    'goods_type',
    'inquiry_source',
    'currency',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
}

/** Becomes an agent session, the way withAgent does at runtime. */
async function asAgent(tenantId: bigint, agentId: bigint): Promise<void> {
  await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId.toString()]);
  await app.query(`SELECT set_config('app.agent_id', $1, false)`, [agentId.toString()]);
}

/** Becomes a staff session: same tenant, no agent. */
async function asStaff(tenantId: bigint): Promise<void> {
  await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId.toString()]);
  await app.query(`SELECT set_config('app.agent_id', '', false)`);
}

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await app.query(sql, params);
  return result.rows as Record<string, unknown>[];
}

async function count(table: string): Promise<number> {
  const result = await rows(`SELECT count(*)::int AS n FROM ${table}`);
  return result[0]?.['n'] as number;
}

beforeAll(async () => {
  await cleanup();

  const [a, b] = await Promise.all([
    owner.tenant.create({
      data: { name: 'RLS Alpha', slug: SLUG_A, country: 'Bangladesh' },
      select: { id: true },
    }),
    owner.tenant.create({
      data: { name: 'RLS Beta', slug: SLUG_B, country: 'Bangladesh' },
      select: { id: true },
    }),
  ]);
  tenantA = a.id;
  tenantB = b.id;

  const agent = (tenantId: bigint, code: string, name: string) =>
    owner.agent.create({
      data: { tenantId, code, name, country: 'Denmark', agentType: 'GENERAL' },
      select: { id: true },
    });
  nordic = (await agent(tenantA, 'RLS-N', 'Nordic Forwarding')).id;
  baltic = (await agent(tenantA, 'RLS-B', 'Baltic Lines')).id;
  foreign = (await agent(tenantB, 'RLS-F', 'Foreign Agent')).id;

  await owner.agentPic.create({
    data: { tenantId: tenantA, code: 'RLS-PN', agentId: nordic, name: 'Nordic Contact' },
  });
  await owner.agentPic.create({
    data: { tenantId: tenantA, code: 'RLS-PB', agentId: baltic, name: 'Baltic Contact' },
  });

  // Reference data for a lane.
  const sector = await owner.industrySector.create({
    data: { tenantId: tenantA, code: 'RLS-SEC', name: 'RLS Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId: tenantA,
      code: 'RLS-CUS',
      name: 'Confidential Shipper Ltd',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId: tenantA, code: 'RLS-SRC', name: 'RLS Source' },
    select: { id: true },
  });
  const port = (code: string, country: string) =>
    owner.port.create({
      data: {
        tenantId: tenantA,
        code,
        name: `${code} Port`,
        portCode: code,
        country,
        type: 'SEAPORT',
      },
      select: { id: true },
    });
  const pol = await port('RLSPOL', 'Bangladesh');
  const pod = await port('RLSPOD', 'Denmark');

  // The charge vocabulary an agent has to quote in. Present so the boundary
  // tests can assert what is readable, not merely that nothing is. (A carrier
  // already exists further down, built for the rate fixture.)
  const costUnit = await owner.costUnit.create({
    data: { tenantId: tenantA, code: 'RLS-CU', name: 'Container' },
    select: { id: true },
  });
  await owner.costHead.create({
    data: {
      tenantId: tenantA,
      code: 'RLS-CH',
      category: 'SERVICE',
      name: 'Ocean Freight',
      unitId: costUnit.id,
    },
  });

  const inquiry = async (code: string) =>
    owner.inquiry.create({
      data: {
        tenantId: tenantA,
        code,
        seriesYear: 2026,
        inquiryDate: new Date('2026-08-23'),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType: 'INBOUND',
        loadingType: 'FCL',
        polId: pol.id,
        podId: pod.id,
        // Deliberately names the customer: if this ever reaches an agent, the
        // test below says so out loud.
        remarks: 'Quote by Friday for Confidential Shipper Ltd.',
      },
      select: { id: true },
    });
  sharedInquiry = (await inquiry('INQ-2026-RLS001')).id;
  balticInquiry = (await inquiry('INQ-2026-RLS002')).id;
  unsentInquiry = (await inquiry('INQ-2026-RLS003')).id;

  // Who was actually sent what. This — and nothing else — is the boundary.
  await owner.inquiryParty.create({
    data: { tenantId: tenantA, inquiryId: sharedInquiry, agentId: nordic },
  });
  await owner.inquiryParty.create({
    data: { tenantId: tenantA, inquiryId: balticInquiry, agentId: baltic },
  });

  await owner.inquiryVolume.create({
    data: {
      tenantId: tenantA,
      inquiryId: sharedInquiry,
      volumeKind: 'FCL',
      quantity: 2,
      targetPrice: 1234.5678,
    },
  });

  // A bought rate, with the margin on it. The single most commercially
  // sensitive table in the product.
  const carrier = await owner.carrier.create({
    data: {
      tenantId: tenantA,
      code: 'RLS-CAR',
      name: 'RLS Line',
      typeId: (await owner.carrierType.findFirstOrThrow({ select: { id: true } })).id,
    },
    select: { id: true },
  });
  const goods = await owner.goodsType.create({
    data: { tenantId: tenantA, code: 'RLS-GT', name: 'RLS Goods' },
    select: { id: true },
  });
  const currency = await owner.currency.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });
  const rate = await owner.freightRate.create({
    data: {
      tenantId: tenantA,
      code: 'RATE-RLS-1',
      mode: 'SEA_FCL',
      polId: pol.id,
      podId: pod.id,
      carrierId: carrier.id,
      goodsTypeId: goods.id,
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrier.id,
      currencyId: currency.id,
      validFrom: new Date('2026-08-01'),
      validTo: new Date('2026-12-31'),
    },
    select: { id: true },
  });
  const tier = await owner.rateTier.findFirstOrThrow({
    where: { mode: 'SEA_FCL' },
    select: { id: true },
  });
  await owner.freightRateLine.create({
    data: { tenantId: tenantA, rateId: rate.id, tierId: tier.id, buyPrice: 900 },
  });

  nordicQuote = (
    await owner.agentQuote.create({
      data: {
        tenantId: tenantA,
        code: 'AQ-RLS-1',
        inquiryId: sharedInquiry,
        agentId: nordic,
        currencyId: currency.id,
        amount: 1400,
        updatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  await owner.agentQuote.create({
    data: {
      tenantId: tenantA,
      code: 'AQ-RLS-2',
      inquiryId: balticInquiry,
      agentId: baltic,
      currencyId: currency.id,
      amount: 1500,
      updatedAt: new Date(),
    },
  });

  app = new Client({ connectionString: env.DATABASE_URL_APP });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await cleanup();
  await owner.$disconnect();
});

describe('the role these tests run as', () => {
  it('is not the table owner, or none of this would apply', async () => {
    // A table owner bypasses RLS entirely. If the API ever connects as the
    // owner, every policy in the product silently stops binding — so this is
    // asserted before anything else is concluded from the tests below.
    const who = await rows('SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses');
    expect(who[0]?.['role']).toBe('ff_app');
    expect(who[0]?.['bypasses']).toBe(false);

    const owns = await rows(
      `SELECT count(*)::int AS n FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = current_user`,
    );
    expect(owns[0]?.['n']).toBe(0);
  });
});

describe('an agent sees only what they were sent', () => {
  beforeAll(() => asAgent(tenantA, nordic));

  it('reads the inquiry they were selected for', async () => {
    const found = await rows('SELECT id, code FROM inquiry');
    expect(found).toHaveLength(1);
    expect(found[0]?.['code']).toBe('INQ-2026-RLS001');
  });

  it('cannot read another agent inquiry in the same workspace', async () => {
    const found = await rows('SELECT id FROM inquiry WHERE id = $1', [balticInquiry.toString()]);
    expect(found).toHaveLength(0);
  });

  it('cannot read an inquiry nobody was selected for', async () => {
    // Not "an inquiry on their lane" and not "an open inquiry" — explicit
    // selection is the authorization boundary, and this is what proves it.
    const found = await rows('SELECT id FROM inquiry WHERE id = $1', [unsentInquiry.toString()]);
    expect(found).toHaveLength(0);
  });

  it('cannot see who else was sent the same inquiry', async () => {
    // inquiry_party is opened to agents only for their OWN rows, or an agent
    // could enumerate the forwarder's entire competitor list from one inquiry.
    const parties = await rows('SELECT agent_id FROM inquiry_party');
    expect(parties).toHaveLength(1);
    expect(String(parties[0]?.['agent_id'])).toBe(nordic.toString());
  });

  it('reads only their own record and their own people', async () => {
    const agents = await rows('SELECT id FROM agent');
    expect(agents).toHaveLength(1);
    expect(String(agents[0]?.['id'])).toBe(nordic.toString());

    const pics = await rows('SELECT name FROM agent_pic');
    expect(pics.map((p) => p['name'])).toEqual(['Nordic Contact']);
  });
});

describe('the commercially sensitive tables are shut', () => {
  beforeAll(() => asAgent(tenantA, nordic));

  it('cannot read bought rates or the margin on them', async () => {
    // The forwarder's buying position. An agent reading this can see exactly
    // what the forwarder pays their competitors.
    expect(await count('freight_rate')).toBe(0);
    expect(await count('freight_rate_line')).toBe(0);
    expect(await count('rate_local_charge')).toBe(0);
    expect(await count('inquiry_rate')).toBe(0);
  });

  it('cannot read customers, staff or vendors', async () => {
    expect(await count('customer')).toBe(0);
    expect(await count('"user"')).toBe(0);
    expect(await count('employee')).toBe(0);
    expect(await count('vendor')).toBe(0);
  });

  it('cannot read the audit trail', async () => {
    expect(await count('audit_log')).toBe(0);
  });

  it('cannot read the workspace record itself', async () => {
    expect(await count('tenant')).toBe(0);
  });

  it('cannot read settings tables', async () => {
    for (const table of ['vessel', 'carrier_pic', 'role', 'notification_setting']) {
      expect(await count(table), table).toBe(0);
    }
  });

  /*
   * carrier, cost_head and cost_unit were on the closed list until the client's
   * wireframe put a Carrier and a Cost Head dropdown in the agent's own hands.
   * Opening them was a deliberate decision and this is where it is recorded.
   *
   * What they expose is trade vocabulary: the names of shipping lines, the
   * forwarder's charge labels, and units like Container and CBM. An agent
   * quoting you already knows what a THC is. What stays shut is everything with
   * a number attached — the assertions below the change say so.
   */
  it('can read the vocabulary it has to quote in', async () => {
    expect(await count('carrier')).toBeGreaterThan(0);
    expect(await count('cost_head')).toBeGreaterThan(0);
    expect(await count('cost_unit')).toBeGreaterThan(0);
  });

  it('still cannot read anything priced', async () => {
    // The widening above must not have dragged a rate table with it.
    for (const table of ['freight_rate', 'freight_rate_line', 'rate_local_charge', 'inquiry_rate']) {
      expect(await count(table), table).toBe(0);
    }
  });

  it('can read the reference data a lane needs', async () => {
    // Deliberately short, and asserted so that the list stays short: anything
    // added here is new surface for an outside company.
    expect(await count('port')).toBeGreaterThan(0);
    expect(await count('currency')).toBeGreaterThan(0);
  });
});

describe('an agent cannot become staff', () => {
  beforeAll(() => asAgent(tenantA, nordic));

  it('cannot promote themselves, because the row is not even visible', async () => {
    const result = await app.query(`UPDATE "user" SET is_superadmin = true`);
    expect(result.rowCount).toBe(0);
  });

  it('cannot insert a staff account', async () => {
    await expect(
      app.query(
        `INSERT INTO "user" (tenant_id, code, username, email, password_hash, is_superadmin, updated_at)
         VALUES ($1, 'RLS-HACK', 'hacker', 'h@x.test', 'x', true, now())`,
        [tenantA.toString()],
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('cannot grant themselves an inquiry by inserting a party row', async () => {
    // inquiry_party is SELECT-only for agents. Without that, an agent could
    // simply add themselves to every inquiry in the workspace.
    await expect(
      app.query(
        `INSERT INTO inquiry_party (tenant_id, inquiry_id, agent_id)
         VALUES ($1, $2, $3)`,
        [tenantA.toString(), unsentInquiry.toString(), nordic.toString()],
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe('quotes belong to the agent that wrote them', () => {
  beforeAll(() => asAgent(tenantA, nordic));

  it('reads their own and no others', async () => {
    const quotes = await rows('SELECT code FROM agent_quote');
    expect(quotes.map((q) => q['code'])).toEqual(['AQ-RLS-1']);
  });

  it('cannot write a quote in another agent name', async () => {
    // WITH CHECK, not just USING: without it the row would be created and then
    // merely hidden, which is worse than refusing it.
    await expect(
      app.query(
        `INSERT INTO agent_quote (tenant_id, code, inquiry_id, agent_id, currency_id, amount, updated_at)
         SELECT $1, 'AQ-RLS-FORGE', $2, $3, currency_id, 1, now() FROM agent_quote WHERE id = $4`,
        [
          tenantA.toString(),
          balticInquiry.toString(),
          baltic.toString(),
          nordicQuote.toString(),
        ],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot edit another agent quote', async () => {
    const result = await app.query(`UPDATE agent_quote SET amount = 1 WHERE code = 'AQ-RLS-2'`);
    expect(result.rowCount).toBe(0);
  });
});

describe('the view is the column boundary', () => {
  beforeAll(() => asAgent(tenantA, nordic));

  it('offers no customer and no price columns at all', async () => {
    // Omission is structural: there is no column to select, so no query — and
    // no future careless `SELECT *` — can return one.
    const columns = await rows(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_inquiry_v' ORDER BY column_name`,
    );
    const names = columns.map((c) => c['column_name']);
    expect(names).not.toContain('customer_id');
    expect(names).not.toContain('salesman_id');
    expect(names).not.toContain('notify_emails');
    // Free text the forwarder's staff type. It was the one field whose safety
    // depended on what somebody happened to write; the client's answer was to
    // take it out, so decision 2 is now structural everywhere.
    expect(names).not.toContain('remarks');
    expect(names).toContain('pol_id');
    expect(names).toContain('code');
  });

  it('hides the target price from the volume view', async () => {
    const columns = await rows(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_inquiry_volume_v'`,
    );
    expect(columns.map((c) => c['column_name'])).not.toContain('target_price');
  });

  it('shows the same one inquiry the base table does', async () => {
    const view = await rows('SELECT code FROM agent_inquiry_v');
    expect(view.map((r) => r['code'])).toEqual(['INQ-2026-RLS001']);
  });

  it('still filters by agent even if the invoker setting were lost', async () => {
    // The view carries its own agent predicate as well as relying on RLS. Two
    // independent reasons a row is excluded, so neither being wrong is fatal.
    const definition = await rows(
      `SELECT pg_get_viewdef('agent_inquiry_v'::regclass, true) AS def`,
    );
    expect(String(definition[0]?.['def'])).toContain('app_current_agent()');
  });
});

describe('selection can be taken away again', () => {
  it('hides an inquiry the moment the party row is removed', async () => {
    await asAgent(tenantA, nordic);
    expect(await count('inquiry')).toBe(1);

    // The forwarder changes their mind, or the inquiry is re-routed. Access is
    // not a copy taken at send time — it is a live join, so withdrawing the row
    // withdraws the inquiry with it.
    await owner.$executeRawUnsafe(
      `DELETE FROM inquiry_party WHERE inquiry_id = ${sharedInquiry} AND agent_id = ${nordic}`,
    );
    expect(await count('inquiry')).toBe(0);
    // And the view agrees, since it carries the same predicate independently.
    expect(await count('agent_inquiry_v')).toBe(0);
    expect(await count('agent_inquiry_volume_v')).toBe(0);

    // Their own quote survives — it is a record of what they said, not an
    // entitlement to the inquiry.
    expect(await count('agent_quote')).toBe(1);

    await owner.$executeRawUnsafe(
      `INSERT INTO inquiry_party (tenant_id, inquiry_id, agent_id)
       VALUES (${tenantA}, ${sharedInquiry}, ${nordic})`,
    );
    expect(await count('inquiry')).toBe(1);
  });
});

describe('the tenant boundary still holds underneath', () => {
  it('shows nothing when an agent is paired with the wrong workspace', async () => {
    // A forged session naming another forwarder's agent id. Both predicates
    // have to pass, so mismatching them yields nothing rather than everything.
    await asAgent(tenantA, foreign);
    expect(await count('inquiry')).toBe(0);
    expect(await count('agent')).toBe(0);

    await asAgent(tenantB, nordic);
    expect(await count('inquiry')).toBe(0);
  });
});

describe('staff are unaffected', () => {
  beforeAll(() => asStaff(tenantA));

  it('still sees everything in their own workspace', async () => {
    // The backward-compatibility claim, checked directly rather than inferred
    // from the rest of the suite passing.
    expect(await count('inquiry')).toBe(3);
    expect(await count('customer')).toBe(1);
    expect(await count('freight_rate')).toBe(1);
    expect(await count('agent')).toBe(2);
    expect(await count('agent_quote')).toBe(2);
  });

  it('still sees the columns agents cannot', async () => {
    const inquiry = await rows('SELECT customer_id FROM inquiry WHERE id = $1', [
      sharedInquiry.toString(),
    ]);
    expect(inquiry[0]?.['customer_id']).not.toBeNull();

    const volume = await rows('SELECT target_price FROM inquiry_volume');
    expect(Number(volume[0]?.['target_price'])).toBe(1234.5678);
  });

  it('still cannot cross into another workspace', async () => {
    await asStaff(tenantB);
    expect(await count('inquiry')).toBe(0);
    expect(await count('customer')).toBe(0);
  });
});
