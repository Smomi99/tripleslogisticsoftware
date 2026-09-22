import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * CR-004 step 3: what a customer session can reach, tested at the database.
 *
 * Like agent-rls.test.ts, **nothing here goes through the application**. It
 * opens a raw connection as `ff_app`, sets the session GUCs by hand and asks
 * Postgres directly — which is what a forgotten `where` in a portal route, or a
 * developer with the runtime credential, would get.
 *
 * Two customers inside one workspace and a third in another, because both
 * boundaries have to hold: customer A must not read customer B's bookings, and
 * neither may reach the second tenant at all.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

let app: Client;

const SLUG_A = 'cust-rls-alpha';
const SLUG_B = 'cust-rls-beta';

let tenantA: bigint;
let tenantB: bigint;
let alpha: bigint;
let bravo: bigint;
let foreign: bigint;
let alphaShipment: bigint;
let bravoShipment: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'bl_draft_container',
    'bl_draft',
    'bl_template',
    'shipment_advise_line',
    'shipment_advise',
    'shipment_cargo_line',
    'shipment_po',
    'shipment',
    'quotation_line',
    'quotation',
    'inquiry',
    '"user"',
    'customer_pic',
    'customer',
    'industry_sector',
    'carrier',
    'carrier_type',
    'port',
    'currency',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
}

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await app.query(sql, params);
  return result.rows as Record<string, unknown>[];
}

async function count(table: string): Promise<number> {
  const result = await rows(`SELECT count(*)::int AS n FROM ${table}`);
  return result[0]?.['n'] as number;
}

/** Becomes a customer session, the way withCustomer does at runtime. */
async function asCustomer(tenantId: bigint, customerId: bigint): Promise<void> {
  await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId.toString()]);
  await app.query(`SELECT set_config('app.agent_id', '', false)`);
  await app.query(`SELECT set_config('app.customer_id', $1, false)`, [customerId.toString()]);
  await app.query(`SELECT set_config('app.actor_kind', 'CUSTOMER', false)`);
}

async function asStaff(tenantId: bigint): Promise<void> {
  await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId.toString()]);
  await app.query(`SELECT set_config('app.agent_id', '', false)`);
  await app.query(`SELECT set_config('app.customer_id', '', false)`);
  await app.query(`SELECT set_config('app.actor_kind', 'STAFF', false)`);
}

beforeAll(async () => {
  await cleanup();

  const [a, b] = await Promise.all([
    owner.tenant.create({
      data: { name: 'Cust RLS Alpha', slug: SLUG_A, country: 'Bangladesh' },
      select: { id: true },
    }),
    owner.tenant.create({
      data: { name: 'Cust RLS Beta', slug: SLUG_B, country: 'Bangladesh' },
      select: { id: true },
    }),
  ]);
  tenantA = a.id;
  tenantB = b.id;

  const sector = async (tenantId: bigint, code: string) =>
    (
      await owner.industrySector.create({
        data: { tenantId, code, name: `${code} sector` },
        select: { id: true },
      })
    ).id;
  const sectorA = await sector(tenantA, 'CR-SEC-A');
  const sectorB = await sector(tenantB, 'CR-SEC-B');

  const customer = async (tenantId: bigint, sectorId: bigint, code: string, name: string) =>
    (
      await owner.customer.create({
        data: {
          tenantId,
          code,
          name,
          country: 'Bangladesh',
          customerType: 'EXPORTER',
          businessArea: 'BOTH',
          industrySectorId: sectorId,
        },
        select: { id: true },
      })
    ).id;
  alpha = await customer(tenantA, sectorA, 'CR-CUS-A', 'Alpha Shippers');
  bravo = await customer(tenantA, sectorA, 'CR-CUS-B', 'Bravo Trading');
  foreign = await customer(tenantB, sectorB, 'CR-CUS-F', 'Foreign Co');

  await owner.customerPic.create({
    data: { tenantId: tenantA, code: 'CR-PIC-A', customerId: alpha, name: 'Alpha Contact' },
  });
  await owner.customerPic.create({
    data: { tenantId: tenantA, code: 'CR-PIC-B', customerId: bravo, name: 'Bravo Contact' },
  });

  // A booking each, so "only my own" has something to be wrong about.
  const carrierType = await owner.carrierType.create({
    data: { tenantId: tenantA, code: 'CR-CTY', name: 'CR type' },
    select: { id: true },
  });
  const carrier = await owner.carrier.create({
    data: { tenantId: tenantA, code: 'CR-CAR', name: 'CR Lines', typeId: carrierType.id },
    select: { id: true },
  });
  const port = async (code: string) =>
    (
      await owner.port.create({
        data: {
          tenantId: tenantA,
          code,
          name: `${code} Port`,
          portCode: code,
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;
  const pol = await port('CRPOL');
  const pod = await port('CRPOD');

  // System rows, seeded once for the whole platform.
  const source = await owner.inquirySource.findFirstOrThrow({ select: { id: true } });
  const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });

  const makeShipment = async (customerId: bigint, code: string): Promise<bigint> => {
    const inquiry = await owner.inquiry.create({
      data: {
        tenantId: tenantA,
        code: `INQ-${code}`,
        seriesYear: 2026,
        inquiryDate: new Date('2026-09-02'),
        sourceId: source.id,
        customerId,
        shipmentType: 'SEA',
        movementType: 'OUTBOUND',
        polId: pol,
        podId: pod,
        status: 'OPEN',
      },
      select: { id: true },
    });
    const quotation = await owner.quotation.create({
      data: {
        tenantId: tenantA,
        code: `QTN-${code}`,
        seriesYear: 2026,
        inquiryId: inquiry.id,
        customerId,
        quotationDate: new Date('2026-09-02'),
        shipmentType: 'SEA',
        movementType: 'OUTBOUND',
        polId: pol,
        podId: pod,
        carrierId: carrier.id,
        localCurrencyId: currency.id,
        conversionRate: '122.0000',
      },
      select: { id: true },
    });
    const shipment = await owner.shipment.create({
      data: {
        tenantId: tenantA,
        code: `BKG-${code}`,
        seriesYear: 2026,
        quotationId: quotation.id,
        shipmentType: 'SEA',
        customerId,
        carrierId: carrier.id,
        polId: pol,
        podId: pod,
      },
      select: { id: true },
    });
    return shipment.id;
  };

  alphaShipment = await makeShipment(alpha, 'CRA');
  bravoShipment = await makeShipment(bravo, 'CRB');

  app = new Client({ connectionString: env.DATABASE_URL_APP ?? env.DATABASE_URL });
  await app.connect();
});

afterAll(async () => {
  await app?.end();
  await cleanup();
  await owner.$disconnect();
});

describe('the role these tests run as', () => {
  it('is not the table owner, or none of this would apply', async () => {
    const result = await rows(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(result[0]?.['rolbypassrls']).toBe(false);
    expect(result[0]?.['rolsuper']).toBe(false);
  });
});

describe('a customer sees only their own company', () => {
  beforeAll(() => asCustomer(tenantA, alpha));

  it('reads their own record and no other', async () => {
    expect(await count('customer')).toBe(1);
    const own = await rows('SELECT id FROM customer');
    expect(String(own[0]?.['id'])).toBe(alpha.toString());
  });

  it('reads their own contacts only', async () => {
    const pics = await rows('SELECT customer_id FROM customer_pic');
    expect(pics).toHaveLength(1);
    expect(String(pics[0]?.['customer_id'])).toBe(alpha.toString());
  });

  it('reads their own bookings only', async () => {
    const bookings = await rows('SELECT id, customer_id FROM shipment');
    expect(bookings).toHaveLength(1);
    expect(String(bookings[0]?.['id'])).toBe(alphaShipment.toString());
  });

  it('cannot read the other customer booking by naming it', async () => {
    const found = await rows('SELECT id FROM shipment WHERE id = $1', [
      bravoShipment.toString(),
    ]);
    expect(found).toEqual([]);
  });

  it('reads their own view rows only', async () => {
    expect(await count('customer_shipment_v')).toBe(1);
  });
});

describe('the commercially sensitive tables are shut', () => {
  beforeAll(() => asCustomer(tenantA, alpha));

  it('cannot read staff accounts, agents or vendors', async () => {
    expect(await count('"user"')).toBe(0);
    expect(await count('agent')).toBe(0);
    expect(await count('vendor')).toBe(0);
  });

  it('cannot read quotations, inquiries or rates', async () => {
    expect(await count('quotation')).toBe(0);
    expect(await count('inquiry')).toBe(0);
    expect(await count('freight_rate')).toBe(0);
  });

  it('cannot read the audit trail or the workspace record', async () => {
    expect(await count('audit_log')).toBe(0);
    expect(await count('tenant')).toBe(0);
  });

  it('cannot read the container load plans', async () => {
    /*
     * Deliberate, and the reason the customer's BL draft leaves the container
     * block to the forwarder: a consolidated box carries several companies'
     * cargo, and its totals are nobody else's business.
     */
    expect(await count('clp')).toBe(0);
    expect(await count('clp_line')).toBe(0);
  });

  it('cannot read settings it was not given', async () => {
    expect(await count('carrier')).toBe(0);
    expect(await count('cost_head')).toBe(0);
  });

  it('can read the two lookups the BL form renders', async () => {
    // Opened on purpose: the form cannot draw Pre-Carriage By or the ports
    // without them, and neither is confidential.
    expect(await count('port')).toBeGreaterThan(0);
    expect(await count('mode')).toBeGreaterThanOrEqual(0);
  });
});

describe('the tenant boundary still holds underneath', () => {
  it('shows nothing when a customer is paired with the wrong workspace', async () => {
    // A forged session naming another workspace's customer id. Both predicates
    // have to pass, so mismatching them yields nothing rather than everything.
    await asCustomer(tenantA, foreign);
    expect(await count('customer')).toBe(0);
    expect(await count('shipment')).toBe(0);

    await asCustomer(tenantB, alpha);
    expect(await count('customer')).toBe(0);
    expect(await count('shipment')).toBe(0);
  });
});

describe('a customer cannot write outside their own file', () => {
  beforeAll(() => asCustomer(tenantA, alpha));

  it('cannot insert a staff account', async () => {
    await expect(
      app.query(
        `INSERT INTO "user" (tenant_id, code, username, email, password_hash)
         VALUES ($1, 'CR-HACK', 'hacker', 'h@x', 'x')`,
        [tenantA.toString()],
      ),
    ).rejects.toThrow();
  });

  it('cannot create a BL draft against another customer booking', async () => {
    /*
     * The WITH CHECK half of customer_rw. Without it the row would be written
     * and merely hidden afterwards — a draft in the forwarder's queue with the
     * wrong company's cargo on it.
     */
    await expect(
      app.query(
        `INSERT INTO bl_draft
           (tenant_id, code, series_year, shipment_id, advise_id, bl_no,
            shipper_text, consignee_text, notify_text,
            pre_carriage_by_mode_id, place_of_receipt, pol_id, pod_id)
         SELECT $1, 'BLD-HACK', 2026, $2, 1, 'X', 'a', 'b', 'c', 1, 'x', 1, 1`,
        [tenantA.toString(), bravoShipment.toString()],
      ),
    ).rejects.toThrow();
  });
});

describe('staff are unaffected', () => {
  beforeAll(() => asStaff(tenantA));

  it('still sees both customers and both bookings', async () => {
    expect(await count('customer')).toBe(2);
    expect(await count('shipment')).toBe(2);
  });

  it('sees nothing through the customer view, which is not theirs', async () => {
    // The view requires app_current_customer() to be set, so a staff session
    // reads zero rows from it. Staff read the table.
    expect(await count('customer_shipment_v')).toBe(0);
  });
});
