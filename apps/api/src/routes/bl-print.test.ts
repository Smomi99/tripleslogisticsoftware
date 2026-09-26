import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * BL Print (Menu K7), end to end through HTTP — docs/MODULE_DOCUMENTATION.md §13.
 *
 * Two workspaces are built from nothing, so every assertion about one is also a
 * check that the other sees none of it (CLAUDE.md §7A rule 4). Each booking
 * starts where BL Print's input really comes from — an advise that has gone to
 * the customer — and its draft is made, sent and approved through the BL Draft
 * routes rather than inserted, so the seam between the two screens is tested,
 * not assumed:
 *
 *   advise SENT -> Make BL draft -> (Save & Send) -> Approve
 *     -> BL Print: Issue BL -> Print originals / copy -> (Cancel, redraft)
 */

// The outbox is mocked: a real queued letter would be picked up by a running
// dev server's worker and sent while this file cleans it away underneath it.
const queueMailSpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ queued: true })));
vi.mock('../lib/email-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email-queue')>();
  return { ...actual, queueMail: queueMailSpy };
});

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { extractPdfText } = await import('../lib/pdf-text');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'blp-alpha';
const SLUG_B = 'blp-beta';
const YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

interface Booking {
  id: bigint;
  code: string;
  houseBlNo: string;
}

interface World {
  slug: string;
  tenantId: bigint;
  superUserId: bigint;
  superUsername: string;
  superToken: string;
  /** BL Print's VIEW and nothing else. */
  viewerToken: string;
  /** May print, may not issue. */
  printerToken: string;
  /** No Documentation permission at all. */
  bareToken: string;
  polId: bigint;
  podId: bigint;
  /** The main line: a draft with no count, approved, then issued. */
  main: Booking;
  /** A draft sent to the customer before it was approved. */
  sentFirst: Booking;
  /** A draft sent for checking and then cancelled, never approved. */
  withdrawn: Booking;
}

let A: World;
let B: World;
let modeId: bigint;
let bdt: bigint;

function as(token: string, slug: string) {
  const wrap = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    get: (p: string) => wrap(request(app).get(`/api/tenant${p}`)),
    post: (p: string) => wrap(request(app).post(`/api/tenant${p}`)),
    patch: (p: string) => wrap(request(app).patch(`/api/tenant${p}`)),
  };
}

/** A PDF response, as bytes. */
function pdf(r: request.Test) {
  return r.buffer(true).parse((res, cb) => {
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => parts.push(c));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  });
}

/** pdfkit writes each page object uncompressed; "/Type /Pages" is the tree. */
const pageCount = (bytes: Buffer): number =>
  (bytes.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

async function statusOf(id: bigint): Promise<string> {
  return (await owner.shipment.findFirstOrThrow({ where: { id }, select: { status: true } }))
    .status;
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'bl_draft_container',
    'bl_draft',
    'shipment_advise',
    'shipment',
    'quotation',
    'inquiry',
    'customer_pic',
    'customer',
    'carrier',
    'port',
    'industry_sector',
    'email_log',
    'user',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh', currencyId: bdt },
    select: { id: true },
  });
  const tenantId = tenant.id;

  const user = async (code: string, isSuperadmin: boolean) =>
    owner.user.create({
      data: {
        tenantId,
        code,
        username: `${code.toLowerCase()}-${slug}`,
        email: `${code.toLowerCase()}@${slug}.test`,
        passwordHash: 'x',
        isSuperadmin,
      },
      select: { id: true, username: true },
    });
  const token = (id: bigint, isSuperadmin: boolean, permissions: string[]) =>
    signAccessToken({
      sub: id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin,
      permissions,
      tokenVersion: 0,
    });

  const superUser = await user(`USR-S${tag}`, true);
  const viewer = await user(`USR-V${tag}`, false);
  const printer = await user(`USR-P${tag}`, false);
  const bare = await user(`USR-B${tag}`, false);

  const sector = await owner.industrySector.create({
    data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CUS-${tag}`,
      name: `Shafidi Exports ${tag}`,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });

  const port = async (code: string, portName: string) =>
    (
      await owner.port.create({
        data: {
          tenantId,
          code: `PL-${tag}${code}`,
          name: portName,
          portCode: `Y${tag}${code}`,
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;
  const polId = await port('1', `Chittagong ${tag}`);
  const podId = await port('2', `Hamburg ${tag}`);

  const carrierType = await owner.carrierType.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CAR-${tag}`, name: `Ocean Line ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });

  const source = await owner.inquirySource.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `INQ-${YEAR}-8${tag}0001`,
      seriesYear: YEAR,
      inquiryDate: new Date(`${TODAY}T00:00:00Z`),
      sourceId: source.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      polId,
      podId,
    },
    select: { id: true },
  });
  const quotation = await owner.quotation.create({
    data: {
      tenantId,
      code: `QTN-${YEAR}-8${tag}0001`,
      seriesYear: YEAR,
      inquiryId: inquiry.id,
      quotationDate: new Date(`${TODAY}T00:00:00Z`),
      customerId: customer.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      polId,
      podId,
      carrierId: carrier.id,
      localCurrencyId: bdt,
      conversionRate: '1',
      status: 'ACCEPTED',
    },
    select: { id: true },
  });

  /** A booking whose advise has gone to the customer — where a BL starts. */
  const advised = async (n: number): Promise<Booking> => {
    const code = `BKG-${YEAR}-8${tag}000${n}`;
    const shipment = await owner.shipment.create({
      data: {
        tenantId,
        code,
        seriesYear: YEAR,
        quotationId: quotation.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        carrierId: carrier.id,
        polId,
        podId,
        loadingType: 'FCL',
        exporterName: `Shafidi Exports ${tag}`,
        exporterAddress: '12 Jute Road, Dhaka',
        importerName: `Hamburg Import ${tag}`,
        importerAddress: '4 Hafenstrasse, Hamburg',
        status: 'ADVISED',
      },
      select: { id: true },
    });
    const houseBlNo = `HBL${tag}${YEAR}000${n}`;
    await owner.shipmentAdvise.create({
      data: {
        tenantId,
        code: `SA-${YEAR}-8${tag}000${n}`,
        seriesYear: YEAR,
        shipmentId: shipment.id,
        carrierId: carrier.id,
        transitType: 'DIRECT',
        polId,
        podId,
        houseBlNo,
        mblNo: `MBL-${tag}-${n}`,
        status: 'SENT',
        sentAt: new Date(),
        sentBy: superUser.id,
      },
    });
    return { id: shipment.id, code, houseBlNo };
  };

  return {
    slug,
    tenantId,
    superUserId: superUser.id,
    superUsername: superUser.username,
    superToken: await token(superUser.id, true, []),
    viewerToken: await token(viewer.id, false, ['DOCUMENTATION.BL_PRINT.VIEW']),
    printerToken: await token(printer.id, false, [
      'DOCUMENTATION.BL_PRINT.VIEW',
      'DOCUMENTATION.BL_PRINT.EXPORT_PDF',
    ]),
    bareToken: await token(bare.id, false, []),
    polId,
    podId,
    main: await advised(1),
    sentFirst: await advised(2),
    withdrawn: await advised(3),
  };
}

beforeAll(async () => {
  bdt = (
    await owner.currency.findFirstOrThrow({
      where: { tenantId: null, currency: { startsWith: 'BDT' } },
      select: { id: true },
    })
  ).id;
  modeId = (
    await owner.mode.findFirstOrThrow({
      where: { tenantId: null, deletedAt: null },
      select: { id: true },
    })
  ).id;

  await cleanup();
  A = await makeWorld('BL Print Alpha', SLUG_A, 'A');
  B = await makeWorld('BL Print Beta', SLUG_B, 'B');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const asA = () => as(A.superToken, SLUG_A);

/** `Make BL draft` — the staff form as the operator leaves it. */
async function makeDraft(world: World, booking: Booking, originalBlCount?: number): Promise<string> {
  const res = await as(world.superToken, world.slug)
    .post(`/documentation/bookings/${booking.id}/bl-draft`)
    .send({
      shipperText: 'Shafidi Exports\n12 Jute Road, Dhaka',
      consigneeText: 'Hamburg Import GmbH\n4 Hafenstrasse, Hamburg',
      notifyText: 'Same as consignee',
      preCarriageByModeId: modeId.toString(),
      placeOfReceipt: 'Dhaka CFS',
      polId: world.polId.toString(),
      podId: world.podId.toString(),
      ladenOnBoardDate: TODAY,
      ...(originalBlCount === undefined ? {} : { originalBlCount }),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.blNo).toBe(booking.houseBlNo);
  return res.body.data.id as string;
}

let mainDraftId: string;

describe('before approval', () => {
  it('keeps an unapproved draft off BL Print, and refuses to issue or print it', async () => {
    mainDraftId = await makeDraft(A, A.main);

    const list = await asA().get('/documentation/bl-print?view=TO_ISSUE&limit=100');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).not.toContain(A.main.id.toString());

    const issue = await asA().post(`/documentation/bookings/${A.main.id}/bl/issue`).send({});
    expect(issue.status).toBe(409);
    expect(issue.body.error.code).toBe('BL_NOT_APPROVED');

    const copy = await asA().get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=COPY`);
    expect(copy.status).toBe(409);
  });
});

describe('the approved bill on BL Print', () => {
  it('arrives in To issue once approved, saying the count is not set', async () => {
    const approved = await asA().post(`/documentation/bl-drafts/${mainDraftId}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await statusOf(A.main.id)).toBe('BL_DRAFTED');

    const list = await asA().get('/documentation/bl-print?view=TO_ISSUE&limit=100');
    expect(list.status).toBe(200);
    const row = list.body.data.find((r: { id: string }) => r.id === A.main.id.toString());
    expect(row).toBeDefined();
    expect(row.awaiting).toBe(true);
    expect(row.detail).toContain(`HBL ${A.main.houseBlNo}`);
    expect(row.detail).toContain('MBL MBL-A-1');
    expect(row.detail).toContain('number of originals not set');
    expect(list.body.meta.counts).toEqual({ TO_ISSUE: 1, ISSUED: 0 });
  });

  it('prints a non-negotiable copy now, and no original until it is issued', async () => {
    const copy = await pdf(asA().get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=COPY`));
    expect(copy.status).toBe(200);
    expect(copy.headers['content-type']).toMatch(/application\/pdf/);
    expect(pageCount(copy.body as Buffer)).toBe(1);
    const text = extractPdfText(copy.body as Buffer);
    expect(text).toContain(A.main.houseBlNo);
    expect(text).toContain('NON-NEGOTIABLE');
    expect(text).toContain('Not issued');
    expect(text).not.toContain('DRAFT');

    const original = await asA().get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=ORIGINAL`);
    expect(original.status).toBe(409);
    expect(original.body.error.code).toBe('BL_NOT_ISSUED');
  });

  it('asks how many originals when the approved draft left it empty', async () => {
    const res = await asA().post(`/documentation/bookings/${A.main.id}/bl/issue`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORIGINALS_REQUIRED');
    expect(res.body.error.fields.originalBlCount).toBeDefined();

    // Refused, so nothing moved.
    expect(await statusOf(A.main.id)).toBe('BL_DRAFTED');
    const row = await owner.blDraft.findFirstOrThrow({
      where: { id: BigInt(mainDraftId) },
      select: { issuedAt: true },
    });
    expect(row.issuedAt).toBeNull();
  });

  it('issues it: who, when and how many, and the booking moves to BL issued', async () => {
    const res = await asA()
      .post(`/documentation/bookings/${A.main.id}/bl/issue`)
      .send({ originalBlCount: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.issuedAt).not.toBeNull();
    expect(res.body.data.originalBlCount).toBe(2);
    expect(res.body.data.issuedByName).toBe(A.superUsername);

    expect(await statusOf(A.main.id)).toBe('BL_ISSUED');
    const row = await owner.blDraft.findFirstOrThrow({
      where: { id: BigInt(mainDraftId) },
      select: { issuedBy: true, originalBlCount: true },
    });
    expect(row.issuedBy).toBe(A.superUserId);
    expect(row.originalBlCount).toBe(2);

    // One-way: a second issue is refused, not repeated.
    const again = await asA()
      .post(`/documentation/bookings/${A.main.id}/bl/issue`)
      .send({ originalBlCount: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BL_ALREADY_ISSUED');
  });

  it('moves from To issue to Issued', async () => {
    const issued = await asA().get('/documentation/bl-print?view=ISSUED&limit=100');
    expect(issued.status).toBe(200);
    const row = issued.body.data.find((r: { id: string }) => r.id === A.main.id.toString());
    expect(row).toBeDefined();
    expect(row.status).toBe('BL_ISSUED');
    expect(row.awaiting).toBe(false);
    expect(row.detail).toMatch(/issued \d{4}-\d{2}-\d{2}, 2 originals/);
    expect(issued.body.meta.counts).toEqual({ TO_ISSUE: 0, ISSUED: 1 });
  });

  it('prints one page per original, each numbered, dated and unwatermarked', async () => {
    const res = await pdf(asA().get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=ORIGINAL`));
    expect(res.status).toBe(200);
    expect(pageCount(res.body as Buffer)).toBe(2);
    const text = extractPdfText(res.body as Buffer);
    expect(text).toContain('1 of 2');
    expect(text).toContain('2 of 2');
    expect(text).toContain('DATE OF ISSUE');
    expect(text).not.toContain('Not issued');
    expect(text).not.toContain('DRAFT');
    expect(text).not.toContain('NON-NEGOTIABLE');
    expect(res.headers['content-disposition']).toContain(`${A.main.houseBlNo}-originals.pdf`);
  });

  it('keeps the issued draft frozen, and the BL Draft list says it was issued', async () => {
    const late = await asA()
      .patch(`/documentation/bl-drafts/${mainDraftId}`)
      .send({
        shipperText: 'changed',
        consigneeText: 'changed',
        notifyText: 'changed',
        preCarriageByModeId: modeId.toString(),
        placeOfReceipt: 'Dhaka CFS',
        polId: A.polId.toString(),
        podId: A.podId.toString(),
      });
    expect(late.status).toBe(409);

    const drafted = await asA().get('/documentation/bl-drafts/worklist?view=DRAFTED&limit=100');
    expect(drafted.status).toBe(200);
    const row = drafted.body.data.find((r: { id: string }) => r.id === A.main.id.toString());
    expect(row.detail).toContain('BL issued');
  });

  it('puts the issued booking on the debit note queue, as ready (Menu F22)', async () => {
    const res = await asA().get('/accounts/awaiting-freight-inv?stage=READY&limit=100');
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.map((r: { shipmentId: string }) => r.shipmentId)).toContain(
      A.main.id.toString(),
    );
  });
});

describe('a draft that went to the customer before it was approved', () => {
  let draftId: string;

  it('can still be approved once they confirm it', async () => {
    draftId = await makeDraft(A, A.sentFirst, 3);
    const sent = await asA()
      .post(`/documentation/bl-drafts/${draftId}/send`)
      .send({ to: [{ email: 'ops@shafidi-a.test' }] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data.status).toBe('SENT');
    // Sent for checking is not approved: the booking has not moved.
    expect(await statusOf(A.sentFirst.id)).toBe('ADVISED');

    const approved = await asA().post(`/documentation/bl-drafts/${draftId}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.sentAt).not.toBeNull();
    expect(await statusOf(A.sentFirst.id)).toBe('BL_DRAFTED');

    // Approved once.
    const twice = await asA().post(`/documentation/bl-drafts/${draftId}/approve`).send({});
    expect(twice.status).toBe(409);
  });

  it('issues with the count it was approved with, and refuses a different one', async () => {
    const changed = await asA()
      .post(`/documentation/bookings/${A.sentFirst.id}/bl/issue`)
      .send({ originalBlCount: 5 });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('ORIGINALS_FIXED');

    const issued = await asA().post(`/documentation/bookings/${A.sentFirst.id}/bl/issue`).send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.data.originalBlCount).toBe(3);

    const res = await pdf(
      asA().get(`/documentation/bookings/${A.sentFirst.id}/bl/pdf?kind=ORIGINAL`),
    );
    expect(res.status).toBe(200);
    expect(pageCount(res.body as Buffer)).toBe(3);
    expect(extractPdfText(res.body as Buffer)).toContain('3 of 3');
  });

  it('cancelling the issued bill voids the issue and returns the booking to its advise', async () => {
    const cancelled = await asA()
      .post(`/documentation/bl-drafts/${draftId}/cancel`)
      .send({ reason: 'Consignee block wrong' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await statusOf(A.sentFirst.id)).toBe('ADVISED');

    // The void issue stays on the record.
    const row = await owner.blDraft.findFirstOrThrow({
      where: { id: BigInt(draftId) },
      select: { status: true, issuedAt: true },
    });
    expect(row.status).toBe('CANCELLED');
    expect(row.issuedAt).not.toBeNull();

    const gone = await asA().get(`/documentation/bookings/${A.sentFirst.id}/bl`);
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe('NO_BL_DRAFT');

    // Redrafted against the same House BL number, which the advise still holds.
    await makeDraft(A, A.sentFirst, 3);
  });
});

describe('a draft sent for checking and then withdrawn', () => {
  it('cancels, and the booking stays advised', async () => {
    const draftId = await makeDraft(A, A.withdrawn);
    const sent = await asA()
      .post(`/documentation/bl-drafts/${draftId}/send`)
      .send({ to: [{ email: 'ops@shafidi-a.test' }] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const cancelled = await asA()
      .post(`/documentation/bl-drafts/${draftId}/cancel`)
      .send({ reason: 'Customer booked another vessel' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await statusOf(A.withdrawn.id)).toBe('ADVISED');
  });
});

describe('the permission boundary', () => {
  it('lets a viewer see the list and nothing else', async () => {
    const viewer = as(A.viewerToken, SLUG_A);
    expect((await viewer.get('/documentation/bl-print?limit=5')).status).toBe(200);
    expect((await viewer.get(`/documentation/bookings/${A.main.id}/bl`)).status).toBe(200);
    expect(
      (await viewer.post(`/documentation/bookings/${A.main.id}/bl/issue`).send({})).status,
    ).toBe(403);
    expect(
      (await viewer.get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=COPY`)).status,
    ).toBe(403);
  });

  it('lets a printer print but not issue', async () => {
    const printer = as(A.printerToken, SLUG_A);
    const res = await pdf(printer.get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=COPY`));
    expect(res.status).toBe(200);
    expect(
      (await printer.post(`/documentation/bookings/${A.main.id}/bl/issue`).send({})).status,
    ).toBe(403);
  });

  it('shows nothing to someone without BL Print', async () => {
    expect((await as(A.bareToken, SLUG_A).get('/documentation/bl-print')).status).toBe(403);
  });
});

describe('tenant isolation (§7A rule 4)', () => {
  it('shows the other workspace none of these bills, and cannot reach them by id', async () => {
    const asB = as(B.superToken, SLUG_B);
    for (const view of ['TO_ISSUE', 'ISSUED']) {
      const res = await asB.get(`/documentation/bl-print?view=${view}&limit=100`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((r: { id: string }) => r.id);
      for (const booking of [A.main, A.sentFirst, A.withdrawn]) {
        expect(ids).not.toContain(booking.id.toString());
      }
    }

    expect((await asB.get(`/documentation/bookings/${A.main.id}/bl`)).status).toBe(404);
    expect(
      (await asB.post(`/documentation/bookings/${A.main.id}/bl/issue`).send({ originalBlCount: 1 }))
        .status,
    ).toBe(404);
    expect((await asB.get(`/documentation/bookings/${A.main.id}/bl/pdf?kind=COPY`)).status).toBe(
      404,
    );
  });
});
