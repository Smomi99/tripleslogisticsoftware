import { PrismaPg } from '@prisma/adapter-pg';
import {
  canTransition,
  SHIPMENT_STATUSES,
  SHIPMENT_TRANSITIONS,
  shipmentAction,
  type ShipmentStatus,
} from '@ff/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { HttpError } from './http-error';
import { transitionShipment } from './shipment-status';
import { runWithActor } from './tenancy';
import { withTenant } from './tenant-client';

/**
 * ShipmentStatusService — docs/MODULE_BOOKING_CARGO.md §5.1, phase C.
 *
 * §8 asks for tests here by name and gives the reason: this is the state
 * machine, one of the three places "where a silent error becomes a billing
 * dispute rather than a visible bug".
 *
 * The table below is transcribed from §5.1 independently of the constant the
 * code reads. That is the point — a test that imported the same table and
 * checked it against itself would pass no matter what either said. This one
 * fails if the constant drifts from the spec.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG = 'status-alpha';
let tenantId: bigint;
let userId: bigint;
let quotationId: bigint;
let carrierId: bigint;
let portId: bigint;
let seq = 0;

/** §5.1's table, typed out from the spec rather than imported. */
const SPEC: Record<ShipmentStatus, ShipmentStatus[]> = {
  BOOKING_RECEIVED: ['VESSEL_PROPOSED'],
  VESSEL_PROPOSED: ['APPROVED_FOR_SHIPMENT', 'REJECTED'],
  REJECTED: ['VESSEL_PROPOSED'],
  APPROVED_FOR_SHIPMENT: ['SO_ISSUED', 'SO_SKIPPED'],
  SO_ISSUED: ['PART_RECEIVED', 'CARGO_RECEIVED'],
  SO_SKIPPED: ['PART_RECEIVED', 'CARGO_RECEIVED'],
  PART_RECEIVED: ['PART_RECEIVED', 'CARGO_RECEIVED', 'SHORT_CLOSED'],
  CARGO_RECEIVED: [],
  SHORT_CLOSED: [],
  CANCELLED: [],
};

/** A booking sitting in the given state, ready to be moved. */
async function makeShipment(status: ShipmentStatus): Promise<bigint> {
  seq += 1;
  const row = await owner.shipment.create({
    data: {
      tenantId,
      code: `BKG-2026-${String(seq).padStart(6, '0')}`,
      seriesYear: 2026,
      quotationId,
      shipmentType: 'SEA',
      customerId: (await owner.quotation.findFirstOrThrow({
        where: { id: quotationId },
        select: { customerId: true },
      })).customerId,
      carrierId,
      polId: portId,
      podId: portId,
      status,
      // CANCELLED carries a CHECK: it cannot exist without its reason.
      ...(status === 'CANCELLED'
        ? { cancelledAt: new Date(), cancelledBy: userId, cancelReason: 'seeded' }
        : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** Attempts a move and reports what happened. */
async function move(
  id: bigint,
  to: ShipmentStatus,
  reason?: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    // The actor context the authenticate middleware would have set. Without it
    // withTenant leaves app.user_id empty and the trail records SYSTEM, which
    // is right for a migration and wrong for a person cancelling a booking.
    await runWithActor({ userId }, () =>
      withTenant(tenantId, (db) =>
        transitionShipment(db, { shipmentId: id, to, userId, reason }),
      ),
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof HttpError) {
      return { ok: false, status: error.status, message: error.message };
    }
    throw error;
  }
}

async function statusOf(id: bigint): Promise<ShipmentStatus> {
  const row = await owner.shipment.findFirstOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    'shipment_cargo_line',
    'shipment_commodity',
    'shipment_po',
    'shipment',
    'quotation',
    'inquiry',
    'customer',
    'industry_sector',
    'carrier',
    'port',
    '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Status Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  userId = (
    await owner.user.create({
      data: {
        tenantId,
        code: 'USR-status',
        username: 'admin-status',
        email: 'admin@status.test',
        passwordHash: 'x',
        isSuperadmin: true,
      },
      select: { id: true },
    })
  ).id;

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'ST-SEC', name: 'Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'ST-CUS',
      name: 'Status Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'ST-CAR', name: 'Status Line', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  portId = (
    await owner.port.create({
      data: {
        tenantId,
        code: 'ST-PORT',
        name: 'Status Port',
        portCode: 'ZZSTA',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    })
  ).id;

  const source = await owner.inquirySource.findFirstOrThrow({ select: { id: true } });
  const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: 'ST-INQ-1',
      seriesYear: 2026,
      inquiryDate: new Date('2026-09-02'),
      sourceId: source.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      polId: portId,
      podId: portId,
      status: 'OPEN',
    },
    select: { id: true },
  });
  quotationId = (
    await owner.quotation.create({
      data: {
        tenantId,
        code: 'ST-QTN-1',
        seriesYear: 2026,
        inquiryId: inquiry.id,
        quotationDate: new Date('2026-09-02'),
        customerId: customer.id,
        shipmentType: 'SEA',
        movementType: 'OUTBOUND',
        polId: portId,
        podId: portId,
        carrierId,
        localCurrencyId: currency.id,
        conversionRate: '122.0000',
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the transition table matches §5.1', () => {
  it('allows every move the spec lists, and CANCELLED from everywhere else', () => {
    for (const from of SHIPMENT_STATUSES) {
      const expected = new Set<ShipmentStatus>(SPEC[from]);
      // §5.1's last line: "any -> CANCELLED". Every state but CANCELLED itself.
      if (from !== 'CANCELLED') expected.add('CANCELLED');

      expect([...SHIPMENT_TRANSITIONS[from]].sort(), `from ${from}`).toEqual(
        [...expected].sort(),
      );
    }
  });

  it('refuses every move the spec does not list', () => {
    // The complement of the table, checked exhaustively: 100 pairs, and the
    // ones that should be refused are refused.
    for (const from of SHIPMENT_STATUSES) {
      for (const to of SHIPMENT_STATUSES) {
        const allowed = SPEC[from].includes(to) || (to === 'CANCELLED' && from !== 'CANCELLED');
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed);
      }
    }
  });

  it('lets a part-received booking receive again', () => {
    // §5.5 rule 4: a booking may have several receipts. The only self-loop.
    expect(canTransition('PART_RECEIVED', 'PART_RECEIVED')).toBe(true);
    for (const status of SHIPMENT_STATUSES) {
      if (status === 'PART_RECEIVED') continue;
      expect(canTransition(status, status), `${status} -> itself`).toBe(false);
    }
  });

  it('leaves no way out of CANCELLED', () => {
    expect(SHIPMENT_TRANSITIONS.CANCELLED).toEqual([]);
  });
});

describe('moving a real booking', () => {
  it('walks the whole happy path', async () => {
    const id = await makeShipment('BOOKING_RECEIVED');

    for (const step of [
      'VESSEL_PROPOSED',
      'APPROVED_FOR_SHIPMENT',
      'SO_ISSUED',
      'PART_RECEIVED',
      'CARGO_RECEIVED',
    ] as const) {
      const result = await move(id, step);
      expect(result.ok, `moving to ${step}`).toBe(true);
      expect(await statusOf(id)).toBe(step);
    }
  });

  it('takes the rejection loop and comes back (§4.2)', async () => {
    const id = await makeShipment('VESSEL_PROPOSED');
    expect((await move(id, 'REJECTED')).ok).toBe(true);
    // C/S proposes a new version; the rejected schedule is kept, not edited.
    expect((await move(id, 'VESSEL_PROPOSED')).ok).toBe(true);
    expect(await statusOf(id)).toBe('VESSEL_PROPOSED');
  });

  it('takes the inbound path that skips the shipping order (§5.4 rule 3)', async () => {
    const id = await makeShipment('APPROVED_FOR_SHIPMENT');
    expect((await move(id, 'SO_SKIPPED')).ok).toBe(true);
    expect((await move(id, 'CARGO_RECEIVED')).ok).toBe(true);
  });

  it('refuses an illegal move and leaves the booking where it was', async () => {
    const id = await makeShipment('BOOKING_RECEIVED');
    const result = await move(id, 'SO_ISSUED');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(await statusOf(id)).toBe('BOOKING_RECEIVED');
  });

  it('says what the booking can actually do instead', async () => {
    /*
     * §5.1: "Reject anything not on this list with a clear error." A 409 that
     * only says no sends an operator to a developer; one that names the next
     * legal state sends them to the right button.
     */
    const id = await makeShipment('REJECTED');
    const result = await move(id, 'CARGO_RECEIVED');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/BKG-2026-/);
    expect(result.message).toMatch(/Rejected/);
    expect(result.message).toMatch(/Cargo received/);
    expect(result.message).toMatch(/Vessel proposed/);
  });

  it('cannot resurrect a cancelled booking', async () => {
    const id = await makeShipment('CANCELLED');
    const result = await move(id, 'VESSEL_PROPOSED');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/Nothing follows it/i);
  });
});

describe('the mandatory reason', () => {
  it('refuses to cancel without one (§5.1)', async () => {
    const id = await makeShipment('BOOKING_RECEIVED');
    const result = await move(id, 'CANCELLED');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(await statusOf(id)).toBe('BOOKING_RECEIVED');
  });

  it('refuses whitespace as a reason', async () => {
    const id = await makeShipment('BOOKING_RECEIVED');
    expect((await move(id, 'CANCELLED', '   ')).ok).toBe(false);
    expect(await statusOf(id)).toBe('BOOKING_RECEIVED');
  });

  it('records who cancelled it, when, and why', async () => {
    const id = await makeShipment('SO_ISSUED');
    expect((await move(id, 'CANCELLED', 'Customer withdrew the order.')).ok).toBe(true);

    const row = await owner.shipment.findFirstOrThrow({
      where: { id },
      select: { status: true, cancelledAt: true, cancelledBy: true, cancelReason: true },
    });
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelReason).toBe('Customer withdrew the order.');
    expect(row.cancelledBy).toBe(userId);
    expect(row.cancelledAt).not.toBeNull();
  });

  it('is enforced by the database as well as the service', async () => {
    // The service is layer one. A CHECK constraint is what catches the route
    // written next year that sets the status directly.
    const id = await makeShipment('BOOKING_RECEIVED');
    await expect(
      owner.shipment.update({ where: { id }, data: { status: 'CANCELLED' } }),
    ).rejects.toThrow();
  });
});

describe('the audit trail (§5.1)', () => {
  it('records the actor, the time, and both states', async () => {
    /*
     * §5.1: "Every transition writes to audit_log with actor and timestamp."
     * Nothing in the service writes that row — app_audit_row() does, off the
     * UPDATE. This asserts the requirement is met, not how.
     */
    const id = await makeShipment('BOOKING_RECEIVED');
    await move(id, 'VESSEL_PROPOSED');

    const rows = await owner.$queryRaw<
      {
        action: string;
        changed_by: bigint | null;
        created_at: Date;
        old_status: string | null;
        new_status: string | null;
      }[]
    >`
      SELECT action, changed_by, created_at,
             old_values ->> 'status' AS old_status,
             new_values ->> 'status' AS new_status
        FROM audit_log
       WHERE table_name = 'shipment' AND record_id = ${id}
       ORDER BY id DESC LIMIT 1`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.old_status).toBe('BOOKING_RECEIVED');
    expect(rows[0]?.new_status).toBe('VESSEL_PROPOSED');
    expect(rows[0]?.changed_by).toBe(userId);
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
  });

  it('writes nothing when the move was refused', async () => {
    const id = await makeShipment('CARGO_RECEIVED');
    const before = await owner.auditLog.count({
      where: { tableName: 'shipment', recordId: id },
    });

    await move(id, 'BOOKING_RECEIVED');

    const after = await owner.auditLog.count({
      where: { tableName: 'shipment', recordId: id },
    });
    expect(after).toBe(before);
  });
});

describe('the Action button is derived, never stored (§5.1)', () => {
  it('names the next thing to do in every state', () => {
    const labels = SHIPMENT_STATUSES.map((s) => shipmentAction(s, 'SEA').label);
    // Every status has one, and none of them is empty.
    expect(labels.filter((l) => l.trim() !== '')).toHaveLength(SHIPMENT_STATUSES.length);
    expect(shipmentAction('BOOKING_RECEIVED', 'SEA').label).toBe('Vsl Booking');
    expect(shipmentAction('APPROVED_FOR_SHIPMENT', 'SEA').label).toBe('Issue S/O');
  });

  it('says Flight where the shipment flies (§3)', () => {
    expect(shipmentAction('BOOKING_RECEIVED', 'AIR').label).toBe('Flight Booking');
    expect(shipmentAction('REJECTED', 'AIR').label).toMatch(/Flight/);
    // ...and only where the word actually differs.
    expect(shipmentAction('APPROVED_FOR_SHIPMENT', 'AIR').label).toBe(
      shipmentAction('APPROVED_FOR_SHIPMENT', 'SEA').label,
    );
  });

  it('offers no action while it is the customer’s turn', () => {
    // §6.2 draws "Awaiting Shipment Approval" here — a statement, not a button.
    expect(shipmentAction('VESSEL_PROPOSED', 'SEA')).toEqual({
      label: 'Awaiting Shipment Approval',
      permission: null,
    });
  });
});
