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

let tenantId: bigint;

beforeAll(async () => {
  const tenant = await owner.tenant.findFirst({ select: { id: true } });
  if (tenant === null) throw new Error('seed a tenant first');
  tenantId = tenant.id;
});

afterAll(async () => {
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
      const carrier = await db.carrier.findFirst({
        where: { tenantId, deletedAt: null },
        select: { id: true },
      });
      if (carrier === null) throw new Error('needs a carrier');

      await db.carrierServicePort.create({
        data: {
          tenantId,
          code: `ZZSP-${Date.now().toString().slice(-6)}`,
          carrierId: carrier.id,
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

      // Tidy up: this suite runs against the shared development database.
      await db.port.update({
        where: { id: port.id },
        data: { deletedAt: new Date(), isActive: false },
      });
    });
  });
});
