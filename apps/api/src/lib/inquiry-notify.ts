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
  appUrl: string | null;
  actorId?: bigint | null;
  /** Decided in the save transaction by §5.1's routing service. */
  plan: RoutePlan;
}

export const INQUIRY_AGENT_RFQ = 'INQUIRY_AGENT_RFQ';
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
function agentVariables(input: NotifyInput): Record<string, string> {
  return {
    code: input.code,
    polLabel: input.polLabel,
    podLabel: input.podLabel,
    movement: input.movementType === 'INBOUND' ? 'Inbound' : 'Outbound',
    // Agents sign in at the same door as staff and land on Agent Inquiry.
    // This used to point at /portal, which stopped existing when the separate
    // portal was removed — a dead link in every RFQ we sent.
    link: input.appUrl === null ? '' : `${input.appUrl}/agent/inquiry`,
  };
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
): Promise<{ kind: 'none' | 'agents' | 'price-team'; queued: boolean; recipients: number }> {
  const { plan } = input;

  // Who to write to is the routing service's decision, not this function's.
  // Sending is all that happens here, which is why the three branches below
  // read as three sends rather than three rules.
  if (plan.agentEmails.length === 0 && plan.priceTeamEmails.length === 0) {
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

  if (plan.agentEmails.length > 0) {
    const to = plan.agentEmails;
    const values = agentVariables(input);
    const result = await queueMail({
      tenantId: input.tenantId,
      templateKey: INQUIRY_AGENT_RFQ,
      to,
      variables: values,
      relatedType: 'inquiry',
      relatedId: input.inquiryId,
      actorId: input.actorId ?? null,
      fallback: {
        subject: `Inquiry ${input.code} — quotation requested (${input.polLabel} → ${input.podLabel})`,
        bodyText: fallbackBody(
          'An inquiry is waiting for your quotation in the Triple S freight system.',
          values,
          'AGENT',
        ),
      },
    });
    return { kind: 'agents', queued: result.queued, recipients: to.length };
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
  return { kind: 'price-team', queued: result.queued, recipients: to.length };
}
