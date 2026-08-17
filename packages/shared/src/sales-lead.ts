import { z } from 'zod';

import { listQuerySchema } from './api';
import { CONTACT_MODES } from './inquiry';

/**
 * Sales leads (CLAUDE.md §3's "New Sales Lead" and "Sales Lead Follow-up").
 *
 * §9 Q12, answered: a lead is a conversation before there is a lane, and an
 * inquiry links back to the one it came from.
 *
 * DELIBERATELY THIN. Neither screen has a wireframe (CLAUDE.md §11), so this
 * carries only what a lead cannot do without — who the conversation is with,
 * and what was said. No company size, no rating, no expected value: those would
 * be invented, and §10 rule 2 forbids that. When the wireframe arrives, fields
 * are added here and the screens grow with them.
 */

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');

export const salesLeadInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter who this lead is with.')
    .max(200, 'Name is too long.'),
  notes: z.string().trim().max(4000, 'Notes are too long.').optional(),
});

export type SalesLeadInput = z.input<typeof salesLeadInputSchema>;

export interface SalesLeadDto {
  id: string;
  code: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  followupCount: number;
  /** Inquiries raised from this lead — the point of §9 Q12's answer. */
  inquiryCount: number;
  nextFollowupDate: string | null;
  createdAt: string;
}

export const SALES_LEAD_SORT_FIELDS = ['code', 'name', 'createdAt'] as const;
export type SalesLeadSortField = (typeof SALES_LEAD_SORT_FIELDS)[number];

export const salesLeadListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(SALES_LEAD_SORT_FIELDS).default('name'),
});

// ------------------------------------------------------------------ follow-up

export const salesLeadFollowupInputSchema = z.object({
  followupDate: dateField,
  contactMode: z.enum(CONTACT_MODES, { message: 'Choose how you made contact.' }),
  contactPerson: z.string().trim().max(200, 'That name is too long.').optional(),
  notes: z.string().trim().max(2000, 'Notes are too long.').optional(),
  nextFollowupDate: z.union([dateField, z.literal('')]).optional(),
});

export type SalesLeadFollowupInput = z.input<typeof salesLeadFollowupInputSchema>;

export interface SalesLeadFollowupDto {
  id: string;
  followupDate: string;
  contactMode: (typeof CONTACT_MODES)[number];
  contactPerson: string | null;
  notes: string | null;
  nextFollowupDate: string | null;
  createdBy: string | null;
  createdAt: string;
}
