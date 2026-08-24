import { env } from '../config/env';
import { queueMail } from './email-queue';
import { logger } from './logger';
import { parseAddressList } from './mailer';
import { withTenant } from './tenant-client';

/**
 * Telling the price team an agent has come back with a number (approved item C).
 *
 * The forwarder asked an agent for a price and then stopped watching; without
 * this the quote sits there until someone thinks to look. Same recipients as
 * the outbound "rate needed" notice, because it is the same people closing the
 * same loop.
 *
 * Runs AFTER the quote has committed and cannot fail it. Since the module
 * spec's email work it queues rather than sends, so a slow mail server cannot
 * delay the agent's submit and a transient failure retries instead of vanishing.
 *
 * **The price itself is not in the email.** A quote is the agent's commercial
 * position, mail is not a channel this product controls, and the notice only
 * needs to say that something is waiting. Whoever opens the screen sees the
 * figure; a forwarded inbox thread does not. That is also why the variable set
 * below carries a name and a code and no numbers — a tenant editing this
 * template cannot add a price it was never given.
 */

export const AGENT_QUOTE_SUBMITTED = 'AGENT_QUOTE_SUBMITTED';

export interface QuoteNotifyInput {
  tenantId: bigint;
  agentId: bigint;
  inquiryId: bigint;
  inquiryCode: string;
}

export async function notifyQuoteSubmitted(
  input: QuoteNotifyInput,
): Promise<{ queued: boolean; recipients: number }> {
  // Deliberately withTenant, not withAgent: this reads notification_setting and
  // the agent's name, and both are closed to an agent session. The agent has
  // already been authorised to write the quote; telling staff about it is the
  // forwarder's own business, run with the forwarder's own scope.
  const context = await withTenant(input.tenantId, async (db) => {
    const setting = await db.notificationSetting.findFirst({
      select: { priceTeamEmails: true },
    });
    const agent = await db.agent.findFirst({
      where: { id: input.agentId },
      select: { name: true },
    });
    return {
      to: parseAddressList(setting?.priceTeamEmails),
      agentName: agent?.name ?? 'An agent',
    };
  });

  if (context.to.length === 0) {
    logger.info(
      { inquiry: input.inquiryCode },
      'quote submitted; no price team address is configured',
    );
    return { queued: false, recipients: 0 };
  }

  const link = env.APP_URL === undefined ? '' : `${env.APP_URL}/sales/inquiry`;
  const lines = [
    `${context.agentName} has submitted a quotation for inquiry ${input.inquiryCode}.`,
    '',
    'The price is on the inquiry rather than in this email.',
  ];
  if (link !== '') lines.push('', `Open it here: ${link}`);

  const result = await queueMail({
    tenantId: input.tenantId,
    templateKey: AGENT_QUOTE_SUBMITTED,
    to: context.to,
    variables: { agentName: context.agentName, code: input.inquiryCode, link },
    relatedType: 'inquiry',
    relatedId: input.inquiryId,
    fallback: {
      subject: `Quotation received — ${input.inquiryCode} (${context.agentName})`,
      bodyText: lines.join('\n'),
    },
  });
  return { queued: result.queued, recipients: context.to.length };
}
