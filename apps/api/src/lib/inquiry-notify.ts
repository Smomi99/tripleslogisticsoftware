import { queueMail } from './email-queue';
import type { RoutePlan } from './inquiry-routing';
import { logger } from './logger';
import type { TenantDb } from './tenant-client';

/**
 * Telling someone an inquiry needs a price.
 *
 * The client's rule, in their words: an Inbound inquiry goes to the selected
 * agents' contacts; an Outbound one with no live rate goes to the price team so
 * they can obtain one from a carrier; and nothing is sent at all when the lane
 * already matches a purchased rate — there is nothing to ask for.
 *
 * Called AFTER the inquiry has committed, never inside its transaction. Since
 * the module spec's email work, this no longer sends: it writes a row to the
 * outbox and returns. A mail server being unreachable cannot delay the request,
 * and a message that fails is retried rather than lost.
 */

export interface NotifyInput {
  tenantId: bigint;
  inquiryId: bigint;
  code: string;
  movementType: 'INBOUND' | 'OUTBOUND';
  polLabel: string;
  podLabel: string;
  customerName: string;
  /** The client's letter opens with these three facts about the cargo. */
  commodity: string;
  volume: string;
  expectedShipmentDate: string | null;
  /** Who signs it: the salesman on the inquiry, not a name in a template. */
  senderName: string | null;
  senderDesignation: string | null;
  appUrl: string | null;
  actorId?: bigint | null;
  /** Decided in the save transaction by §5.1's routing service. */
  plan: RoutePlan;
}

export const INQUIRY_AGENT_RFQ = 'INQUIRY_AGENT_RFQ';
export const INQUIRY_CARRIER_RFQ = 'INQUIRY_CARRIER_RFQ';
export const INQUIRY_PRICE_TEAM = 'INQUIRY_PRICE_TEAM';

/**
 * The variables each audience is given — and the customer's name is the whole
 * reason these are two different sets.
 *
 * §2.1 rule 2: an agent must never learn who the shipper is, because an agent
 * who knows can approach them directly. The portal enforces that with a view
 * that has no customer_id and a DTO with no such field. Email is the copy that
 * leaves the building, so it is the one that matters most — and templates are
 * tenant-editable, which means somebody could put {{customerName}} into the
 * agent template with the best of intentions.
 *
 * So the agent's variable set simply does not contain it. A placeholder with no
 * value renders empty; there is nothing to leak because there is nothing there.
 */
/**
 * The facts the client's rate request states, and nothing else.
 *
 * Shared by the agent and carrier letters because the client wrote them as one
 * letter differing in a single line. The customer is absent from both, which is
 * §2.1 rule 2 and also simply what they wrote.
 */
function rfqVariables(
  input: NotifyInput,
  signature: string,
): Record<string, string> {
  return {
    code: input.code,
    polLabel: input.polLabel,
    podLabel: input.podLabel,
    commodity: input.commodity,
    volume: input.volume,
    expectedShipmentDate: input.expectedShipmentDate ?? 'To be confirmed',
    senderName: input.senderName ?? '',
    senderDesignation: input.senderDesignation ?? '',
    signature,
  };
}

function agentVariables(input: NotifyInput, signature: string): Record<string, string> {
  return {
    ...rfqVariables(input, signature),
    movement: input.movementType === 'INBOUND' ? 'Inbound' : 'Outbound',
    // Agents sign in at the same door as staff and land on Agent Inquiry.
    // This used to point at /portal, which stopped existing when the separate
    // portal was removed — a dead link in every RFQ we sent.
    link: input.appUrl === null ? '' : `${input.appUrl}/agent/inquiry`,
  };
}

/**
 * The workspace's own sign-off, or nothing.
 *
 * Not in the template text: the seeded templates are shared rows every
 * workspace falls back to, and one company's address under another company's
 * letter is the leak §7A exists to prevent. Empty until somebody fills it in on
 * Settings → Notification, and an unsigned letter is still a correct one.
 */
async function signatureBlock(db: TenantDb): Promise<string> {
  const row = await db.notificationSetting.findFirst({ select: { signatureBlock: true } });
  return row?.signatureBlock?.trim() ?? '';
}

function staffVariables(input: NotifyInput): Record<string, string> {
  return {
    code: input.code,
    customerName: input.customerName,
    polLabel: input.polLabel,
    podLabel: input.podLabel,
    movement: input.movementType === 'INBOUND' ? 'Inbound' : 'Outbound',
    link: input.appUrl === null ? '' : `${input.appUrl}/sales/inquiry`,
  };
}

/**
 * The client's rate request, rendered without a template row.
 *
 * resolveTemplate falls back to this when a workspace has deleted its copy, so
 * it has to say the same thing the seeded template says rather than something
 * terser — a letter that goes to a carrier should not depend on a seed having
 * run.
 */
function rfqBody(values: Record<string, string>, audience: 'AGENT' | 'CARRIER'): string {
  const lines = [
    'Dear Sir/Madam,',
    '',
    'Hope you are doing well.',
    '',
    'We are currently working to secure the below shipment and would appreciate',
    'your best possible freight rate:',
    '',
    `Commodity: ${values['commodity']}`,
    `POL: ${values['polLabel']}`,
    `POD: ${values['podLabel']}`,
    `Volume: ${values['volume']}`,
    `Expected Shipment Date: ${values['expectedShipmentDate']}`,
    '',
    'Could you please quote your most competitive rate for the above shipment,',
    'along with the applicable validity and any relevant surcharges?',
  ];
  if (audience === 'AGENT' && (values['link'] ?? '') !== '') {
    lines.push('', `Submit your quotation at ${values['link']}`);
    lines.push("If you don't have a user ID and password, please contact me.");
  }
  lines.push('', 'Your prompt support and best rate would be highly appreciated.', '', 'Kind regards,');
  for (const key of ['senderName', 'senderDesignation', 'signature']) {
    const value = (values[key] ?? '').trim();
    if (value !== '') lines.push(value);
  }
  return lines.join('\n');
}

/** Used only when a workspace has no template row — see resolveTemplate. */
function fallbackBody(
  lead: string,
  values: Record<string, string>,
  audience: 'AGENT' | 'STAFF',
): string {
  const lines = [lead, '', `Inquiry:   ${values['code']}`];
  if (audience === 'STAFF' && values['customerName'] !== undefined) {
    lines.push(`Customer:  ${values['customerName']}`);
  }
  lines.push(
    `Lane:      ${values['polLabel']} → ${values['podLabel']}`,
    `Movement:  ${values['movement']}`,
  );
  if (values['link'] !== '') {
    lines.push('', `${audience === 'AGENT' ? 'Quote it here' : 'Open it here'}: ${values['link']}`);
  }
  return lines.join('\n');
}

/**
 * Queues whichever notification the inquiry calls for, and reports what it did.
 *
 * The return value is for the caller's log and for tests — nothing on screen
 * depends on it, because the inquiry is already saved by the time this runs.
 */
export async function notifyInquiry(
  _db: TenantDb,
  input: NotifyInput,
): Promise<{
  kind: 'none' | 'agents' | 'carriers' | 'price-team';
  queued: boolean;
  recipients: number;
}> {
  const { plan } = input;

  // Who to write to is the routing service's decision, not this function's.
  // Sending is all that happens here, which is why the three branches below
  // read as three sends rather than three rules.
  if (
    plan.agentEmails.length === 0 &&
    plan.carrierEmails.length === 0 &&
    plan.priceTeamEmails.length === 0
  ) {
    logger.info(
      { code: input.code, branch: plan.branch },
      'no notification for this inquiry',
    );
    return {
      kind: plan.branch === 'OUTBOUND_PRICED' || plan.branch === 'NOWHERE' ? 'none' : 'agents',
      queued: false,
      recipients: 0,
    };
  }

  /*
   * Carriers first, and independently of the agents: an inbound inquiry may
   * have both ticked, and each gets its own letter. The two differ by one line,
   * but sending an agent the carrier's letter would tell them there is nowhere
   * to submit — and sending a carrier the agent's would point them at a login
   * they do not have.
   */
  let carrierQueued = false;
  if (plan.carrierEmails.length > 0) {
    const values = rfqVariables(input, await signatureBlock(_db));
    const result = await queueMail({
      tenantId: input.tenantId,
      templateKey: INQUIRY_CARRIER_RFQ,
      to: plan.carrierEmails,
      variables: values,
      relatedType: 'inquiry',
      relatedId: input.inquiryId,
      actorId: input.actorId ?? null,
      fallback: {
        subject: `Rate Request. POL: ${input.polLabel}, POD: ${input.podLabel}, Inquiry No: ${input.code}`,
        bodyText: rfqBody(values, 'CARRIER'),
      },
    });
    carrierQueued = result.queued;
  }

  if (plan.agentEmails.length > 0) {
    const to = plan.agentEmails;
    const values = agentVariables(input, await signatureBlock(_db));
    const result = await queueMail({
      tenantId: input.tenantId,
      templateKey: INQUIRY_AGENT_RFQ,
      to,
      variables: values,
      relatedType: 'inquiry',
      relatedId: input.inquiryId,
      actorId: input.actorId ?? null,
      fallback: {
        subject: `Rate Request. POL: ${input.polLabel}, POD: ${input.podLabel}, Inquiry No: ${input.code}`,
        bodyText: rfqBody(values, 'AGENT'),
      },
    });
    return {
      kind: 'agents',
      queued: result.queued || carrierQueued,
      recipients: to.length + plan.carrierEmails.length,
    };
  }

  if (plan.carrierEmails.length > 0 && plan.priceTeamEmails.length === 0) {
    return { kind: 'carriers', queued: carrierQueued, recipients: plan.carrierEmails.length };
  }

  /*
   * The pricing team, resolved from the permission rather than from a typed
   * list (§5.1). notification_setting.price_team_emails is left alone but no
   * longer read here: an address list goes stale the first time somebody
   * leaves, and nobody notices until a lane goes unpriced.
   */
  const to = plan.priceTeamEmails;

  const values = staffVariables(input);
  const result = await queueMail({
    tenantId: input.tenantId,
    templateKey: INQUIRY_PRICE_TEAM,
    to,
    variables: values,
    relatedType: 'inquiry',
    relatedId: input.inquiryId,
    actorId: input.actorId ?? null,
    fallback: {
      subject: `Rate needed — ${input.code} (${input.polLabel} → ${input.podLabel})`,
      bodyText: fallbackBody(
        'This outbound lane has no live buying rate. Please obtain one from a carrier.',
        values,
        'STAFF',
      ),
    },
  });
  return {
    kind: 'price-team',
    queued: result.queued || carrierQueued,
    recipients: to.length + plan.carrierEmails.length,
  };
}
