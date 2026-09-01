import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { findBlockingReferences } from './references';
import { withTenant } from './tenant-client';

/**
 * The reference check behind CR-002's Delete action.
 *
 * It reads Postgres' own catalogue rather than a hand-kept list, so the test
 * that matters is not "does it find carrier_pic" — it is "does it find an edge
 * nobody told it about". A new table added next month must block a delete
 * without anyone remembering to come back here.
 */

// The runtime client connects as ff_app, and the tenant_self policy hides
// every tenant row until app.tenant_id is already set — so the id has to come
// from the owner connection, the same way the isolation tests get it.
const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

// This file used to take `tenant.findFirst()`, which on a developer's machine
// is their own workspace — so every run created and soft-deleted scratch rows
// in real data, and left permanent audit rows behind for them. It builds its
// own tenant now, like every other suite here.
const SLUG = 'ref-alpha';
let tenantId: bigint;
let carrierId: bigint;
let sectorId: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    '"user"',
    'customer_pic',
    'customer',
    'industry_sector',
    'carrier_service_port',
    'port',
    'carrier',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  // audit_log follows the tenant down; see the cascade migration.
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'Ref Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  // customer.industry_sector_id is NOT NULL, and §4 rule 10 makes its foreign
  // key composite — so it has to be a sector this tenant owns, not a shared one.
  sectorId = (
    await owner.industrySector.create({
      data: { tenantId, code: 'REF-SEC', name: 'Reference Sector' },
      select: { id: true },
    })
  ).id;
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'REF-CAR', name: 'Reference Line', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('findBlockingReferences', () => {
  it('discovers every foreign key pointing at a table, from the catalogue', async () => {
    await withTenant(tenantId, async (db) => {
      // Nothing references this id; the point is the edge list it built.
      const rows = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n
        FROM pg_constraint con
        JOIN pg_class ref ON ref.oid = con.confrelid
        WHERE con.contype = 'f' AND ref.relname = 'carrier'`;
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(6);
    });
  });

  it('returns nothing for a row nothing points at', async () => {
    await withTenant(tenantId, async (db) => {
      const port = await db.port.create({
        data: {
          tenantId,
          code: `ZZ-${Date.now().toString().slice(-6)}`,
          name: 'Reference Check Scratch',
          portCode: `Z${Date.now().toString().slice(-4)}`,
          country: 'Bangladesh',
          type: 'SEAPORT',
          createdBy: 1n,
          updatedBy: 1n,
        },
        select: { id: true },
      });

      expect(await findBlockingReferences(db, 'port', port.id)).toEqual([]);

      // Point one row at it and the same call must now object.
      await db.carrierServicePort.create({
        data: {
          tenantId,
          code: `ZZSP-${Date.now().toString().slice(-6)}`,
          carrierId,
          portId: port.id,
          country: 'Bangladesh',
          createdBy: 1n,
          updatedBy: 1n,
        },
      });

      const blocked = await findBlockingReferences(db, 'port', port.id);
      expect(blocked.map((b) => b.table)).toContain('carrier_service_port');
      expect(blocked.find((b) => b.table === 'carrier_service_port')?.count).toBe(1);
    });
  });

  it('ignores rows that are themselves deleted', async () => {
    await withTenant(tenantId, async (db) => {
      const port = await db.port.findFirst({
        where: { tenantId, name: 'Reference Check Scratch', deletedAt: null },
        select: { id: true },
      });
      if (port === null) throw new Error('previous test should have created it');

      await db.carrierServicePort.updateMany({
        where: { portId: port.id },
        data: { deletedAt: new Date(), isActive: false },
      });

      expect(await findBlockingReferences(db, 'port', port.id)).toEqual([]);

      // The port must leave this test soft-deleted: the assertion above is
      // about a reference that is gone, not about the row itself.
      await db.port.update({
        where: { id: port.id },
        data: { deletedAt: new Date(), isActive: false },
      });
    });
  });
});

describe('the tenant leg of a composite foreign key', () => {
  /*
   * §4 rule 10 makes nearly every foreign key two columns wide:
   * `(tenant_id, customer_id) REFERENCES customer(tenant_id, id)`. Walking
   * `conkey` on its own turns one constraint into two edges, and the tenant_id
   * one asks `WHERE tenant_id = <the row's id>` — a comparison between two
   * unrelated numbers that is usually false and occasionally, catastrophically,
   * true.
   *
   * It is true exactly when a record's id equals its tenant's, which is what a
   * brand-new server produces: tenant 1, and the first customer anyone types in
   * is customer 1. Delete on that row would have been refused, citing every
   * contact in the workspace — none of which belonged to it.
   */
  it('does not mistake a row whose id equals the tenant id for a used one', async () => {
    // The collision cannot be arranged through the sequence, so insert the id.
    await owner.$executeRawUnsafe(
      `INSERT INTO customer
         (tenant_id, id, code, name, country, customer_type, business_area, industry_sector_id,
          updated_at)
       VALUES ($1, $1, 'REF-SELF', 'Same Id As Tenant', 'Bangladesh', 'IMPORTER', 'BOTH', $2,
               now())`,
      tenantId,
      sectorId,
    );

    await withTenant(tenantId, async (db) => {
      // A second customer, with a contact of its own. Nothing here touches the
      // row above, but both children carry the same tenant_id it has for an id.
      const other = await db.customer.create({
        data: {
          tenantId,
          code: 'REF-OTHER',
          name: 'Unrelated Customer',
          country: 'Bangladesh',
          customerType: 'IMPORTER',
          businessArea: 'BOTH',
          industrySectorId: sectorId,
        },
        select: { id: true },
      });
      await db.customerPic.create({
        data: { tenantId, code: 'REF-PIC', customerId: other.id, name: 'Someone Else' },
      });

      expect(await findBlockingReferences(db, 'customer', tenantId)).toEqual([]);
    });
  });

  it('still finds the reference that is real', async () => {
    await withTenant(tenantId, async (db) => {
      const self = await db.customer.findFirstOrThrow({
        where: { code: 'REF-SELF' },
        select: { id: true },
      });

      // A user account pointing at the customer — not an owned child, so it
      // blocks. The edge is composite too, which is the whole point: the fix
      // must drop the tenant leg without dropping the constraint.
      await db.user.create({
        data: {
          tenantId,
          code: 'REF-USR',
          username: 'ref-customer-user',
          email: 'ref-customer@ref.test',
          passwordHash: 'x',
          customerId: self.id,
        },
      });

      const blocked = await findBlockingReferences(db, 'customer', self.id);
      expect(blocked.map((b) => b.table)).toContain('user');
      expect(blocked.find((b) => b.table === 'user')?.count).toBe(1);
    });
  });
});
