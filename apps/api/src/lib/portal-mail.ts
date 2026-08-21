import { env } from '../config/env';
import { sendMail } from './mailer';

/**
 * The two emails that carry a one-time link (§2.4).
 *
 * Plain text, like every other message the product sends — these go to agents
 * on mail clients nobody here can test against.
 *
 * The link is the only secret in the message and it appears exactly once. It is
 * never logged: `sendMail` records the subject and the recipient count, and
 * these functions add nothing to that.
 */

function portalUrl(path: string): string {
  const base = env.APP_URL ?? '';
  return `${base}/portal${path}`;
}

export interface InviteMail {
  to: string;
  /** The agent company, not the person — it is what they will recognise. */
  agentName: string;
  forwarderName: string;
  token: string;
  expiresAt: Date;
}

export async function sendInviteMail(mail: InviteMail): Promise<void> {
  const link = portalUrl(`/accept-invite?token=${encodeURIComponent(mail.token)}`);
  await sendMail({
    to: [mail.to],
    subject: `${mail.forwarderName} — set up your quoting access`,
    text: [
      `${mail.forwarderName} has given ${mail.agentName} access to their rate portal.`,
      '',
      'You will be able to see the inquiries they send you and quote against them',
      'directly, instead of by email.',
      '',
      'Set your password here:',
      link,
      '',
      `This link works until ${mail.expiresAt.toISOString().slice(0, 10)} and can be used once.`,
      'Nobody at the forwarder can see the password you choose.',
      '',
      'If you were not expecting this, ignore it — the link expires on its own.',
    ].join('\n'),
  });
}

export interface ResetMail {
  to: string;
  forwarderName: string;
  token: string;
}

export async function sendResetMail(mail: ResetMail): Promise<void> {
  const link = portalUrl(`/reset?token=${encodeURIComponent(mail.token)}`);
  await sendMail({
    to: [mail.to],
    subject: `${mail.forwarderName} — reset your portal password`,
    text: [
      'Someone asked to reset the password on your rate portal account.',
      '',
      'Choose a new one here:',
      link,
      '',
      'This link works for one hour and can be used once. Asking for another',
      'reset cancels this one.',
      '',
      'If it was not you, nothing has changed and you can ignore this.',
    ].join('\n'),
  });
}
