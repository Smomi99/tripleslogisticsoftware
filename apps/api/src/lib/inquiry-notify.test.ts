import { describe, expect, it, vi } from 'vitest';

import type { TenantDb } from './tenant-client';

/**
 * What the two notification emails actually say.
 *
 * The existing coverage in inquiry-parties.test.ts checks who is written to.
 * This checks what they are told, which turned out to be the more dangerous
 * half: the agent's copy named the customer, and pointed at a staff screen the
 * agent's credentials cannot open.
 *
 * Mail is captured rather than sent, so the body can be read exactly as it
 * would arrive.
 */

const sent: { to: string[]; subject: string; text: string }[] = [];
vi.mock('./mailer', () => ({
  sendMail: (mail: { to: string[]; subject: string; text: string }) => {
    sent.push(mail);
    return Promise.resolve({ sent: true });
  },
  parseAddressList: (raw: string | null | undefined) =>
    raw == null ? [] : raw.split(/[,;\n]/).map((a) => a.trim()).filter((a) => a !== ''),
}));

const { notifyInquiry } = await import('./inquiry-notify');

const CUSTOMER = 'Confidential Shipper Ltd';

/** Only the two reads notifyInquiry makes; no database is involved. */
function stubDb(over: {
  contacts?: { agentPic: { email: string } | null }[];
  priceTeam?: string | null;
}): TenantDb {
  return {
    inquiryPartyContact: { findMany: () => Promise.resolve(over.contacts ?? []) },
    notificationSetting: {
      findFirst: () => Promise.resolve({ priceTeamEmails: over.priceTeam ?? null }),
    },
  } as unknown as TenantDb;
}

const base = {
  inquiryId: 1n,
  code: 'INQ-2026-000042',
  polLabel: 'Chattogram',
  podLabel: 'Aarhus',
  customerName: CUSTOMER,
  laneMatched: false,
  appUrl: 'https://acme.example.com',
};

describe('the agent copy', () => {
  it('never names the customer', async () => {
    sent.length = 0;
    const result = await notifyInquiry(
      stubDb({ contacts: [{ agentPic: { email: 'mette@nordic.test' } }] }),
      { ...base, movementType: 'INBOUND' },
    );

    expect(result.kind).toBe('agents');
    expect(sent).toHaveLength(1);
    // Decision 2 is enforced in the portal by a view with no customer_id column
    // and a DTO with no such field. An email would walk around both — and this
    // is the copy that leaves the building.
    expect(sent[0]?.text).not.toContain(CUSTOMER);
    expect(sent[0]?.text).not.toContain('Customer:');
  });

  it('sends them to the portal, not to a staff screen', async () => {
    // The staff login refuses an agent credential by design, so /sales/inquiry
    // is a dead end that reads like a broken account.
    expect(sent[0]?.text).toContain('https://acme.example.com/portal');
    expect(sent[0]?.text).not.toContain('/sales/inquiry');
  });

  it('still carries the lane, which is what they are being asked to price', async () => {
    expect(sent[0]?.text).toContain('INQ-2026-000042');
    expect(sent[0]?.text).toContain('Chattogram → Aarhus');
    expect(sent[0]?.subject).toContain('quotation requested');
  });
});

describe('the price team copy', () => {
  it('names the customer, because they are staff', async () => {
    sent.length = 0;
    const result = await notifyInquiry(stubDb({ priceTeam: 'pricing@forwarder.test' }), {
      ...base,
      movementType: 'OUTBOUND',
    });

    expect(result.kind).toBe('price-team');
    expect(sent[0]?.text).toContain(CUSTOMER);
    expect(sent[0]?.text).toContain('/sales/inquiry');
    expect(sent[0]?.text).not.toContain('/portal');
  });
});

describe('a lane that already has a rate', () => {
  it('produces no mail at all', async () => {
    sent.length = 0;
    const result = await notifyInquiry(stubDb({ priceTeam: 'pricing@forwarder.test' }), {
      ...base,
      movementType: 'OUTBOUND',
      laneMatched: true,
    });
    expect(result.kind).toBe('none');
    expect(sent).toHaveLength(0);
  });
});
