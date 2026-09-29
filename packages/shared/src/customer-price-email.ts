import { z } from 'zod';

import type { LookupOption } from './cost-head';
import { customerListQuerySchema } from './customer';
import type { FreightRateDto } from './freight-rate';
import { RATE_MODE_LABEL, RATE_MODES, type RateMode } from './rate-lookups';

/**
 * CRM → Customer → Email prices.
 *
 * The customers the list is filtered to, their contacts' addresses checked and
 * tidied, a lane picked from the Price List, and one letter per customer with
 * the selling rates in it. Asked for by the client on 2026-09-29.
 *
 * Three rules shape everything here:
 *
 *  1. One email per customer, with only that customer's contacts on it. A
 *     bulk To or Cc would hand every customer the rest of the address book.
 *  2. Replies go to the Price team (Settings → Notifications), set as
 *     Reply-To. The client's choice: the people who own the rates answer them.
 *  3. Selling prices only. Buy price and margin never reach this text, for
 *     anyone — the same rule the downloaded price list follows, because an
 *     email leaves the building just as a file does.
 */

/** A send covers at most this many customers; the outbox drains ~120 a minute. */
export const PRICE_EMAIL_MAX_CUSTOMERS = 500;
/** Rates beyond this make a letter nobody reads; the screen says to narrow it. */
export const PRICE_EMAIL_MAX_RATES = 200;

// ------------------------------------------------------------------ addresses

/**
 * Domains people mistype often enough to be worth naming. Some of these are
 * registered, so the DNS check alone would pass them — and the mail would go
 * to a stranger rather than bounce.
 */
const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.con': 'outlook.com',
};

/**
 * What is wrong with an address's shape, or null when nothing is.
 *
 * Each message names the fix (§12), because the person reading it is about to
 * correct the address in place.
 */
export function emailSyntaxProblem(raw: string): string | null {
  const address = raw.trim();
  if (address === '') return 'Empty — type an address or remove it.';
  if (address.length > 254) return 'Too long to be an email address.';
  if (/\s/.test(address)) return 'Contains a space — remove it.';

  const at = address.lastIndexOf('@');
  if (at === -1) return 'Missing the @ — it should look like name@company.com.';
  if (address.indexOf('@') !== at) return 'Has more than one @ — keep only one.';

  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  if (local === '') return 'Nothing before the @ — add the mailbox name.';
  if (
    local.length > 64 ||
    !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return 'The part before the @ has a character an address cannot contain.';
  }
  if (domain === '') return 'Nothing after the @ — add the domain, like company.com.';

  const labels = domain.split('.');
  if (labels.length < 2) return `${domain} has no ending — it should look like ${domain}.com.`;
  if (
    labels.some(
      (label) =>
        label === '' ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-'),
    )
  ) {
    return `${domain} is not a valid domain.`;
  }
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1]!)) {
    return `${domain} does not end in a real domain ending.`;
  }

  const suggestion = TYPO_DOMAINS[domain];
  if (suggestion !== undefined) return `Looks like a typo — did you mean ${local}@${suggestion}?`;
  return null;
}

/** One address and whether it may be sent to. */
export interface EmailCheckDto {
  address: string;
  valid: boolean;
  /** Why not, naming the fix. Null when valid. */
  reason: string | null;
}

export const priceEmailCheckSchema = z.object({
  addresses: z.array(z.string().max(320)).min(1, 'Nothing to check.').max(2000),
});
export type PriceEmailCheckInput = z.infer<typeof priceEmailCheckSchema>;

// ----------------------------------------------------------------- recipients

/**
 * The Customer list's own filters, and only those — the button carries what
 * the list is showing, so the two must read the same parameters.
 */
export const priceEmailRecipientQuerySchema = customerListQuerySchema.pick({
  search: true,
  customerType: true,
  businessArea: true,
  industrySectorId: true,
});
export type PriceEmailRecipientQuery = z.infer<typeof priceEmailRecipientQuerySchema>;

export interface PriceEmailAddressDto extends EmailCheckDto {
  /** The contact the address was read from. */
  picName: string | null;
}

export interface PriceEmailRecipientDto {
  customerId: string;
  customerCode: string;
  customerName: string;
  /** Empty when no contact has an address — the screen says the customer is skipped. */
  emails: PriceEmailAddressDto[];
}

export interface PriceEmailRecipientsDto {
  customers: PriceEmailRecipientDto[];
}

// -------------------------------------------------------------------- context

export interface PriceEmailContextDto {
  /** Reply-To on every letter. Empty means the send is refused until it is set. */
  priceTeamEmails: string[];
  /**
   * The email signature from Settings → Notifications, which closes the
   * letter — closing words and all. Nothing is added around it: no sender
   * name or designation, and no "Kind regards," of our own, because the
   * client's signature already carries both (2026-09-29).
   */
  signOff: string;
  /** The Price List modes this user may read, in the order they are offered. */
  modes: RateMode[];
}

/**
 * What can be picked: every active port of the mode's kind (sea ports for Sea
 * FCL and LCL, airports for Air) and every active carrier — the Price List's
 * own choices. Offering only lanes with a live rate hid most of the port list
 * (client, 2026-09-29); a lane with no rate now simply says so under the
 * pickers instead.
 */
export interface PriceEmailOptionsDto {
  pols: LookupOption[];
  pods: LookupOption[];
  carriers: LookupOption[];
}

// ---------------------------------------------------------------------- rates

/** Comma-joined ids, as the Price List sends them. */
const idList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return [];
    const raw = Array.isArray(v) ? v : v.split(',');
    return raw.map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  });

export const priceEmailRatesQuerySchema = z
  .object({
    mode: z.enum(RATE_MODES, { message: 'Choose a freight mode.' }),
    polIds: idList,
    podIds: idList,
    carrierId: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .refine((v) => v.polIds.length > 0 && v.podIds.length > 0, {
    message: 'Choose at least one POL and one POD.',
    path: ['polIds'],
  })
  /*
   * One end may be a list, never both — the Price List's own rule. "These
   * origins into one port" and "one origin out to these" are comparisons; a
   * grid of both is not, and a customer reading it cannot find their lane.
   */
  .refine((v) => v.polIds.length < 2 || v.podIds.length < 2, {
    message: 'Several POLs to one POD, or one POL to several PODs — not both.',
    path: ['podIds'],
  });
export type PriceEmailRatesQuery = z.infer<typeof priceEmailRatesQuerySchema>;

export interface PriceEmailRatesDto {
  /** Selling side only: no buy price, no margin, whoever is asking. */
  rates: FreightRateDto[];
  /** More matched than PRICE_EMAIL_MAX_RATES; the screen asks to narrow it. */
  truncated: boolean;
}

/** What one price is for, in each mode — said once above the table. */
export const PRICE_EMAIL_PER_UNIT: Record<RateMode, string> = {
  SEA_FCL: 'per container',
  SEA_LCL: 'per CBM',
  AIR: 'per kg',
};

/** What a tier label needs to read as a quantity: "0-5" is "0-5 CBM". */
const TIER_SUFFIX: Record<RateMode, string> = { SEA_FCL: '', SEA_LCL: ' CBM', AIR: ' kg' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-31" → "31 Oct 2026". Read from the digits, so no timezone can move it. */
export function formatPriceEmailDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  const month = MONTHS[Number(m) - 1];
  return month === undefined ? iso : `${d} ${month} ${y}`;
}

/** "1250.0000" → "1,250.00". */
export function formatPriceEmailAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const day = formatPriceEmailDay;
const amount = formatPriceEmailAmount;

/**
 * The price columns a set of rates needs — one per tier any of them prices,
 * in the order the rates list them (their lines come sorted by the tier's own
 * sort order, so a 20STD column never lands after a 40HC one).
 */
export function priceEmailTiers(rates: FreightRateDto[]): { tierId: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const rate of rates) {
    for (const line of rate.lines) {
      if (!seen.has(line.tierId)) seen.set(line.tierId, `${line.tierLabel}${TIER_SUFFIX[rate.mode]}`);
    }
  }
  return [...seen.entries()].map(([tierId, label]) => ({ tierId, label }));
}

/**
 * The rates as plain text — the text/plain part of the letter, for the mail
 * clients that cannot or will not show the table.
 *
 * Label-and-value lines with bullets rather than a column grid: a text part is
 * shown in a proportional font, where columns that line up anywhere else
 * arrive as a jumble. A bullet list reads the same everywhere.
 *
 * Remarks are left out on purpose. They are the buyer's notes on the rate and
 * were never written for a customer to read.
 */
export function priceEmailRatesText(
  rates: FreightRateDto[],
  options: { includeLocalCharges: boolean },
): string {
  return rates
    .map((rate) => {
      const lines: string[] = [];
      lines.push(
        `${rate.polName} (${rate.polCode}) to ${rate.podName} (${rate.podCode}) — ${RATE_MODE_LABEL[rate.mode]}`,
      );
      lines.push(`Carrier: ${rate.carrierName} · Goods: ${rate.goodsTypeName}`);

      const terms = [`Valid ${day(rate.validFrom)} to ${day(rate.validTo)}`];
      if (rate.transitDays !== null) terms.push(`Transit ${rate.transitDays} days`);
      if (rate.freeDays !== null) terms.push(`Free time ${rate.freeDays} days`);
      if (rate.route !== null && rate.route.trim() !== '') terms.push(`Route: ${rate.route.trim()}`);
      lines.push(terms.join(' · '));

      for (const line of rate.lines) {
        const minimum =
          line.minCharge === null ? '' : ` (minimum ${rate.currencyCode} ${amount(line.minCharge)})`;
        lines.push(
          `• ${line.tierLabel}${TIER_SUFFIX[rate.mode]}: ${rate.currencyCode} ${amount(line.sellPrice)} ${PRICE_EMAIL_PER_UNIT[rate.mode]}${minimum}`,
        );
      }

      if (options.includeLocalCharges) {
        for (const [side, label] of [
          ['POL', 'Origin charges'],
          ['POD', 'Destination charges'],
        ] as const) {
          const charges = rate.localCharges.filter((c) => c.side === side);
          if (charges.length === 0) continue;
          const listed = charges.map((c) => {
            const unit = c.costUnitName === null ? '' : ` per ${c.costUnitName}`;
            const size = c.containerSizeCode === null ? '' : ` (${c.containerSizeCode})`;
            return `${c.costHeadName} ${c.currencyCode} ${amount(c.amount)}${unit}${size}`;
          });
          lines.push(`${label}: ${listed.join('; ')}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * A subject that names the lane: "Sea FCL rates: Chattogram to Hamburg", or
 * "… to 3 destinations" when one end is a list.
 */
export function defaultPriceEmailSubject(
  mode: RateMode,
  polNames: string[],
  podNames: string[],
): string {
  const side = (names: string[], many: string) =>
    names.length === 1 ? names[0]! : `${names.length} ${many}`;
  if (polNames.length === 0 || podNames.length === 0) return `${RATE_MODE_LABEL[mode]} rates`;
  return `${RATE_MODE_LABEL[mode]} rates: ${side(polNames, 'origins')} to ${side(podNames, 'destinations')}`;
}

/**
 * How every letter opens. Generic on purpose (client, 2026-09-29): it is one
 * letter to many customers, and a company name in the greeting reads as a
 * mail merge. The same words the rate requests to agents and carriers use.
 */
export const PRICE_EMAIL_GREETING = 'Dear Sir/Madam,';

/** The common part of the letter, pre-filled and editable before sending. */
export const DEFAULT_PRICE_EMAIL_MESSAGE = [
  'Hope you are doing well.',
  '',
  'Please find below our latest freight rates. They are valid for the dates shown and subject to space and equipment availability at the time of booking.',
  '',
  'Reply to this email for a formal quotation, or to book your next shipment.',
].join('\n');

/**
 * The whole letter one customer receives, as plain text — the text/plain part
 * that travels alongside the HTML table (priceEmailHtml).
 *
 * The server's fallback body comes from here, and the seeded
 * CUSTOMER_PRICE_OFFER template has the same shape.
 */
export function composePriceEmailBody(parts: {
  message: string;
  rates: string;
  signOff: string;
}): string {
  const signOff = parts.signOff.trim();
  return [
    PRICE_EMAIL_GREETING,
    '',
    parts.message.trim(),
    '',
    parts.rates.trim(),
    // The signature carries its own closing ("Best regards,") — no second one here.
    ...(signOff === '' ? [] : ['', signOff]),
  ].join('\n');
}

// ----------------------------------------------------------------------- html

/** Text destined for HTML, with nothing in it that can execute or break the markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped, with the writer's line breaks kept. */
const htmlLines = (value: string): string => escapeHtml(value.trim()).replace(/\n/g, '<br>');

/*
 * Inline styles only: Gmail and Outlook drop <style> blocks, so a table styled
 * any other way arrives as bare text. The hexes are Manifest's own (§12) —
 * hull, steel, line and paper — written out because an email cannot read CSS
 * variables.
 */
const CELL = 'padding:6px 10px;border:1px solid #DDE3E3;vertical-align:top;text-align:left';
const HEAD =
  'padding:6px 10px;border:1px solid #DDE3E3;background:#F4F6F5;color:#64717E;font-size:11px;' +
  'font-weight:600;letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap;text-align:left';
const NUMBER = "text-align:right;white-space:nowrap;font-family:Consolas,'IBM Plex Mono',Menlo,monospace";
const MUTED = 'color:#64717E;font-size:11px';
const TABLE = 'border-collapse:collapse;font-size:13px;line-height:1.4;color:#10243A';
const CAPTION = 'margin:16px 0 6px;font-weight:600';

/** One column of an email table: its header, and what each row puts in it (HTML, or null for empty). */
interface Column<Row> {
  label: string;
  numeric?: boolean;
  cell: (row: Row) => string | null;
}

/**
 * A table from columns, leaving out any column that is empty on every row —
 * a "Route" of nothing but dashes is width the reader pays for and learns
 * nothing from.
 */
function htmlTable<Row>(rows: Row[], columns: Column<Row>[]): string {
  const kept = columns.filter((column) => rows.some((row) => column.cell(row) !== null));
  const head = kept
    .map(
      (column) =>
        `<th style="${HEAD}${column.numeric === true ? ';text-align:right' : ''}">${escapeHtml(column.label)}</th>`,
    )
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${kept
          .map((column) => {
            const style = column.numeric === true ? `${CELL};${NUMBER}` : CELL;
            return `<td style="${style}">${column.cell(row) ?? '—'}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<table cellpadding="0" cellspacing="0" style="${TABLE}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Every row holds the same value, so it can be said once above the table instead. */
const allSame = <T,>(values: T[]): boolean => new Set(values).size === 1;

/**
 * The rates as a table — the Price List's layout, selling side only: one row
 * per lane and carrier, one column per container size or weight break.
 *
 * Built to stay narrow, because a mail client gives it perhaps 700 pixels and
 * a table wider than that is read by scrolling sideways — or not at all on a
 * phone. Whatever every row shares — the POL, the POD, the goods, the
 * currency — is said once in the heading ("Chattogram to Hamburg · Textile ·
 * prices in USD per container") rather than repeated down a column, and a
 * column empty on every row is left out.
 *
 * Origin and destination charges follow in a second, smaller table rather
 * than widening every row for the few rates that carry them.
 */
export function priceEmailRatesHtml(
  rates: FreightRateDto[],
  options: { includeLocalCharges: boolean },
): string {
  if (rates.length === 0) return '';
  const first = rates[0]!;
  const mode = first.mode;
  const onePol = allSame(rates.map((r) => r.polId));
  const onePod = allSame(rates.map((r) => r.podId));
  const oneGoods = allSame(rates.map((r) => r.goodsTypeId));
  const oneCurrency = allSame(rates.map((r) => r.currencyCode));
  const text = (value: string | number | null): string | null =>
    value === null || String(value).trim() === '' ? null : escapeHtml(String(value).trim());

  const lane =
    onePol && onePod
      ? `${first.polName} to ${first.podName}`
      : onePol
        ? `from ${first.polName}`
        : onePod
          ? `to ${first.podName}`
          : null;
  const heading = [`${RATE_MODE_LABEL[mode]} rates`, lane, oneGoods ? first.goodsTypeName : null]
    .filter((part): part is string => part !== null)
    .map(escapeHtml)
    .join(' · ');
  const unitNote = `prices ${oneCurrency ? `in ${first.currencyCode} ` : ''}${PRICE_EMAIL_PER_UNIT[mode]}`;

  const tierColumns: Column<FreightRateDto>[] = priceEmailTiers(rates).map((tier) => ({
    label: tier.label,
    numeric: true,
    cell: (rate) => {
      const line = rate.lines.find((l) => l.tierId === tier.tierId);
      if (line === undefined) return null;
      const currency = oneCurrency ? '' : ` ${escapeHtml(rate.currencyCode)}`;
      const minimum =
        line.minCharge === null
          ? ''
          : `<br><span style="${MUTED}">min ${escapeHtml(amount(line.minCharge))}</span>`;
      return `${escapeHtml(amount(line.sellPrice))}${currency}${minimum}`;
    },
  }));

  const rateColumns: Column<FreightRateDto>[] = [
    ...(onePol ? [] : [{ label: 'POL', cell: (r: FreightRateDto) => text(r.polName) }]),
    ...(onePod ? [] : [{ label: 'POD', cell: (r: FreightRateDto) => text(r.podName) }]),
    { label: 'Carrier', cell: (r) => text(r.carrierName) },
    ...(oneGoods ? [] : [{ label: 'Goods', cell: (r: FreightRateDto) => text(r.goodsTypeName) }]),
    ...tierColumns,
    { label: 'Transit days', numeric: true, cell: (r) => text(r.transitDays) },
    { label: 'Free days', numeric: true, cell: (r) => text(r.freeDays) },
    { label: 'Route', cell: (r) => text(r.route) },
    { label: 'Valid until', numeric: true, cell: (r) => escapeHtml(day(r.validTo)) },
  ];

  const parts = [
    `<p style="${CAPTION}">${heading} <span style="${MUTED};font-weight:400">· ${escapeHtml(unitNote)}</span></p>`,
    htmlTable(rates, rateColumns),
  ];

  const charges = options.includeLocalCharges
    ? rates.flatMap((rate) => rate.localCharges.map((charge) => ({ rate, charge })))
    : [];
  if (charges.length > 0) {
    type ChargeRow = (typeof charges)[number];
    parts.push(
      `<p style="${CAPTION}">Origin and destination charges</p>`,
      htmlTable<ChargeRow>(charges, [
        ...(onePol ? [] : [{ label: 'POL', cell: ({ rate }: ChargeRow) => text(rate.polName) }]),
        ...(onePod ? [] : [{ label: 'POD', cell: ({ rate }: ChargeRow) => text(rate.podName) }]),
        { label: 'Carrier', cell: ({ rate }) => text(rate.carrierName) },
        {
          label: 'Charge',
          cell: ({ charge }) =>
            escapeHtml(charge.costHeadName) +
            (charge.containerSizeCode === null ? '' : `, ${escapeHtml(charge.containerSizeCode)}`),
        },
        { label: 'At', cell: ({ charge }) => (charge.side === 'POL' ? 'Origin' : 'Destination') },
        { label: 'Unit', cell: ({ charge }) => text(charge.costUnitName) },
        // Charges keep their currency on the figure: they are often in taka
        // beside a freight priced in dollars.
        {
          label: 'Amount',
          numeric: true,
          cell: ({ charge }) =>
            `${escapeHtml(amount(charge.amount))} ${escapeHtml(charge.currencyCode)}`,
        },
      ]),
    );
  }
  return parts.join('\n');
}

/**
 * The whole letter one customer receives, as HTML — what their mail client
 * shows. The screen previews exactly this, so what the sender reads before
 * pressing Send is what the customer gets.
 *
 * Every value is escaped: the message and the signature are typed by people,
 * and a "<" in either must arrive as a "<", not as markup.
 */
export function priceEmailHtml(parts: {
  message: string;
  rates: FreightRateDto[];
  includeLocalCharges: boolean;
  signOff: string;
}): string {
  const paragraphs = parts.message
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin:0 0 12px">${htmlLines(p)}</p>`)
    .join('\n');
  const signOff = parts.signOff.trim();
  return [
    '<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#10243A">',
    `<p style="margin:0 0 12px">${escapeHtml(PRICE_EMAIL_GREETING)}</p>`,
    paragraphs,
    priceEmailRatesHtml(parts.rates, { includeLocalCharges: parts.includeLocalCharges }),
    // The signature closes the letter, with its own "Best regards," if it has one.
    signOff === '' ? '' : `<p style="margin:20px 0 0">${htmlLines(signOff)}</p>`,
    '</div>',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

// ----------------------------------------------------------------------- send

/**
 * What the screen sends: the letter's words, and WHICH rates — never their
 * figures. The server reads the rates back from the Price List and builds the
 * table itself, so the prices a customer receives are the published ones, and
 * a rate that lapsed between ticking and sending is refused rather than sent.
 */
export const priceEmailSendSchema = z.object({
  subject: z.string().trim().min(1, 'Write a subject.').max(200, 'Keep the subject under 200 characters.'),
  message: z.string().trim().min(1, 'Write the message.').max(5000, 'That message is too long.'),
  mode: z.enum(RATE_MODES, { message: 'Choose a freight mode.' }),
  rateIds: z
    .array(z.string().regex(/^\d+$/, 'Unknown rate.'))
    .min(1, 'Tick at least one rate to send.')
    .max(PRICE_EMAIL_MAX_RATES, `At most ${PRICE_EMAIL_MAX_RATES} rates in one email.`),
  includeLocalCharges: z.boolean().default(true),
  recipients: z
    .array(
      z.object({
        customerId: z.string().regex(/^\d+$/, 'Unknown customer.'),
        emails: z.array(z.string().trim().max(320)).min(1).max(50),
      }),
    )
    .min(1, 'Nobody to send to — every customer needs at least one valid address.')
    .max(
      PRICE_EMAIL_MAX_CUSTOMERS,
      `At most ${PRICE_EMAIL_MAX_CUSTOMERS} customers in one send. Narrow the customer filters.`,
    ),
});
export type PriceEmailSendInput = z.infer<typeof priceEmailSendSchema>;

export interface PriceEmailSendResultDto {
  /** Letters written to the outbox — one per customer. */
  queued: number;
}
