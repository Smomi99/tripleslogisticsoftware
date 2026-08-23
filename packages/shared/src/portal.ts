import { z } from 'zod';

/**
 * The agent portal's contracts (docs/AGENT_PORTAL_DESIGN.md §2).
 *
 * Kept apart from auth.ts on purpose. The two sign-ins are different doors with
 * different audiences, and a shared schema is the first step towards a shared
 * handler that branches — which is exactly what the design refuses.
 */

/**
 * Same rule as staff (§2): length beats composition. An agent picking their own
 * password is the whole point of the invite flow — a password your staff typed
 * is a password your staff knows.
 */
const portalPasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.');

export const portalLoginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.'),
});

/**
 * The link carries `<id>.<secret>`. The id is not a secret — it only says which
 * row to check — and it is what lets the secret itself be stored as a salted
 * argon2 hash rather than something reversible.
 */
export const credentialTokenSchema = z
  .string()
  .trim()
  .regex(/^\d+\.[A-Za-z0-9_-]{20,}$/, 'That link is not valid. Ask for a new one.');

export const acceptInviteSchema = z.object({
  token: credentialTokenSchema,
  password: portalPasswordSchema,
});

export const requestResetSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email address you were invited on.'),
});

export const completeResetSchema = z.object({
  token: credentialTokenSchema,
  password: portalPasswordSchema,
});

export type PortalLoginInput = z.infer<typeof portalLoginSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type RequestResetInput = z.infer<typeof requestResetSchema>;
export type CompleteResetInput = z.infer<typeof completeResetSchema>;

/**
 * Who the agent is, as the portal sees them.
 *
 * Deliberately not AuthenticatedUser: no permissions array, no roleName, no
 * isSuperadmin. An agent holds none of those, and a shape that carries the
 * fields invites code that reads them.
 */
export interface PortalUser {
  /** BigInt ids cross the wire as strings — JSON has no bigint. */
  id: string;
  username: string;
  email: string;
  /** The forwarding company this login belongs to. */
  agentId: string;
  agentName: string;
}

export interface PortalLoginResponse {
  accessToken: string;
  user: PortalUser;
}

/** What the invite screen shows before a password is chosen. */
export interface InvitePreview {
  agentName: string;
  email: string;
}

/**
 * Superadmin-side: turning an agent contact into a login (§2.4).
 *
 * The only input is which contact — the address is whatever agent_pic already
 * holds, so nobody retypes it, and the account is created dormant until the
 * invite is accepted.
 */
export const portalInviteSchema = z.object({
  agentPicId: z.string().regex(/^\d+$/, 'Choose a contact.'),
});

export type PortalInviteInput = z.infer<typeof portalInviteSchema>;

/** One agent login, as the CRM screen lists it. */
export interface PortalUserDto {
  id: string;
  username: string;
  email: string;
  /** The agent contact this login was created from, if that row still exists. */
  contactName: string | null;
  isActive: boolean;
  /** True while an unaccepted invite is still live. */
  invitePending: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * An inquiry as the agent sees it (§4).
 *
 * The absences are the specification. There is no customerId, no customerName,
 * no targetPrice and no field that could carry one — omission is a type-level
 * fact, so no careless spread or `select: *` can reintroduce them, and the
 * database backs the same boundary with agent_inquiry_v.
 */
export interface AgentInquiryDto {
  id: string;
  code: string;
  inquiryDate: string;
  shipmentType: string;
  movementType: string;
  loadingType: string | null;
  polName: string | null;
  polCode: string | null;
  polCountry: string | null;
  podName: string | null;
  podCode: string | null;
  podCountry: string | null;
  placeOfReceipt: string | null;
  commodityName: string | null;
  hsCode: string | null;
  tosName: string | null;
  /** The Incoterm. Decides what the price is expected to include. */
  modeName: string | null;
  expectedShipmentDate: string | null;
  validTo: string | null;
  /**
   * inquiry.remarks is NOT here, deliberately. It is free text the forwarder's
   * own staff type, so a customer name could reach an agent through it and no
   * database rule could stop that — the one place decision 2 was advisory
   * rather than structural. agent_inquiry_v drops the column too.
   *
   * The agent's own remarks, on their quote, are a different field entirely and
   * travel the other way.
   */
  status: string;
  volumes: AgentInquiryVolumeDto[];
  /** This agent's own quote, if they have given one. Never another agent's. */
  quote: AgentQuoteDto | null;
}

export interface AgentInquiryVolumeDto {
  id: string;
  volumeKind: string;
  containerTypeName: string | null;
  containerTypeNote: string | null;
  quantity: number | null;
  cbm: string | null;
  weightKg: string | null;
}

export interface AgentQuoteDto {
  id: string;
  code: string;
  amount: string;
  currencyId: string;
  currencyCode: string | null;
  validUntil: string | null;
  transitDays: number | null;
  remarks: string | null;
  status: string;
  submittedAt: string;
  updatedAt: string;
}

/**
 * What an agent submits. One price, per decision 3.
 *
 * Amount is a string on the wire: §4 rule 6 keeps money in NUMERIC(18,4), and
 * a JSON number is a float that would round 1234.5678 on the way in.
 */
export const agentQuoteInputSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Enter a price, for example 1450 or 1450.50')
    .refine((v) => Number(v) > 0, 'The price must be more than zero.'),
  currencyId: z.string().regex(/^\d+$/, 'Choose a currency.'),
  validUntil: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30.')
    .optional()
    .or(z.literal('')),
  transitDays: z
    .union([z.number().int().min(0, 'Transit days cannot be negative.'), z.literal('')])
    .optional(),
  remarks: z.string().trim().max(2000, 'That is too long.').optional().or(z.literal('')),
});

export type AgentQuoteInput = z.infer<typeof agentQuoteInputSchema>;

/** The portal list is small; page size is fixed rather than chosen. */
export const agentInquiryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(200).optional(),
  /** Only inquiries this agent has not yet quoted. */
  pending: z.enum(['true', 'false']).optional(),
});

export type AgentInquiryListQuery = z.infer<typeof agentInquiryListQuerySchema>;

/**
 * A currency, as the portal offers it.
 *
 * Deliberately NOT CurrencyDto. That type carries `conversion`, `tenantRate`
 * and `effectiveRate` — the forwarder's own booking rates, which say something
 * about their margins and are no business of an outside company. Three fields
 * is what a dropdown needs.
 */
export interface PortalCurrencyOption {
  id: string;
  /** The ISO code, e.g. USD — not the CUR-001 business code. */
  code: string;
  /** What the dropdown shows, e.g. "USD — US Dollar". */
  label: string;
}

/**
 * An agent's quote, as the FORWARDER sees it (staff side).
 *
 * Wider than AgentQuoteDto: staff see which agent it came from, who at that
 * agent submitted it, and every amendment. The agent sees only their own
 * current figure.
 */
export interface StaffAgentQuoteDto {
  id: string;
  code: string;
  agentId: string;
  agentName: string;
  /** The person at the agent who sent it, when a portal user did. */
  submittedByName: string | null;
  amount: string;
  currencyCode: string | null;
  validUntil: string | null;
  transitDays: number | null;
  remarks: string | null;
  status: string;
  submittedAt: string;
  updatedAt: string;
  /** Newest first. Empty when the quote has never been amended. */
  history: AgentQuoteChangeDto[];
}

/**
 * One recorded change to a quote, taken from the audit trail rather than a
 * bespoke history table — the trigger already captures both sides of every
 * write, so a second copy would be a second thing to keep correct.
 */
export interface AgentQuoteChangeDto {
  at: string;
  /**
   * SUBMITTED for the first version, AMENDED when the agent changed their
   * offer, DECIDED when the forwarder answered it.
   *
   * The third matters: an accept or a decline is an UPDATE like any other, so
   * without separating it a forwarder's own decision shows up as though the
   * agent had moved their price.
   */
  kind: 'SUBMITTED' | 'AMENDED' | 'DECIDED';
  /** Only the fields that actually moved. */
  changes: { field: string; from: string | null; to: string | null }[];
}

/**
 * The forwarder's answer to an agent's quote.
 *
 * Two outcomes only. WITHDRAWN belongs to the agent, and SUBMITTED is where a
 * quote starts — neither is something staff set.
 */
export const agentQuoteDecisionSchema = z.object({
  decision: z.enum(['ACCEPTED', 'DECLINED']),
});

export type AgentQuoteDecision = z.infer<typeof agentQuoteDecisionSchema>['decision'];
