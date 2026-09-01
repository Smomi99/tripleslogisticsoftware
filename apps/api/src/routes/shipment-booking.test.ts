import { PrismaPg } from '@prisma/adapter-pg';
import { computeCargoMeasures, sumCargoTotals } from '@ff/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Shipment Booking (docs/MODULE_BOOKING_CARGO.md §6.1) — phase B.
 *
 * The phase is done when "a booking saves with grouped POs", and that sentence
 * hides the interesting part: the screen has no PO row, only a PO column, so
 * the route is what turns a flat grid into §2.2's PO -> Item -> SKU hierarchy.
 * Most of what follows is about that reconciliation holding under editing.
 *
 * The other thing worth pinning is that the browser and the database agree.
 * §2.3 puts the arithmetic in Postgres; §6.1 needs it previewed live while
 * somebody types. Both read one function in @ff/shared, and the last test here
 * is the one that would catch them drifting apart.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'book-alpha';

let tenantId: bigint;
let token: string;
/** Everything on the booking except SUBMIT. */
let tokenNoSubmit: string;
let quotationId: bigint;
let carrierId: bigint;
let portId: bigint;

function as(t: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
    patch: (path: string) =>
      request(app).patch(path).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
  };
}

interface LineInput {
  poNo: string;
  itemCode: string;
  ctnQty: number;
  id?: string;
  sku?: string;
  grossWeightKg?: string;
  netWeightKg?: string;
  cartonLengthCm?: string;
  cartonWidthCm?: string;
  cartonHeightCm?: string;
  dc?: string;
}

function body(lines: LineInput[], extra: Record<string, unknown> = {}) {
  return {
    quotationId: quotationId.toString(),
    carrierId: carrierId.toString(),
    polId: portId.toString(),
    podId: portId.toString(),
    exporterName: 'Alpha Garments Ltd',
    cargoLines: lines,
    ...extra,
  };
}

interface BookingBody {
  data: {
    id: string;
    code: string;
    status: string;
    submittedAt: string | null;
    pos: { id: string; poNo: string }[];
    cargoLines: {
      id: string;
      poNo: string;
      itemCode: string;
      ctnQty: number;
      volumeCbm: string | null;
      chargeableWtKg: string | null;
      grossWeightKg: string | null;
      cartonLengthCm: string | null;
      cartonWidthCm: string | null;
      cartonHeightCm: string | null;
    }[];
  };
}

async function createBooking(lines: LineInput[]): Promise<BookingBody['data']> {
  const res = await as(token).post('/api/tenant/cs/bookings').send(body(lines));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as BookingBody).data;
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    'shipment_cargo_line',
    'shipment_commodity',
    'shipment_po',
    'shipment',
    'quotation_commodity',
    'quotation',
    'inquiry_commodity',
    'inquiry',
    // customer before industry_sector, commodity_item before it too — both
    // point at the sector, and this list is a delete order, not a table list.
    'customer',
    'commodity_item',
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
    data: { name: 'Booking Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const admin = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-book',
      username: 'admin-book',
      email: 'admin@book.test',
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: admin.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const limited = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-book-ltd',
      username: 'limited-book',
      email: 'limited@book.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenNoSubmit = await signAccessToken({
    sub: limited.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [
      'CUSTOMER_SERVICE.CARGO_BOOKING.VIEW',
      'CUSTOMER_SERVICE.CARGO_BOOKING.CREATE',
      'CUSTOMER_SERVICE.CARGO_BOOKING.EDIT',
    ],
    tokenVersion: 0,
  });

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'BK-SEC', name: 'Garments' },
    select: { id: true },
  });
  const commodity = await owner.commodityItem.create({
    data: { tenantId, code: 'BK-CIT', industrySectorId: sector.id, name: 'Knit Tops' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'BK-CUS',
      name: 'Booking Customer',
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
      data: { tenantId, code: 'BK-CAR', name: 'Booking Line', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  portId = (
    await owner.port.create({
      data: {
        tenantId,
        code: 'BK-PORT',
        name: 'Booking Port',
        portCode: 'ZZBKG',
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
      code: 'BK-INQ-1',
      seriesYear: 2026,
      inquiryDate: new Date('2026-09-02'),
      sourceId: source.id,
      shipmentType: 'AIR',
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
        code: 'BK-QTN-1',
        seriesYear: 2026,
        inquiryId: inquiry.id,
        quotationDate: new Date('2026-09-02'),
        customerId: customer.id,
        shipmentType: 'AIR',
        movementType: 'OUTBOUND',
        polId: portId,
        podId: portId,
        carrierId,
        localCurrencyId: currency.id,
        conversionRate: '122.0000',
        commodities: {
          create: [{ commodityItemId: commodity.id, commodityName: 'Knit Tops', hsCode: '6109.10' }],
        },
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('creating a booking', () => {
  it('groups a flat grid into POs (§2.2)', async () => {
    /*
     * The phase's own definition of done. The screen sent five rows carrying a
     * PO NUMBER each; the database has to end up with two POs and five lines
     * hung under the right ones.
     */
    const booking = await createBooking([
      { poNo: 'PO-1001', itemCode: 'ITEM-A', sku: 'SKU-A1', ctnQty: 10 },
      { poNo: 'PO-1001', itemCode: 'ITEM-A', sku: 'SKU-A2', ctnQty: 20 },
      { poNo: 'PO-1001', itemCode: 'ITEM-B', sku: 'SKU-B1', ctnQty: 5 },
      { poNo: 'PO-2002', itemCode: 'ITEM-C', sku: 'SKU-C1', ctnQty: 8 },
      { poNo: 'PO-2002', itemCode: 'ITEM-C', sku: 'SKU-C2', ctnQty: 2 },
    ]);

    expect(booking.pos.map((p) => p.poNo)).toEqual(['PO-1001', 'PO-2002']);
    expect(booking.cargoLines).toHaveLength(5);

    const byPo = new Map<string, number>();
    for (const line of booking.cargoLines) {
      byPo.set(line.poNo, (byPo.get(line.poNo) ?? 0) + line.ctnQty);
    }
    expect(byPo.get('PO-1001')).toBe(35);
    expect(byPo.get('PO-2002')).toBe(10);
  });

  it('numbers it BKG-<year>-000001 and starts at BOOKING_RECEIVED', async () => {
    const booking = await createBooking([{ poNo: 'PO-N1', itemCode: 'ITEM', ctnQty: 1 }]);
    expect(booking.code).toMatch(/^BKG-\d{4}-\d{6}$/);
    expect(booking.status).toBe('BOOKING_RECEIVED');
    // §7 splits CREATE from SUBMIT, so a fresh booking is not yet submitted.
    expect(booking.submittedAt).toBeNull();
  });

  it('lets one quotation raise several bookings (§5.2 rule 1)', async () => {
    // One quotation, many exporters, many bookings. The absence of a unique
    // constraint on quotation_id is a decision, so it gets a test.
    const first = await createBooking([{ poNo: 'PO-X1', itemCode: 'ITEM', ctnQty: 1 }]);
    const second = await createBooking([{ poNo: 'PO-X2', itemCode: 'ITEM', ctnQty: 1 }]);
    expect(second.id).not.toBe(first.id);
    expect(second.code).not.toBe(first.code);
  });

  it('inherits the quotation header and its commodities (§5.2 rule 2)', async () => {
    const booking = await createBooking([{ poNo: 'PO-H1', itemCode: 'ITEM', ctnQty: 1 }]);
    const res = await as(token).get(`/api/tenant/cs/bookings/${booking.id}`);
    const full = (res.body as { data: Record<string, unknown> }).data;

    expect(full.shipmentType).toBe('AIR');
    expect(full.quotationCode).toBe('BK-QTN-1');
    expect(full.customerName).toBe('Booking Customer');
    // Read through the quotation, since §4.1's column list has no movement_type.
    expect(full.movementType).toBe('OUTBOUND');
    expect((full.commodities as { commodityName: string }[])[0]?.commodityName).toBe('Knit Tops');
  });

  it('prefills the form from the quotation without writing anything', async () => {
    const res = await as(token).get(`/api/tenant/cs/bookings/prefill/${quotationId}`);
    expect(res.status).toBe(200);
    const prefill = (res.body as { data: Record<string, unknown> }).data;
    expect(prefill.quotationCode).toBe('BK-QTN-1');
    expect(prefill.shipmentType).toBe('AIR');
    expect(prefill.carrierId).toBe(carrierId.toString());
  });
});

describe('editing the grid', () => {
  it('moves a line to a different PO and retires the one left empty', async () => {
    const booking = await createBooking([
      { poNo: 'PO-MOVE-A', itemCode: 'ITEM', ctnQty: 4 },
      { poNo: 'PO-MOVE-B', itemCode: 'ITEM', ctnQty: 6 },
    ]);
    const lineOnA = booking.cargoLines.find((l) => l.poNo === 'PO-MOVE-A')!;
    const lineOnB = booking.cargoLines.find((l) => l.poNo === 'PO-MOVE-B')!;

    // Both lines now sit under B. A has nothing left on it.
    const res = await as(token)
      .patch(`/api/tenant/cs/bookings/${booking.id}`)
      .send({
        carrierId: carrierId.toString(),
        polId: portId.toString(),
        podId: portId.toString(),
        cargoLines: [
          { id: lineOnA.id, poNo: 'PO-MOVE-B', itemCode: 'ITEM', ctnQty: 4 },
          { id: lineOnB.id, poNo: 'PO-MOVE-B', itemCode: 'ITEM', ctnQty: 6 },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const updated = (res.body as BookingBody).data;
    expect(updated.pos.map((p) => p.poNo)).toEqual(['PO-MOVE-B']);
    expect(updated.cargoLines).toHaveLength(2);
    expect(updated.cargoLines.every((l) => l.poNo === 'PO-MOVE-B')).toBe(true);
  });

  it('drops a line the grid no longer sends, without hard-deleting it', async () => {
    const booking = await createBooking([
      { poNo: 'PO-DROP', itemCode: 'KEEP', ctnQty: 1 },
      { poNo: 'PO-DROP', itemCode: 'GOING', ctnQty: 2 },
    ]);
    const keep = booking.cargoLines.find((l) => l.itemCode === 'KEEP')!;
    const going = booking.cargoLines.find((l) => l.itemCode === 'GOING')!;

    const res = await as(token)
      .patch(`/api/tenant/cs/bookings/${booking.id}`)
      .send({
        carrierId: carrierId.toString(),
        polId: portId.toString(),
        podId: portId.toString(),
        cargoLines: [{ id: keep.id, poNo: 'PO-DROP', itemCode: 'KEEP', ctnQty: 1 }],
      });
    expect(res.status).toBe(200);
    expect((res.body as BookingBody).data.cargoLines).toHaveLength(1);

    // §4 rule 3: soft, so the row and its audit trail survive.
    const rows = await owner.$queryRaw<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM shipment_cargo_line WHERE id = ${BigInt(going.id)}`;
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('reuses a PO number that comes back after being emptied', async () => {
    // The partial unique index earns its keep here: PO-REVIVE is retired by the
    // first edit and typed again by the second.
    const booking = await createBooking([{ poNo: 'PO-REVIVE', itemCode: 'ITEM', ctnQty: 1 }]);
    const patch = (lines: LineInput[]) =>
      as(token)
        .patch(`/api/tenant/cs/bookings/${booking.id}`)
        .send({
          carrierId: carrierId.toString(),
          polId: portId.toString(),
          podId: portId.toString(),
          cargoLines: lines,
        });

    await patch([{ poNo: 'PO-OTHER', itemCode: 'ITEM', ctnQty: 1 }]);
    const res = await patch([{ poNo: 'PO-REVIVE', itemCode: 'ITEM', ctnQty: 3 }]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as BookingBody).data.pos.map((p) => p.poNo)).toEqual(['PO-REVIVE']);
  });

  it('refuses a cargo line belonging to another booking', async () => {
    const mine = await createBooking([{ poNo: 'PO-MINE', itemCode: 'ITEM', ctnQty: 1 }]);
    const theirs = await createBooking([{ poNo: 'PO-THEIRS', itemCode: 'ITEM', ctnQty: 1 }]);

    const res = await as(token)
      .patch(`/api/tenant/cs/bookings/${mine.id}`)
      .send({
        carrierId: carrierId.toString(),
        polId: portId.toString(),
        podId: portId.toString(),
        cargoLines: [
          { id: theirs.cargoLines[0]!.id, poNo: 'PO-MINE', itemCode: 'ITEM', ctnQty: 1 },
        ],
      });
    expect(res.status).toBe(404);
  });
});

describe('submitting', () => {
  it('refuses a booking with no cargo on it (§5.2 rule 4)', async () => {
    const booking = await createBooking([]);
    const res = await as(token).post(`/api/tenant/cs/bookings/${booking.id}/submit`);
    expect(res.status).toBe(422);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/cargo line/i);
  });

  it('records who submitted it and when', async () => {
    const booking = await createBooking([{ poNo: 'PO-SUB', itemCode: 'ITEM', ctnQty: 12 }]);
    const res = await as(token).post(`/api/tenant/cs/bookings/${booking.id}/submit`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as BookingBody).data.submittedAt).not.toBeNull();

    // Twice is a mistake, not an idempotent no-op.
    const again = await as(token).post(`/api/tenant/cs/bookings/${booking.id}/submit`);
    expect(again.status).toBe(409);
  });

  it('refuses a user who may edit the booking but not submit it', async () => {
    const booking = await createBooking([{ poNo: 'PO-GATE', itemCode: 'ITEM', ctnQty: 1 }]);
    const res = await as(tokenNoSubmit).post(`/api/tenant/cs/bookings/${booking.id}/submit`);
    expect(res.status).toBe(403);
  });

  it('stops editing once the booking has moved past BOOKING_RECEIVED', async () => {
    // §5.1: a schedule in front of the customer is somebody relying on these
    // figures, and §2.4's whole point is that each stage keeps its own.
    const booking = await createBooking([{ poNo: 'PO-LOCK', itemCode: 'ITEM', ctnQty: 1 }]);
    await owner.shipment.update({
      where: { id: BigInt(booking.id) },
      data: { status: 'VESSEL_PROPOSED' },
    });

    const res = await as(token)
      .patch(`/api/tenant/cs/bookings/${booking.id}`)
      .send({
        carrierId: carrierId.toString(),
        polId: portId.toString(),
        podId: portId.toString(),
        cargoLines: [{ poNo: 'PO-LOCK', itemCode: 'CHANGED', ctnQty: 9 }],
      });
    expect(res.status).toBe(409);
  });
});

describe('the browser and the database agree (§2.3)', () => {
  it('previews exactly what Postgres stores', async () => {
    /*
     * §6.1 wants CBM and chargeable weight updating live as somebody types, and
     * §2.3 forbids that maths living in two places. It lives in @ff/shared and
     * in a generated column, so this is the test that would catch them drifting
     * — the same inputs through both paths, compared digit for digit.
     */
    const cartons: LineInput[] = [
      // Light and bulky: the volume bills.
      {
        poNo: 'PO-MATH',
        itemCode: 'LIGHT',
        ctnQty: 100,
        grossWeightKg: '900',
        cartonLengthCm: '60',
        cartonWidthCm: '40',
        cartonHeightCm: '30',
      },
      // Dense: the weight bills.
      {
        poNo: 'PO-MATH',
        itemCode: 'DENSE',
        ctnQty: 100,
        grossWeightKg: '1500',
        cartonLengthCm: '60',
        cartonWidthCm: '40',
        cartonHeightCm: '30',
      },
      // Fractional centimetres, where rounding could part them.
      {
        poNo: 'PO-MATH',
        itemCode: 'ODD',
        ctnQty: 10,
        grossWeightKg: '50',
        cartonLengthCm: '45.5',
        cartonWidthCm: '32.25',
        cartonHeightCm: '28.75',
      },
      // Weighed but never measured.
      { poNo: 'PO-MATH', itemCode: 'UNMEASURED', ctnQty: 50, grossWeightKg: '500' },
    ];

    const booking = await createBooking(cartons);

    for (const line of booking.cargoLines) {
      const sent = cartons.find((c) => c.itemCode === line.itemCode)!;
      const preview = computeCargoMeasures({
        ctnQty: sent.ctnQty,
        grossWeightKg: sent.grossWeightKg === undefined ? null : Number(sent.grossWeightKg),
        cartonLengthCm: sent.cartonLengthCm === undefined ? null : Number(sent.cartonLengthCm),
        cartonWidthCm: sent.cartonWidthCm === undefined ? null : Number(sent.cartonWidthCm),
        cartonHeightCm: sent.cartonHeightCm === undefined ? null : Number(sent.cartonHeightCm),
      });

      const storedCbm = line.volumeCbm === null ? null : Number(line.volumeCbm);
      const storedChargeable =
        line.chargeableWtKg === null ? null : Number(line.chargeableWtKg);

      expect(storedCbm, `${line.itemCode} cbm`).toEqual(preview.volumeCbm);
      expect(storedChargeable, `${line.itemCode} chargeable`).toEqual(preview.chargeableWtKg);
    }

    // And the figures themselves are the ones a freight desk would expect.
    const light = booking.cargoLines.find((l) => l.itemCode === 'LIGHT')!;
    expect(Number(light.volumeCbm)).toBe(7.2);
    expect(Number(light.chargeableWtKg)).toBe(1202.4);
    const dense = booking.cargoLines.find((l) => l.itemCode === 'DENSE')!;
    expect(Number(dense.chargeableWtKg)).toBe(1500);
  });

  it('adds the grand total the same way the screen does', async () => {
    const booking = await createBooking([
      {
        poNo: 'PO-TOT',
        itemCode: 'A',
        ctnQty: 100,
        grossWeightKg: '900',
        cartonLengthCm: '60',
        cartonWidthCm: '40',
        cartonHeightCm: '30',
      },
      {
        poNo: 'PO-TOT',
        itemCode: 'B',
        ctnQty: 50,
        grossWeightKg: '450',
        cartonLengthCm: '60',
        cartonWidthCm: '40',
        cartonHeightCm: '30',
      },
    ]);

    const totals = sumCargoTotals(
      booking.cargoLines.map((l) => ({
        ctnQty: l.ctnQty,
        pcsQty: null,
        netWeightKg: null,
        grossWeightKg: l.grossWeightKg === null ? null : Number(l.grossWeightKg),
        cartonLengthCm: l.cartonLengthCm === null ? null : Number(l.cartonLengthCm),
        cartonWidthCm: l.cartonWidthCm === null ? null : Number(l.cartonWidthCm),
        cartonHeightCm: l.cartonHeightCm === null ? null : Number(l.cartonHeightCm),
      })),
    );

    expect(totals.ctnQty).toBe(150);
    expect(totals.volumeCbm).toBe(10.8);

    // The total is the sum of what the database stored, not a second opinion.
    const stored = booking.cargoLines.reduce((sum, l) => sum + Number(l.volumeCbm ?? 0), 0);
    expect(totals.volumeCbm).toBeCloseTo(stored, 4);
  });
});
