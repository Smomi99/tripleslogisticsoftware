import nodemailer, { type Transporter } from 'nodemailer';

import { MAIL_CONFIG } from '../config/env';
import { logger } from './logger';

/**
 * Outgoing mail.
 *
 * Two rules govern everything here.
 *
 * **A notification never fails the thing it is about.** An inquiry that saved
 * correctly must not report an error because a mail server was unreachable, and
 * it must never be rolled back for one. Sending happens after the transaction
 * commits, and a failure is logged rather than thrown.
 *
 * **Nothing is sent unless mail is configured.** A developer machine has no
 * SMTP server; it should not try to reach one, and it should not refuse to boot
 * over it either. MAIL_CONFIG is null there and every send becomes a no-op that
 * says so in the log.
 *
 * The password, when there is one, is read once from the environment and handed
 * to the transport. It is never logged, never returned, and never included in
 * an error message.
 */

let transport: Transporter | null = null;

function transporter(): Transporter | null {
  if (MAIL_CONFIG === null) return null;
  if (transport === null) {
    transport = nodemailer.createTransport({
      host: MAIL_CONFIG.host,
      port: MAIL_CONFIG.port,
      secure: MAIL_CONFIG.secure,
      // Omitted entirely when there are no credentials — passing auth: null
      // would still make nodemailer attempt AUTH, which a catcher refuses.
      ...(MAIL_CONFIG.auth !== null ? { auth: MAIL_CONFIG.auth } : {}),
    });
  }
  return transport;
}

export interface Mail {
  to: string[];
  cc?: string[];
  subject: string;
  /**
   * Plain text, and required.
   *
   * It used to be the only option, on the reasoning that these go to agents on
   * mail clients we cannot test. That reasoning still holds, which is why it
   * stays mandatory — the HTML below is the alternative part of a multipart
   * message, never a replacement for it. A client that cannot render the one
   * still gets the other.
   */
  text: string;
  /** Optional richer part. The quotation needs it; a notification does not. */
  html?: string;
}

export interface MailResult {
  sent: boolean;
  /** Why it was not sent, when it was not. */
  reason?: 'not-configured' | 'no-recipients' | 'failed';
}

/**
 * Sends one message, and swallows the failure.
 *
 * Deliberately returns rather than throws. Every caller is a side effect of
 * something that has already succeeded, and none of them can do anything
 * useful with an exception.
 */
export async function sendMail(mail: Mail): Promise<MailResult> {
  const recipients = [...new Set(mail.to.map((a) => a.trim()).filter((a) => a !== ''))];
  const copies = [...new Set((mail.cc ?? []).map((a) => a.trim()).filter((a) => a !== ''))]
    // Somebody on both lines gets one copy, not two.
    .filter((a) => !recipients.includes(a));
  if (recipients.length === 0) {
    logger.info({ subject: mail.subject }, 'mail skipped: no recipients');
    return { sent: false, reason: 'no-recipients' };
  }

  const client = transporter();
  if (client === null || MAIL_CONFIG === null) {
    logger.info(
      { subject: mail.subject, to: recipients.length },
      'mail skipped: SMTP is not configured',
    );
    return { sent: false, reason: 'not-configured' };
  }

  try {
    await client.sendMail({
      from: MAIL_CONFIG.from,
      to: recipients.join(', '),
      ...(copies.length > 0 ? { cc: copies.join(', ') } : {}),
      subject: mail.subject,
      text: mail.text,
      ...(mail.html === undefined || mail.html === '' ? {} : { html: mail.html }),
    });
    logger.info(
      { subject: mail.subject, to: recipients.length, cc: copies.length },
      'mail sent',
    );
    return { sent: true };
  } catch (error) {
    // The address list is logged, the body is not — an inquiry's commercial
    // detail does not belong in a log file.
    logger.warn(
      { err: error, subject: mail.subject, to: recipients },
      'mail failed; the record it describes was saved regardless',
    );
    return { sent: false, reason: 'failed' };
  }
}

/** Splits the comma or semicolon separated lists people actually type. */
export function parseAddressList(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  return raw
    .split(/[,;\n]/)
    .map((a) => a.trim())
    .filter((a) => a !== '');
}
