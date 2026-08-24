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
  containerSizeName: string | null;
  containerSizeNote: string | null;
  quantity: number | null;
  cbm: string | null;
  weightKg: string | null;
}

export interface AgentQuoteDto {
  id: string;
  code: string;
  /**
   * The single headline price, on quotes submitted before the wireframe's
   * breakdown existed. Empty on every quote that carries options — with two
   * offers in possibly different currencies there is no one honest number, so
   * the UI reads `options` and falls back to this only when there are none.
   */
  amount: string;
  currencyId: string;
  currencyCode: string | null;
  validUntil: string | null;
  transitDays: number | null;
  remarks: string | null;
  status: string;
  submittedAt: string;
  updatedAt: string;
  /** The alternative offers, in the order the agent arranged them. */
  options: AgentQuoteOptionDto[];
}

/** One charge row of the wireframe table. */
export interface AgentQuoteLineDto {
  id: string;
  position: number;
  carrierId: string | null;
  carrierName: string | null;
  costHeadId: string;
  costHeadName: string;
  containerSizeId: string | null;
  containerSizeName: string | null;
  costUnitId: string | null;
  costUnitName: string | null;
  quantity: string;
  unitPrice: string;
  currencyId: string;
  currencyCode: string | null;
  /** Computed by the database, never sent by a client. */
  totalAmount: string;
  remarks: string | null;
}

/** One alternative offer: a charge table under one routing. */
export interface AgentQuoteOptionDto {
  id: string;
  position: number;
  carrierId: string | null;
  carrierName: string | null;
  transitDays: number | null;
  via: string | null;
  podFreeDays: number | null;
  validUntil: string | null;
  etd: string | null;
  eta: string | null;
  remarks: string | null;
  lines: AgentQuoteLineDto[];
  /**
   * One total per currency used in the option. A list rather than a number
   * because ocean freight in USD beside local charges in BDT is the normal
   * case, and adding them would invent an exchange rate nobody quoted.
   */
  totals: AgentQuoteTotalDto[];
}

export interface AgentQuoteTotalDto {
  currencyId: string;
  currencyCode: string | null;
  amount: string;
}

/**
 * One message in the Status thread.
 *
 * `authorName` is rendered for the reader, not copied from the row. An agent
 * sees the forwarder's company name against staff messages, never the name of
 * the individual who typed it — the same boundary that keeps created_by out of
 * agent_inquiry_v. Staff see real names on both sides.
 */
export interface AgentQuoteCommentDto {
  id: string;
  body: string;
  /** Set on the message that announced the result; null on an ordinary one. */
  outcome: string | null;
  authorName: string;
  authorSide: 'FORWARDER' | 'AGENT';
  createdAt: string;
}

/**
 * Money and quantities travel as strings.
 *
 * §4 rule 6 keeps them in NUMERIC, and a JSON number is a float — 1234.5678
 * would arrive rounded, which is not a thing to discover from an invoice.
 */
const decimalString = (places: number, message: string) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d+(\\.\\d{1,${places}})?$`), message);

const optionalDate = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message)
    .optional()
    .or(z.literal(''));

const optionalCount = (message: string) =>
  z.union([z.number().int().min(0, message), z.literal('')]).optional();

const optionalId = z.string().regex(/^\d*$/, 'Choose a valid option.').optional();

/** One row of the charge table. */
export const agentQuoteLineInputSchema = z.object({
  carrierId: optionalId,
  costHeadId: z.string().regex(/^\d+$/, 'Choose a cost head.'),
  containerSizeId: optionalId,
  costUnitId: optionalId,
  quantity: decimalString(3, 'Enter a quantity, for example 2 or 12.5').refine(
    (v) => Number(v) > 0,
    'The quantity must be more than zero.',
  ),
  unitPrice: decimalString(4, 'Enter a unit price, for example 1450 or 1450.50'),
  currencyId: z.string().regex(/^\d+$/, 'Choose a currency.'),
  remarks: z.string().trim().max(500, 'That is too long.').optional().or(z.literal('')),
  // No total: it is computed by the database from the two numbers above. A
  // client-supplied total is a number nobody checked.
});

export type AgentQuoteLineInput = z.infer<typeof agentQuoteLineInputSchema>;

/** One alternative offer. */
export const agentQuoteOptionInputSchema = z
  .object({
    carrierId: optionalId,
    transitDays: optionalCount('Transit days cannot be negative.'),
    via: z.string().trim().max(200, 'That is too long.').optional().or(z.literal('')),
    podFreeDays: optionalCount('Free days cannot be negative.'),
    validUntil: optionalDate('Use a date like 2026-09-30.'),
    etd: optionalDate('Use a date like 2026-09-02.'),
    eta: optionalDate('Use a date like 2026-09-24.'),
    remarks: z.string().trim().max(2000, 'That is too long.').optional().or(z.literal('')),
    lines: z
      .array(agentQuoteLineInputSchema)
      .min(1, 'Add at least one charge line.')
      .max(50, 'That is more lines than an offer needs.'),
  })
  .refine(
    (o) => o.etd === undefined || o.etd === '' || o.eta === undefined || o.eta === '' || o.eta >= o.etd,
    { message: 'The ETA cannot be before the ETD.', path: ['eta'] },
  );

export type AgentQuoteOptionInput = z.infer<typeof agentQuoteOptionInputSchema>;

/**
 * What an agent submits: one or more alternative offers.
 *
 * The wireframe draws two. Nothing here caps it at two — an agent with one
 * routing sends one, and the second block simply is not filled in.
 */
export const agentQuoteInputSchema = z.object({
  options: z
    .array(agentQuoteOptionInputSchema)
    .min(1, 'Add at least one option.')
    .max(5, 'Five alternatives is already more than anyone will compare.'),
});

export type AgentQuoteInput = z.infer<typeof agentQuoteInputSchema>;

/** A message posted to the Status thread, by either side. */
export const agentQuoteCommentInputSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a message first.')
    .max(4000, 'That is too long for one message.'),
});

export type AgentQuoteCommentInput = z.infer<typeof agentQuoteCommentInputSchema>;

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
  /** The alternative offers, exactly as the agent arranged them. */
  options: AgentQuoteOptionDto[];
  /**
   * The single headline price, on quotes submitted before the breakdown
   * existed. Empty on every quote that carries options.
   */
  amount: string;
  /** Needed to turn the quote into a purchase rate; the code is for display. */
  currencyId: string;
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
/**
 * Telling an agent how it ended.
 *
 * WON and LOST replaced ACCEPTED and DECLINED: the client wants the agent to
 * see the commercial result, not our internal filing. One outcome per quote,
 * so there is no state where a quote is both accepted and lost.
 *
 * The message is what the agent actually reads. It is optional for a win —
 * "Won" says enough — and required for a loss, because "you lost" with no
 * reason is the message that makes an agent stop quoting you. The client wrote
 * the example themselves: "Business LOST, your price was not competitive".
 */
export const agentQuoteDecisionSchema = z
  .object({
    decision: z.enum(['WON', 'LOST']),
    comment: z.string().trim().max(4000, 'That is too long for one message.').optional(),
  })
  .refine((d) => d.decision !== 'LOST' || (d.comment ?? '').length > 0, {
    message: 'Tell the agent why they lost it. They will quote you again on the strength of this.',
    path: ['comment'],
  });

export type AgentQuoteDecision = z.infer<typeof agentQuoteDecisionSchema>['decision'];

/** The terminal states, for anything that needs to ask "is this settled?". */
export const AGENT_QUOTE_OUTCOMES = ['WON', 'LOST'] as const;

/** A lookup row as a dropdown needs it, and no wider. */
export interface PortalLookupOption {
  id: string;
  label: string;
}

/**
 * Everything the quote form has to offer in a dropdown.
 *
 * Carrier, cost head and cost unit were closed to agents until the wireframe
 * put them in the agent's own hands. They carry trade vocabulary — line names,
 * charge labels, units — and nothing priced: no rate table, no customer, and
 * cost_head has no amount of its own.
 */
export interface AgentQuoteReferenceDto {
  currencies: PortalCurrencyOption[];
  carriers: PortalLookupOption[];
  costHeads: PortalLookupOption[];
  containerSizes: PortalLookupOption[];
  costUnits: PortalLookupOption[];
}
