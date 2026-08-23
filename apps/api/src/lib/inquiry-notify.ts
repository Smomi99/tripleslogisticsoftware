import { logger } from './logger';
import { parseAddressList, sendMail } from './mailer';
import type { TenantDb } from './tenant-client';

/**
 * Telling someone an inquiry needs a price.
 *
 * The client's rule, in their words: an Inbound inquiry goes to the selected
 * agents' contacts; an Outbound one with no live rate goes to the price team so
 * they can obtain one from a carrier; and nothing is sent at all when the lane
 * already matches a purchased rate — there is nothing to ask for.
 *
 * Called AFTER the inquiry has committed, never inside its transaction. A mail
 * server being unreachable must not roll back an inquiry that saved correctly,
 * and lib/mailer.ts is written so that it cannot.
 */

export interface NotifyInput {
  inquiryId: bigint;
  code: string;
  movementType: 'INBOUND' | 'OUTBOUND';
  polLabel: string;
  podLabel: string;
  customerName: string;
  /** True when the lane already has a live purchased rate. */
  laneMatched: boolean;
  appUrl: string | null;
}

/**
 * The two audiences get different letters, and the differences are the point.
 *
 * **The customer's name is for staff only.** Decision 2 says an agent never
 * learns who the shipper is; the portal enforces that with a view that has no
 * customer_id column and a DTO with no such field. An email naming the customer
 * walks around both — and it is the copy that leaves the building, so it is the
 * one that matters most.
 *
 * **The link differs too.** Staff open /sales/inquiry. An agent cannot: the
 * staff login refuses an agent credential by design, so sending them there is a
 * dead end that reads like a broken account.
 */
function body(input: NotifyInput, lead: string, audience: 'AGENT' | 'STAFF'): string {
  const lines = [lead, '', `Inquiry:   ${input.code}`];

  if (audience === 'STAFF') {
    lines.push(`Customer:  ${input.customerName}`);
  }

  lines.push(
    `Lane:      ${input.polLabel} → ${input.podLabel}`,
    `Movement:  ${input.movementType === 'INBOUND' ? 'Inbound' : 'Outbound'}`,
  );

  if (input.appUrl !== null) {
    lines.push(
      '',
      audience === 'AGENT'
        ? `Quote it here: ${input.appUrl}/portal`
        : `Open it here: ${input.appUrl}/sales/inquiry`,
    );
  }
  return lines.join('\n');
}

/**
 * Sends whichever notification the inquiry calls for, and reports what it did.
 *
 * The return value is for the caller's log and for tests — nothing on screen
 * depends on it, because the inquiry is already saved by the time this runs.
 */
export async function notifyInquiry(
  db: TenantDb,
  input: NotifyInput,
): Promise<{ kind: 'none' | 'agents' | 'price-team'; sent: boolean; recipients: number }> {
  // The whole point of the lane check: a rate already exists, so nobody needs
  // to be asked for one.
  if (input.laneMatched) {
    logger.info({ code: input.code }, 'no notification: the lane already has a live rate');
    return { kind: 'none', sent: false, recipients: 0 };
  }

  if (input.movementType === 'INBOUND') {
    // The contacts chosen on the inquiry, not every contact the agent has:
    // the operator picked these people deliberately.
    const contacts = await db.inquiryPartyContact.findMany({
      where: { inquiryId: input.inquiryId, agentPicId: { not: null } },
      select: { agentPic: { select: { email: true } } },
    });
    const to = contacts
      .map((c) => c.agentPic?.email ?? '')
      .filter((email): email is string => email !== '');

    const result = await sendMail({
      to,
      subject: `Inquiry ${input.code} — quotation requested (${input.polLabel} → ${input.podLabel})`,
      text: body(
        input,
        'An inquiry is waiting for your quotation in the Triple S freight system.',
        'AGENT',
      ),
    });
    return { kind: 'agents', sent: result.sent, recipients: to.length };
  }

  const setting = await db.notificationSetting.findFirst({
    select: { priceTeamEmails: true },
  });
  const to = parseAddressList(setting?.priceTeamEmails);

  const result = await sendMail({
    to,
    subject: `Rate needed — ${input.code} (${input.polLabel} → ${input.podLabel})`,
    text: body(
      input,
      'This outbound lane has no live buying rate. Please obtain one from a carrier.',
      'STAFF',
    ),
  });
  return { kind: 'price-team', sent: result.sent, recipients: to.length };
}
