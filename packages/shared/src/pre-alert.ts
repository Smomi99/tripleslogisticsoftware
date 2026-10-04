import { z } from 'zod';

import { listQuerySchema } from './api';
import { SHIPMENT_TYPES, type ShipmentType } from './inquiry';
import { MILESTONE_SORT_FIELDS, type MilestoneRow } from './milestone';

/**
 * Customer Service → Pre-Alert (docs/DESIGN-UPDATE-2026-10-04.md §3).
 *
 * The client's `Pre Alert-Sea` sheet: the On board list's booking row with a
 * Status and `Send`; Send opens "Select Documents", "Select Agent" and
 * "Email ID". It goes from the Sales Team's address (I20).
 */

export const PRE_ALERT_DOCUMENTS = [
  'BOOKING_CONFIRMATION',
  'HBL',
  'MBL',
  'HAWB',
  'MAWB',
  'MANIFEST_AIR',
  'DEBIT_NOTE',
] as const;
export type PreAlertDocumentKind = (typeof PRE_ALERT_DOCUMENTS)[number];

export const PRE_ALERT_DOCUMENT_LABEL: Record<PreAlertDocumentKind, string> = {
  BOOKING_CONFIRMATION: 'Booking confirmation',
  HBL: 'HBL',
  MBL: 'MBL',
  HAWB: 'HAWB',
  MAWB: 'MAWB',
  MANIFEST_AIR: 'Manifest-Air',
  DEBIT_NOTE: 'Debit Note',
};

/** One sheet for both modes; each mode is offered the papers it has. */
export const PRE_ALERT_DOCUMENTS_FOR: Record<ShipmentType, readonly PreAlertDocumentKind[]> = {
  SEA: ['BOOKING_CONFIRMATION', 'HBL', 'MBL', 'DEBIT_NOTE'],
  AIR: ['BOOKING_CONFIRMATION', 'HAWB', 'MAWB', 'MANIFEST_AIR', 'DEBIT_NOTE'],
};

export const PRE_ALERT_VIEWS = ['AWAITING', 'SENT', 'ALL'] as const;
export type PreAlertView = (typeof PRE_ALERT_VIEWS)[number];

export const PRE_ALERT_VIEW_LABEL: Record<PreAlertView, string> = {
  AWAITING: 'Awaiting',
  SENT: 'Sent',
  ALL: 'All',
};

export const preAlertListQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(SHIPMENT_TYPES),
  view: z.enum(PRE_ALERT_VIEWS).default('AWAITING'),
  sortBy: z.enum(MILESTONE_SORT_FIELDS).optional(),
});

export const preAlertDocumentUploadSchema = z.object({
  kind: z.enum(PRE_ALERT_DOCUMENTS),
});

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const preAlertSendSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'Choose the agent.'),
  to: z
    .array(z.string().trim().regex(EMAIL, 'One of those is not an email address.'))
    .min(1, 'Give at least one email address.')
    .max(20),
  documents: z.array(z.enum(PRE_ALERT_DOCUMENTS)).min(1, 'Choose at least one document.'),
});
export type PreAlertSendInput = z.input<typeof preAlertSendSchema>;

/** Where a document would come from if it were sent now. */
export type PreAlertDocumentSource = 'UPLOAD' | 'SYSTEM';

export interface PreAlertDocumentDto {
  kind: PreAlertDocumentKind;
  /** Null when there is nothing to attach yet. */
  source: PreAlertDocumentSource | null;
  fileName: string | null;
  /** What the system would attach, or why it cannot. */
  note: string | null;
}

export interface PreAlertAgentOption {
  id: string;
  name: string;
  country: string | null;
  /** Its contacts' email addresses, offered as the Email ID. */
  emails: string[];
  /** The agent covers this booking's destination port (CRM → Agent → port coverage). */
  coversPod: boolean;
}

export interface PreAlertSendDto {
  id: string;
  sentAt: string;
  sentByName: string | null;
  agentName: string;
  to: string[];
  documents: PreAlertDocumentKind[];
  emailed: boolean;
}

export interface PreAlertDetailDto {
  shipmentId: string;
  bookingCode: string;
  shipmentType: ShipmentType;
  documents: PreAlertDocumentDto[];
  agents: PreAlertAgentOption[];
  sends: PreAlertSendDto[];
}

export interface PreAlertRow extends MilestoneRow {
  /** The latest send, if any — the sheet's Status. */
  lastSent: { sentAt: string; agentName: string } | null;
  sentCount: number;
}
