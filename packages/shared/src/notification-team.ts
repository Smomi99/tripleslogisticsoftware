import { z } from 'zod';

/**
 * Settings → Notification, the team blocks — docs/DESIGN-UPDATE-2026-10-04.md §7.
 *
 * The client's Notification sheet gives five teams a Sender Email ID, a Reply
 * to and an Email Signature each, and says which letters each team sends
 * ("Applicable for"). The letters are the product's email templates; this file
 * is the one place that says which team signs which.
 */

export const NOTIFICATION_TEAMS = ['PRICE', 'CS_DOC', 'OPS', 'ACCOUNTS', 'SALES'] as const;
export type NotificationTeam = (typeof NOTIFICATION_TEAMS)[number];

export const NOTIFICATION_TEAM_LABEL: Record<NotificationTeam, string> = {
  PRICE: 'Price Team',
  CS_DOC: 'CS & Doc Team',
  OPS: 'Ops Team',
  ACCOUNTS: 'Accounts Team',
  SALES: 'Sales Team',
};

/** The sheet's "Applicable for" lists, verbatim in meaning (D5–D6, G5–G9, K5–K6, O4–O6, R5). */
export const NOTIFICATION_TEAM_APPLICABLE_FOR: Record<NotificationTeam, readonly string[]> = {
  PRICE: ['Price request email to carrier, agent, vendor', 'Quotation send to customer'],
  CS_DOC: [
    'Booking received',
    'Shipment approval',
    'Shipping order',
    'Shipment advice',
    'BL draft',
    'Departure, transshipment and arrival',
  ],
  OPS: ['Cargo receipt', 'Stuffing'],
  ACCOUNTS: ['Payment received', 'Debit invoice send', 'Payment send'],
  SALES: ['Pre-Alert'],
};

/**
 * Which team's identity a letter goes out under, by template key.
 *
 * Only letters that leave the company are listed. An alert to our own
 * colleagues (the price team's new-inquiry note, a customer's schedule
 * decision) has no customer to sign for, so it keeps the workspace sender.
 * Letters the sheet names that the product does not send yet (booking
 * received, shipping order, cargo receipt, stuffing, payment received and
 * sent) join their team when they exist.
 */
export const TEMPLATE_TEAM: Readonly<Record<string, NotificationTeam>> = {
  INQUIRY_AGENT_RFQ: 'PRICE',
  INQUIRY_CARRIER_RFQ: 'PRICE',
  QUOTATION_SENT: 'PRICE',
  CUSTOMER_PRICE_OFFER: 'PRICE',
  AGENT_PRICE_OFFER: 'PRICE',
  SHIPMENT_SCHEDULE_PROPOSED: 'CS_DOC',
  SHIPMENT_ADVISE_SENT: 'CS_DOC',
  BL_DRAFT_SENT: 'CS_DOC',
  SHIPMENT_DEPARTED: 'CS_DOC',
  SHIPMENT_TRANSSHIPPED: 'CS_DOC',
  SHIPMENT_ARRIVED: 'CS_DOC',
  DEBIT_INVOICE_SENT: 'ACCOUNTS',
  PRE_ALERT_SENT: 'SALES',
};

/** Letters that carry a signature of their own already, so the team's is not added twice. */
export const SELF_SIGNED_TEMPLATES: ReadonlySet<string> = new Set([
  'CUSTOMER_PRICE_OFFER',
  'AGENT_PRICE_OFFER',
]);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const optionalEmail = (what: string) =>
  z
    .string()
    .trim()
    .max(320)
    .refine((v) => v === '' || EMAIL.test(v), `The ${what} is not an email address.`);

export const notificationTeamInputSchema = z.object({
  team: z.enum(NOTIFICATION_TEAMS),
  senderEmail: optionalEmail('sender'),
  replyTo: optionalEmail('reply-to address'),
  signature: z.string().trim().max(2000, 'Keep the signature under 2,000 characters.'),
});

export const notificationTeamsSaveSchema = z.object({
  /** "Our mail server may send as these addresses." */
  sendAsTeam: z.boolean(),
  teams: z.array(notificationTeamInputSchema).max(NOTIFICATION_TEAMS.length),
});
export type NotificationTeamsSaveInput = z.input<typeof notificationTeamsSaveSchema>;

export interface NotificationTeamDto {
  team: NotificationTeam;
  senderEmail: string;
  replyTo: string;
  signature: string;
}

export interface NotificationTeamsDto {
  sendAsTeam: boolean;
  /** Always all five, in the sheet's order; a team never saved comes back blank. */
  teams: NotificationTeamDto[];
}
