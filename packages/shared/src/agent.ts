import { z } from 'zod';

import {
  currencyRequiredFor,
  openingCurrencyField,
  unsignedMoneyField,
} from './opening-balance';

import { listQuerySchema } from './api';
import { countrySchema } from './countries';

/**
 * Agent and its children (CLAUDE.md §6).
 *   agent                 Table_Agent
 *   agent_pic             Table_Agent_PIC        [child]
 *   agent_expert_area     [M:N] expert_area
 *   agent_port_coverage   [M:N] port
 *   agent_network_member  [M:N] network
 *
 * §8: the three M:N fields use a searchable multi-select writing to the join
 * table — "never a comma-joined string column".
 */

export const AGENT_TYPES = ['GENERAL', 'EXCLUSIVE'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
export const AGENT_TYPE_LABEL: Record<AgentType, string> = {
  GENERAL: 'General',
  EXCLUSIVE: 'Exclusive',
};

const idListSchema = z.array(z.string().regex(/^\d+$/)).default([]);

export const agentInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the agent name.').max(200, 'Name is too long.'),
  country: countrySchema,
  address: z.string().trim().max(2000, 'Address is too long.').optional(),
  agentType: z.enum(AGENT_TYPES, { message: 'Choose general or exclusive.' }),
  expertAreaIds: idListSchema,
  portCoverageIds: idListSchema,
  networkIds: idListSchema,
  /**
   * The client's two opening columns, kept apart rather than netted: an agent
   * can owe us on one account while we owe them on another.
   */
  weOwe: unsignedMoneyField('Enter an amount, or leave it blank.'),
  agentOwe: unsignedMoneyField('Enter an amount, or leave it blank.'),
  openingCurrencyId: openingCurrencyField,
}).refine((v) => currencyRequiredFor([v.weOwe, v.agentOwe], v.openingCurrencyId), {
  message: 'Choose the currency those opening figures are in.',
  path: ['openingCurrencyId'],
});

export type AgentInput = z.input<typeof agentInputSchema>;

export const AGENT_SORT_FIELDS = ['code', 'name', 'country'] as const;
export type AgentSortField = (typeof AGENT_SORT_FIELDS)[number];

export const agentListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(AGENT_SORT_FIELDS).default('name'),
  agentType: z.enum(AGENT_TYPES).optional(),
  expertAreaId: z.string().regex(/^\d+$/).optional(),
});

export interface SelectedOption {
  id: string;
  name: string;
}

export interface AgentDto {
  id: string;
  code: string;
  name: string;
  country: string;
  address: string | null;
  agentType: AgentType;
  /** Storage key only, never the file itself (§2). */
  weOwe: string | null;
  agentOwe: string | null;
  openingCurrencyId: string | null;
  openingCurrencyCode: string | null;
  agreementFile: string | null;
  agreementFileName: string | null;
  expertAreas: SelectedOption[];
  portCoverage: SelectedOption[];
  networks: SelectedOption[];
  isActive: boolean;
  picCount: number;
}

export const agentPicInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the contact name.').max(200, 'Name is too long.'),
  department: z.string().trim().max(100, 'Department is too long.').optional(),
  designation: z.string().trim().max(100, 'Designation is too long.').optional(),
  mobile: z.string().trim().max(50, 'Mobile number is too long.').optional(),
  email: z
    .string()
    .trim()
    .max(255, 'Email is too long.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.')
    .optional(),
});

export type AgentPicInput = z.input<typeof agentPicInputSchema>;

export interface AgentPicDto {
  id: string;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  mobile: string | null;
  email: string | null;
  isActive: boolean;
}
