import { env } from '../config/env';
import { logger } from './logger';
import { parseAddressList, sendMail } from './mailer';
import { withTenant } from './tenant-client';

/**
 * Telling the price team an agent has come back with a number (approved item C).
 *
 * The forwarder asked an agent for a price and then stopped watching; without
 * this the quote sits in the portal until someone thinks to look. Same
 * recipients as the outbound "rate needed" notice, because it is the same
 * people closing the same loop.
 *
 * Runs AFTER the quote has committed and cannot fail it — lib/mailer.ts never
 * throws, and this adds nothing that could.
 *
 * **The price itself is not in the email.** A quote is the agent's commercial
 * position, mail is not a channel this product controls, and the notice only
 * needs to say that something is waiting. Whoever opens the portal sees the
 * figure; a forwarded inbox thread does not.
 */

export interface QuoteNotifyInput {
  tenantId: bigint;
  agentId: bigint;
  inquiryId: bigint;
  inquiryCode: string;
}

export async function notifyQuoteSubmitted(
  input: QuoteNotifyInput,
): Promise<{ sent: boolean; recipients: number }> {
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
    return { sent: false, recipients: 0 };
  }

  const lines = [
    `${context.agentName} has submitted a quotation for inquiry ${input.inquiryCode}.`,
    '',
    'The price is in the portal rather than in this email.',
  ];
  if (env.APP_URL !== undefined) {
    lines.push('', `Open it here: ${env.APP_URL}/sales/inquiry`);
  }

  const result = await sendMail({
    to: context.to,
    subject: `Quotation received — ${input.inquiryCode} (${context.agentName})`,
    text: lines.join('\n'),
  });
  return { sent: result.sent, recipients: context.to.length };
}
