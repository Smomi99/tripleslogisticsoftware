import { describe, expect, it, vi } from 'vitest';

import type { QueueMailInput } from './email-queue';
import type { RoutePlan } from './inquiry-routing';
import type { TenantDb } from './tenant-client';

/**
 * What the two notification emails actually say.
 *
 * The coverage in inquiry-parties.test.ts checks who is written to. This checks
 * what they are told, which turned out to be the more dangerous half: the
 * agent's copy named the customer, and pointed at a screen their credentials
 * cannot open.
 *
 * The outbox is captured rather than written, so both halves of a queued
 * message can be read: the fallback body that goes out when a workspace has no
 * template, and — more importantly — the VARIABLES the template is rendered
 * from. Those matter more than the wording now that templates are editable by
 * the tenant: a variable that was never supplied cannot be leaked by anybody
 * editing a template later.
 */

const queued: QueueMailInput[] = [];
vi.mock('./email-queue', () => ({
  queueMail: (input: QueueMailInput) => {
    queued.push(input);
    return Promise.resolve({ queued: true, id: 1n });
  },
}));

const { notifyInquiry, INQUIRY_AGENT_RFQ, INQUIRY_CARRIER_RFQ, INQUIRY_PRICE_TEAM } =
  await import('./inquiry-notify');

const CUSTOMER = 'Confidential Shipper Ltd';

/** Only the two reads notifyInquiry makes; no database is involved. */
function stubDb(over: {
  contacts?: { agentPic: { email: string } | null }[];
  priceTeam?: string | null;
  signature?: string | null;
}): TenantDb {
  return {
    inquiryPartyContact: { findMany: () => Promise.resolve(over.contacts ?? []) },
    notificationSetting: {
      findFirst: () =>
        Promise.resolve({
          priceTeamEmails: over.priceTeam ?? null,
          signatureBlock: over.signature ?? null,
        }),
    },
  } as unknown as TenantDb;
}

/**
 * Who to write to is decided by the routing service now (§5.1), so these tests
 * hand a plan in. What they assert is unchanged and is the dangerous half:
 * WHAT each audience is told, and what they are not.
 */
const plan = (over: Partial<RoutePlan> = {}): RoutePlan => ({
  branch: 'INBOUND_SHARED',
  status: 'RFQ_SENT',
  awaitingRate: false,
  agentEmails: [],
  carrierEmails: [],
  priceTeamEmails: [],
  liveRates: 0,
  ...over,
});

const base = {
  tenantId: 7n,
  inquiryId: 1n,
  code: 'INQ-2026-000042',
  polLabel: 'Chattogram',
  podLabel: 'Aarhus',
  customerName: CUSTOMER,
  // The three facts the client's rate request opens with.
  commodity: 'Knitted garments',
  volume: "1 x 20STD + 1 x 40HC",
  expectedShipmentDate: '2026-09-15',
  senderName: 'Tanjila Sathi',
  senderDesignation: 'Sr. Executive, Business Development & Pricing',
  appUrl: 'https://acme.example.com',
};

/** Everything a template could possibly render, as one string. */
const surfaceOf = (input: QueueMailInput) =>
  [input.fallback.subject, input.fallback.bodyText, JSON.stringify(input.variables)].join('\n');

describe("the carrier copy (docs/Email Templet.docx)", () => {
  const carrier = () =>
    notifyInquiry(stubDb({ signature: 'TRIPLE S LOGISTICS, Banani, Dhaka-1213' }), {
      ...base,
      movementType: 'OUTBOUND',
      plan: plan({
        branch: 'OUTBOUND_AWAITING_RATE',
        status: 'OPEN',
        carrierEmails: ['pricing@maersk.test'],
      }),
    });

  it('asks the question the client asks', async () => {
    queued.length = 0;
    await carrier();
    const sent = queued.find((q) => q.templateKey === INQUIRY_CARRIER_RFQ);
    expect(sent).toBeDefined();
    const surface = surfaceOf(sent!);
    expect(surface).toContain('Rate Request');
    expect(surface).toContain('Knitted garments');
    expect(surface).toContain("1 x 20STD + 1 x 40HC");
    expect(surface).toContain('2026-09-15');
    expect(surface).toContain('validity');
  });

  it('never names the customer either', async () => {
    /*
     * The client's own letter does not name the shipper, and neither does
     * this. A carrier is not an agent, but the reasoning that keeps the
     * customer off the agent's copy — they can approach them directly —
     * applies at least as strongly to a shipping line.
     */
    queued.length = 0;
    await carrier();
    const sent = queued.find((q) => q.templateKey === INQUIRY_CARRIER_RFQ);
    expect(surfaceOf(sent!)).not.toContain(CUSTOMER);
  });

  it('points nobody at a login they do not have', async () => {
    queued.length = 0;
    await carrier();
    const sent = queued.find((q) => q.templateKey === INQUIRY_CARRIER_RFQ);
    const surface = surfaceOf(sent!);
    expect(surface).not.toContain('Submit your quotation');
    expect(surface).not.toContain('user ID');
  });

  it('signs off with the salesman and the workspace block', async () => {
    queued.length = 0;
    await carrier();
    const surface = surfaceOf(queued.find((q) => q.templateKey === INQUIRY_CARRIER_RFQ)!);
    expect(surface).toContain('Tanjila Sathi');
    expect(surface).toContain('TRIPLE S LOGISTICS');
  });

  it('still tells the price team, so a lane cannot go quiet', async () => {
    queued.length = 0;
    const result = await notifyInquiry(stubDb({}), {
      ...base,
      movementType: 'OUTBOUND',
      plan: plan({
        branch: 'OUTBOUND_AWAITING_RATE',
        status: 'OPEN',
        carrierEmails: ['pricing@maersk.test'],
        priceTeamEmails: ['pricing@acme.test'],
      }),
    });
    expect(queued.map((q) => q.templateKey).sort()).toEqual([
      INQUIRY_CARRIER_RFQ,
      INQUIRY_PRICE_TEAM,
    ]);
    expect(result.recipients).toBe(2);
  });

  it('sends nothing when no carrier contact was ticked', async () => {
    queued.length = 0;
    await notifyInquiry(stubDb({}), {
      ...base,
      movementType: 'OUTBOUND',
      plan: plan({ branch: 'OUTBOUND_PRICED', status: 'PRICED' }),
    });
    expect(queued).toHaveLength(0);
  });
});

describe('the agent copy', () => {
  it('never names the customer', async () => {
    queued.length = 0;
    const result = await notifyInquiry(
      stubDb({ contacts: [{ agentPic: { email: 'mette@nordic.test' } }] }),
      {
        ...base,
        movementType: 'INBOUND',
        plan: plan({ agentEmails: ['mette@nordic.test'] }),
      },
    );

    expect(result.kind).toBe('agents');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.templateKey).toBe(INQUIRY_AGENT_RFQ);
    // Enforced elsewhere by a view with no customer_id and a DTO with no such
    // field. An email would walk around both — and this is the copy that leaves
    // the building.
    expect(surfaceOf(queued[0]!)).not.toContain(CUSTOMER);
    expect(queued[0]?.fallback.bodyText).not.toContain('Customer:');
  });

  it('is not even given the customer as a variable to render', async () => {
    // The structural half, and the reason this test exists twice over: a
    // template is tenant-editable, so somebody could add {{customerName}} to
    // the agent's letter with the best of intentions. There is nothing to
    // substitute.
    expect(Object.keys(queued[0]?.variables ?? {})).not.toContain('customerName');
  });

  it('points at Agent Inquiry, not a staff screen', async () => {
    // The staff login refuses an agent credential by design. This used to say
    // /portal, which stopped existing when the separate portal was removed —
    // a dead link in every RFQ that went out.
    expect(queued[0]?.variables['link']).toBe('https://acme.example.com/agent/inquiry');
    expect(surfaceOf(queued[0]!)).not.toContain('/sales/inquiry');
    expect(surfaceOf(queued[0]!)).not.toContain('/portal');
  });

  it('still carries the lane, which is what they are being asked to price', async () => {
    expect(surfaceOf(queued[0]!)).toContain('INQ-2026-000042');
    // The client's letter states the lane as two lines rather than an arrow,
    // and puts both ends plus the inquiry number in the subject.
    expect(queued[0]?.fallback.bodyText).toContain('POL: Chattogram');
    expect(queued[0]?.fallback.bodyText).toContain('POD: Aarhus');
    expect(queued[0]?.fallback.subject).toContain('Rate Request');
    expect(queued[0]?.fallback.subject).toContain('INQ-2026-000042');
  });

  it('files the message against the inquiry it is about', async () => {
    // So "what was sent about this inquiry?" has an answer on the record.
    expect(queued[0]?.relatedType).toBe('inquiry');
    expect(queued[0]?.relatedId).toBe(1n);
  });
});

describe('the price team copy', () => {
  it('names the customer, because they are staff', async () => {
    queued.length = 0;
    const result = await notifyInquiry(stubDb({}), {
      ...base,
      movementType: 'OUTBOUND',
      plan: plan({
        branch: 'OUTBOUND_AWAITING_RATE',
        status: 'OPEN',
        awaitingRate: true,
        priceTeamEmails: ['pricing@forwarder.test'],
      }),
    });

    expect(result.kind).toBe('price-team');
    expect(queued[0]?.templateKey).toBe(INQUIRY_PRICE_TEAM);
    expect(queued[0]?.fallback.bodyText).toContain(CUSTOMER);
    expect(queued[0]?.variables['customerName']).toBe(CUSTOMER);
    expect(queued[0]?.variables['link']).toBe('https://acme.example.com/sales/inquiry');
  });
});

describe('a lane that already has a rate', () => {
  it('produces no mail at all', async () => {
    queued.length = 0;
    const result = await notifyInquiry(stubDb({}), {
      ...base,
      movementType: 'OUTBOUND',
      // A live rate covers the lane, so the plan asks for nobody.
      plan: plan({ branch: 'OUTBOUND_PRICED', status: 'PRICED', liveRates: 2 }),
    });
    expect(result.kind).toBe('none');
    expect(queued).toHaveLength(0);
  });
});
