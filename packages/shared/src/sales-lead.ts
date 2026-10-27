import { z } from 'zod';

import { listQuerySchema } from './api';
import type { LookupOption } from './cost-head';
import { CONTACT_MODES } from './inquiry';

/**
 * Sales leads — "Sales Lead-FOB" and "Sales Lead follow up" on the menu.
 *
 * §9 Q12, answered: a lead is a conversation before there is a lane, and an
 * inquiry links back to the one it came from.
 *
 * The fields are the client's FOB Sales Lead Form of 2026-10-26, transcribed in
 * docs/SALES_LEAD_FOB.md; the § numbers below are that form's sections. Before
 * it arrived this carried a name and notes only, and the leads raised then keep
 * NULL in everything the form added — so the DTO's new fields are nullable even
 * where the input schema requires them.
 */

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');
const optionalDate = z.union([dateField, z.literal('')]).optional();

const idField = (message: string) => z.string().regex(/^\d+$/, message);
const optionalId = z.union([z.string().regex(/^\d+$/, 'Choose an option.'), z.literal('')]).optional();

const text = (max: number, tooLong: string) => z.string().trim().max(max, tooLong).optional();

/**
 * A decimal on the wire, as a string — §4 rule 6 keeps these in NUMERIC, and a
 * JSON number is a float. Blank means "not stated", which is not zero.
 */
const amount = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, message)
    .optional()
    .or(z.literal(''));

/** Net profit can be a loss: the one figure here allowed a minus sign. */
const signedAmount = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d{1,4})?$/, message)
    .optional()
    .or(z.literal(''));

// ------------------------------------------------------------------ vocabulary

/** §5's workflow, one status per step, and LOST. */
export const SALES_LEAD_STATUSES = [
  'NEW',
  'QUALIFIED',
  'RATE_REQUESTED',
  'QUOTED',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;
export type SalesLeadStatus = (typeof SALES_LEAD_STATUSES)[number];

export const SALES_LEAD_STATUS_LABEL: Record<SalesLeadStatus, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  RATE_REQUESTED: 'Rate requested',
  QUOTED: 'Quoted',
  NEGOTIATION: 'Follow-up / negotiation',
  WON: 'Won',
  LOST: 'Lost',
};

/** A decided lead. Everything else is the pipeline. */
export const CLOSED_LEAD_STATUSES: readonly SalesLeadStatus[] = ['WON', 'LOST'];

export function isClosedLead(status: SalesLeadStatus): boolean {
  return CLOSED_LEAD_STATUSES.includes(status);
}

/** §7 "conversion pending": a quotation is out and the customer has not said. */
export const CONVERSION_PENDING_STATUSES: readonly SalesLeadStatus[] = ['QUOTED', 'NEGOTIATION'];

/** §5's six steps, as the form's progress strip draws them. */
export const SALES_LEAD_STEPS: readonly { status: SalesLeadStatus; label: string; hint: string }[] = [
  { status: 'NEW', label: 'Capture lead', hint: 'Exporter, buyer, lane and shipment potential.' },
  { status: 'QUALIFIED', label: 'Qualify lead', hint: 'Freight control, incumbent forwarder, volume and first shipment.' },
  { status: 'RATE_REQUESTED', label: 'Request rate', hint: 'Raise an inquiry for the pricing team.' },
  { status: 'QUOTED', label: 'Submit quotation', hint: 'Quote with validity and selling conditions.' },
  { status: 'NEGOTIATION', label: 'Follow up', hint: 'Calls, emails, target rates, objections.' },
  { status: 'WON', label: 'Convert to business', hint: 'Link the customer, quotation and booking.' },
];

export const SALES_LEAD_BUSINESS_TYPES = [
  'NEW_CUSTOMER',
  'EXISTING_NEW_LANE',
  'EXISTING_MORE_VOLUME',
] as const;
export type SalesLeadBusinessType = (typeof SALES_LEAD_BUSINESS_TYPES)[number];

export const SALES_LEAD_BUSINESS_TYPE_LABEL: Record<SalesLeadBusinessType, string> = {
  NEW_CUSTOMER: 'New customer',
  EXISTING_NEW_LANE: 'Existing customer — new lane',
  EXISTING_MORE_VOLUME: 'Existing customer — more volume',
};

export const SALES_LEAD_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type SalesLeadPriority = (typeof SALES_LEAD_PRIORITIES)[number];

export const SALES_LEAD_PRIORITY_LABEL: Record<SalesLeadPriority, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const SALES_LEAD_FREQUENCIES = [
  'WEEKLY',
  'FORTNIGHTLY',
  'MONTHLY',
  'QUARTERLY',
  'SEASONAL',
  'ONE_OFF',
] as const;
export type SalesLeadFrequency = (typeof SALES_LEAD_FREQUENCIES)[number];

export const SALES_LEAD_FREQUENCY_LABEL: Record<SalesLeadFrequency, string> = {
  WEEKLY: 'Weekly',
  FORTNIGHTLY: 'Fortnightly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  SEASONAL: 'Seasonal',
  ONE_OFF: 'One-off',
};

/** §4 Freight Control: who decides which forwarder moves the cargo. */
export const FREIGHT_CONTROLS = [
  'FREE_HAND',
  'BUYER_NOMINATED',
  'BUYING_HOUSE',
  'AGENT_NOMINATED',
  'UNKNOWN',
] as const;
export type FreightControl = (typeof FREIGHT_CONTROLS)[number];

export const FREIGHT_CONTROL_LABEL: Record<FreightControl, string> = {
  FREE_HAND: 'Free hand — exporter decides',
  BUYER_NOMINATED: 'Buyer nominated',
  BUYING_HOUSE: 'Buying house nominated',
  AGENT_NOMINATED: 'Nominated through our agent',
  UNKNOWN: 'Not confirmed yet',
};

/**
 * §3 Shipment Mode. Stored as the inquiry's shipment_type + loading_type, so a
 * lead raises an inquiry without translating; one field on the form.
 */
export const LEAD_SHIPMENT_MODES = ['SEA_FCL', 'SEA_LCL', 'AIR'] as const;
export type LeadShipmentMode = (typeof LEAD_SHIPMENT_MODES)[number];

export const LEAD_SHIPMENT_MODE_LABEL: Record<LeadShipmentMode, string> = {
  SEA_FCL: 'Sea FCL',
  SEA_LCL: 'Sea LCL',
  AIR: 'Air',
};

/**
 * What one unit of §3's volume is. The form writes "containers" because FOB
 * garments move in boxes; an LCL or air lead is measured the way its inquiry
 * would be, and the per-unit revenue and profit follow.
 */
export const LEAD_VOLUME_UNIT: Record<LeadShipmentMode, { plural: string; singular: string }> = {
  SEA_FCL: { plural: 'containers', singular: 'container' },
  SEA_LCL: { plural: 'CBM', singular: 'CBM' },
  AIR: { plural: 'KG', singular: 'KG' },
};

export const SALES_LEAD_DOCUMENT_KINDS = [
  'RFQ',
  'SHIPMENT_FORECAST',
  'BUYER_NOMINATION',
  'PREVIOUS_QUOTATION',
  'OTHER',
] as const;
export type SalesLeadDocumentKind = (typeof SALES_LEAD_DOCUMENT_KINDS)[number];

export const SALES_LEAD_DOCUMENT_KIND_LABEL: Record<SalesLeadDocumentKind, string> = {
  RFQ: 'RFQ',
  SHIPMENT_FORECAST: 'Shipment forecast',
  BUYER_NOMINATION: 'Buyer nomination',
  PREVIOUS_QUOTATION: 'Previous quotation',
  OTHER: 'Other',
};

// ----------------------------------------------------------------------- input

export const salesLeadInputSchema = z
  .object({
    // §1 Lead identification
    leadDate: dateField,
    sourceId: idField('Choose where this lead came from.'),
    ownerId: idField('Choose the salesperson who owns this lead.'),
    businessType: z.enum(SALES_LEAD_BUSINESS_TYPES, { message: 'Choose the business type.' }),
    priority: z.union([z.enum(SALES_LEAD_PRIORITIES), z.literal('')]).optional(),

    // §2 Customer and commercial parties
    name: z
      .string()
      .trim()
      .min(1, 'Enter the exporter or factory name.')
      .max(200, 'Name is too long.'),
    customerId: optionalId,
    exporterContact: text(200, 'That name is too long.'),
    exporterMobile: text(50, 'That number is too long.'),
    exporterEmail: z
      .string()
      .trim()
      .max(255, 'That address is too long.')
      .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.')
      .optional(),
    factoryLocation: text(300, 'That location is too long.'),
    buyerName: text(200, 'That name is too long.'),
    buyerCustomerId: optionalId,
    buyerCountry: text(100, 'That country is too long.'),
    buyingHouse: text(200, 'That name is too long.'),
    agentName: text(200, 'That name is too long.'),
    agentId: optionalId,
    agentCountry: text(100, 'That country is too long.'),
    agentContact: text(300, 'That contact is too long.'),

    // §3 Shipment opportunity details
    commodityItemId: idField('Choose the commodity.'),
    shipmentMode: z.enum(LEAD_SHIPMENT_MODES, { message: 'Choose the shipment mode.' }),
    polId: idField('Choose the port of loading.'),
    podId: idField('Choose the port of discharge.'),
    containerSizeId: optionalId,
    monthlyVolume: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,3})?$/, 'Enter the volume as a number, up to 3 decimals.')
      .optional()
      .or(z.literal('')),
    shipmentFrequency: z.union([z.enum(SALES_LEAD_FREQUENCIES), z.literal('')]).optional(),
    firstShipmentDate: optionalDate,
    incumbentForwarder: text(200, 'That name is too long.'),
    currentCarrierId: optionalId,
    requirements: text(4000, 'Requirements are too long.'),

    // §4 Revenue potential and sales qualification
    freightControl: z.union([z.enum(FREIGHT_CONTROLS), z.literal('')]).optional(),
    status: z.enum(SALES_LEAD_STATUSES, { message: 'Choose the lead status.' }),
    revenuePerUnit: amount('Enter the revenue as a number, up to 4 decimals.'),
    profitPerUnit: signedAmount('Enter the profit as a number, up to 4 decimals.'),
    marketRatePerUnit: amount('Enter the market rate as a number, up to 4 decimals.'),
    marketRateSource: text(200, 'That source is too long.'),
    winProbability: z
      .string()
      .trim()
      .regex(/^(100|[1-9]?\d)$/, 'Enter a whole percentage from 0 to 100.')
      .optional()
      .or(z.literal('')),
    nextFollowupDate: optionalDate,
    outcomeReason: text(2000, 'The reason is too long.'),
  })
  .superRefine((value, ctx) => {
    if (value.polId === value.podId) {
      ctx.addIssue({
        code: 'custom',
        path: ['podId'],
        message: 'The port of discharge must differ from the port of loading.',
      });
    }
    if (value.shipmentMode !== 'SEA_FCL' && value.containerSizeId !== undefined && value.containerSizeId !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['containerSizeId'],
        message: 'Equipment type applies to Sea FCL only.',
      });
    }
    if (isClosedLead(value.status) && (value.outcomeReason ?? '').trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['outcomeReason'],
        message:
          value.status === 'WON' ? 'Say why this lead was won.' : 'Say why this lead was lost.',
      });
    }
    // §5 step 06: converting to business links the lead to the customer.
    if (value.status === 'WON' && (value.customerId ?? '') === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['customerId'],
        message: 'Link the exporter to a customer record before marking the lead Won.',
      });
    }
  });

export type SalesLeadInput = z.input<typeof salesLeadInputSchema>;

// ------------------------------------------------------------------------- DTO

export interface SalesLeadDto {
  id: string;
  /** FOB-2026-0001, or the code a pre-form lead was given. */
  code: string;
  isActive: boolean;
  createdAt: string;

  // §1
  leadDate: string;
  sourceId: string | null;
  sourceName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  /** §6 Lead ownership: the salesperson's department, from the employee record. */
  ownerDepartment: string | null;
  businessType: SalesLeadBusinessType | null;
  priority: SalesLeadPriority | null;

  // §2
  name: string;
  customerId: string | null;
  customerName: string | null;
  exporterContact: string | null;
  exporterMobile: string | null;
  exporterEmail: string | null;
  factoryLocation: string | null;
  buyerName: string | null;
  buyerCustomerId: string | null;
  buyerCountry: string | null;
  buyingHouse: string | null;
  agentName: string | null;
  agentId: string | null;
  agentCountry: string | null;
  agentContact: string | null;

  // §3
  commodityItemId: string | null;
  commodityName: string | null;
  shipmentMode: LeadShipmentMode | null;
  polId: string | null;
  polName: string | null;
  podId: string | null;
  podName: string | null;
  /** §6 Trade lane: the destination country, from the port. */
  podCountry: string | null;
  containerSizeId: string | null;
  containerSizeName: string | null;
  monthlyVolume: string | null;
  shipmentFrequency: SalesLeadFrequency | null;
  firstShipmentDate: string | null;
  incumbentForwarder: string | null;
  currentCarrierId: string | null;
  currentCarrierName: string | null;
  requirements: string | null;

  // §4
  freightControl: FreightControl | null;
  status: SalesLeadStatus;
  /** ISO code of the per-unit figures, e.g. USD. */
  currency: string | null;
  revenuePerUnit: string | null;
  profitPerUnit: string | null;
  marketRatePerUnit: string | null;
  marketRateSource: string | null;
  winProbability: number | null;
  nextFollowupDate: string | null;
  outcomeReason: string | null;
  closedAt: string | null;

  /** §4 "Calculated opportunity value" and §6 Business forecast. */
  forecast: SalesLeadForecastDto;

  followupCount: number;
  /** Inquiries raised from this lead — the point of §9 Q12's answer. */
  inquiryCount: number;
  documentCount: number;
}

/** Decimal strings, two places; null where an input is missing. */
export interface SalesLeadForecastDto {
  monthlyRevenue: string | null;
  monthlyProfit: string | null;
  /** Monthly profit × win probability — the probability-weighted pipeline. */
  weightedProfit: string | null;
  /** FCL only: containers × the equipment's TEU factor. */
  monthlyTeu: string | null;
}

/**
 * The same arithmetic the API runs, for the form to show as it is typed.
 *
 * Numbers rather than decimals because this is a preview of an estimate; the
 * figures that are stored and summed are computed server-side in NUMERIC.
 */
export function previewForecast(input: {
  shipmentMode: LeadShipmentMode | '';
  monthlyVolume: string;
  revenuePerUnit: string;
  profitPerUnit: string;
  winProbability: string;
  teuFactor: string | null;
}): { monthlyRevenue: number | null; monthlyProfit: number | null; weightedProfit: number | null; monthlyTeu: number | null } {
  const parse = (value: string): number | null => {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const volume = parse(input.monthlyVolume);
  const revenue = parse(input.revenuePerUnit);
  const profit = parse(input.profitPerUnit);
  const probability = parse(input.winProbability);
  const teu = input.teuFactor === null ? null : parse(input.teuFactor);

  const monthlyRevenue = volume !== null && revenue !== null ? volume * revenue : null;
  const monthlyProfit = volume !== null && profit !== null ? volume * profit : null;
  return {
    monthlyRevenue,
    monthlyProfit,
    weightedProfit:
      monthlyProfit !== null && probability !== null ? (monthlyProfit * probability) / 100 : null,
    monthlyTeu:
      input.shipmentMode === 'SEA_FCL' && volume !== null && teu !== null ? volume * teu : null,
  };
}

export const SALES_LEAD_SORT_FIELDS = ['code', 'leadDate', 'name', 'nextFollowupDate', 'createdAt'] as const;
export type SalesLeadSortField = (typeof SALES_LEAD_SORT_FIELDS)[number];

/** The register's status filter: one status, or every open or every closed lead. */
export const SALES_LEAD_STATUS_FILTERS = ['OPEN', 'CLOSED', ...SALES_LEAD_STATUSES] as const;

/** Follow-up due buckets, shared by the register filter and the follow-up screen. */
export const LEAD_FOLLOWUP_DUE = ['OVERDUE', 'TODAY', 'UPCOMING', 'UNSCHEDULED'] as const;
export type LeadFollowupDue = (typeof LEAD_FOLLOWUP_DUE)[number];

export const LEAD_FOLLOWUP_DUE_LABEL: Record<LeadFollowupDue, string> = {
  OVERDUE: 'Overdue',
  TODAY: 'Due today',
  UPCOMING: 'Next 7 days',
  UNSCHEDULED: 'No date set',
};

export const salesLeadListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(SALES_LEAD_SORT_FIELDS).default('leadDate'),
  status: z.enum(SALES_LEAD_STATUS_FILTERS).optional(),
  ownerId: z.string().regex(/^\d+$/).optional(),
  freightControl: z.enum(FREIGHT_CONTROLS).optional(),
  due: z.enum(LEAD_FOLLOWUP_DUE).optional(),
});

/** §7's management KPIs. Money is USD, as the form writes it. */
export interface SalesLeadKpiDto {
  activeLeads: number;
  qualifiedLeads: number;
  monthlyTeuPipeline: string;
  monthlyRevenue: string;
  monthlyProfit: string;
  weightedProfit: string;
  conversionPending: number;
  /** WON ÷ (WON + LOST) among leads decided this year; null before any are. */
  conversionRate: number | null;
  wonThisYear: number;
  lostThisYear: number;
  overdueFollowups: number;
  newCustomersWon: number;
  /** The year the two "this year" figures count, in the workspace's zone. */
  year: number;
  currency: string;
}

export const salesLeadKpiQuerySchema = z.object({
  ownerId: z.string().regex(/^\d+$/).optional(),
});

/** Everything the lead form's dropdowns offer. */
export interface SalesLeadFormOptions {
  sources: LookupOption[];
  owners: (LookupOption & { department: string | null })[];
  customers: (LookupOption & {
    country: string;
    address: string | null;
    /** The first contact on file, to prefill the exporter's contact fields. */
    contact: { name: string; mobile: string | null; email: string | null } | null;
  })[];
  agents: (LookupOption & {
    country: string;
    contact: { name: string; email: string | null } | null;
  })[];
  commodities: (LookupOption & { hsCode: string | null })[];
  seaPorts: (LookupOption & { country: string })[];
  airPorts: (LookupOption & { country: string })[];
  containerSizes: (LookupOption & { teuFactor: string })[];
  carriers: LookupOption[];
  /** The signed-in user's employee record, the default owner of a new lead. */
  defaultOwnerId: string | null;
  /** The per-unit figures' currency. Null when the workspace has no USD. */
  currency: string | null;
}

// ------------------------------------------------------------------ follow-up

export const salesLeadFollowupInputSchema = z.object({
  followupDate: dateField,
  contactMode: z.enum(CONTACT_MODES, { message: 'Choose how you made contact.' }),
  contactPerson: z.string().trim().max(200, 'That name is too long.').optional(),
  /** The discussion. */
  notes: z.string().trim().max(2000, 'Notes are too long.').optional(),
  outcome: z.string().trim().max(2000, 'The outcome is too long.').optional(),
  nextAction: z.string().trim().max(300, 'The next action is too long.').optional(),
  targetRate: amount('Enter the target rate as a number, up to 4 decimals.'),
  objections: z.string().trim().max(2000, 'Objections are too long.').optional(),
  nextFollowupDate: z.union([dateField, z.literal('')]).optional(),
});

export type SalesLeadFollowupInput = z.input<typeof salesLeadFollowupInputSchema>;

export interface SalesLeadFollowupDto {
  id: string;
  followupDate: string;
  contactMode: (typeof CONTACT_MODES)[number];
  contactPerson: string | null;
  notes: string | null;
  outcome: string | null;
  nextAction: string | null;
  targetRate: string | null;
  currency: string | null;
  objections: string | null;
  nextFollowupDate: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** A lead's own follow-up screen: the lead, its history, and what it led to. */
export interface SalesLeadFollowupPayload {
  lead: SalesLeadDto;
  followups: SalesLeadFollowupDto[];
  /** §5 steps 03–06: the inquiries raised from it, and how far each got. */
  inquiries: { id: string; code: string; inquiryDate: string; status: string; customerName: string }[];
}

/** One row of the Sales Lead follow up screen's due list. */
export interface SalesLeadDueDto {
  id: string;
  code: string;
  name: string;
  status: SalesLeadStatus;
  ownerName: string | null;
  lane: string | null;
  nextFollowupDate: string | null;
  due: LeadFollowupDue;
  /** The most recent follow-up, so the next call starts where it ended. */
  last: {
    followupDate: string;
    contactMode: (typeof CONTACT_MODES)[number];
    outcome: string | null;
    nextAction: string | null;
  } | null;
}

export const salesLeadDueQuerySchema = listQuerySchema.extend({
  due: z.enum(LEAD_FOLLOWUP_DUE).optional(),
  ownerId: z.string().regex(/^\d+$/).optional(),
});

/** One row of the follow-up screen's activity log, across every lead. */
export interface SalesLeadActivityDto extends SalesLeadFollowupDto {
  leadId: string;
  leadCode: string;
  leadName: string;
}

export const salesLeadActivityQuerySchema = listQuerySchema.extend({
  ownerId: z.string().regex(/^\d+$/).optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});

// ------------------------------------------------------------------ documents

export const salesLeadDocumentUploadSchema = z.object({
  kind: z.enum(SALES_LEAD_DOCUMENT_KINDS, { message: 'Choose what this document is.' }),
});

export interface SalesLeadDocumentDto {
  id: string;
  kind: SalesLeadDocumentKind;
  fileName: string;
  uploadedBy: string | null;
  uploadedAt: string;
}
