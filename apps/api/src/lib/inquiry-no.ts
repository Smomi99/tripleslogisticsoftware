import type { TenantDb } from './tenant-client';

/**
 * Yearly document numbers — `INQ-2026-000001`, `QTN-2026-000001`.
 *
 * Per tenant, per year, restarting each January (MODULE_PURCHASE_SALES §9 Q9,
 * and §4.4 of the inquiry/quotation module, which writes the quotation the same
 * way).
 *
 * lib/codes' nextCode cannot produce these: it does MAX+1 over a plain numeric
 * suffix, and `INQ-2026-000001` has a year in the middle, so its regex never
 * matches and every document would come out as INQ-1. Hence a generator of its
 * own rather than a parameter on that one.
 *
 * Same concurrency story as nextCode: two callers racing compute the same
 * number, and the table's UNIQUE constraint is the real guarantee — the loser
 * gets a unique violation and retries. Correctness rests on the constraint, not
 * on this winning the race.
 */

export const INQUIRY_PREFIX = 'INQ';
export const QUOTATION_PREFIX = 'QTN';
/** The booking number, BKG-2026-000001 (MODULE_BOOKING_CARGO.md §4.1). */
export const BOOKING_PREFIX = 'BKG';
/** The shipping order, SO-2026-000001 (MODULE_BOOKING_CARGO.md §4.3). */
export const SHIPPING_ORDER_PREFIX = 'SO';
/** The cargo receipt, CR-2026-000001 (MODULE_BOOKING_CARGO.md §4.4). */
export const CARGO_RECEIPT_PREFIX = 'CR';
/** Six digits, as §3.3 writes it. Grows past six rather than wrapping. */
const SEQUENCE_WIDTH = 6;

export function formatDocumentNo(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`;
}

export function formatInquiryNo(year: number, sequence: number): string {
  return formatDocumentNo(INQUIRY_PREFIX, year, sequence);
}

export function formatQuotationNo(year: number, sequence: number): string {
  return formatDocumentNo(QUOTATION_PREFIX, year, sequence);
}

export async function nextInquiryNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const pattern = `${INQUIRY_PREFIX}-${year}-%`;

  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM inquiry
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${pattern}
  `;

  const current = rows[0]?.max_seq ?? 0;
  return formatInquiryNo(year, current + 1);
}

/**
 * The next quotation number.
 *
 * DISTINCT on code rather than MAX over every row: a quotation number is shared
 * by all its revisions (§5.3 rule 8), so counting rows would skip a number
 * every time somebody revised one. The highest number issued is what matters,
 * not how many documents carry it.
 */
export async function nextQuotationNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const pattern = `${QUOTATION_PREFIX}-${year}-%`;

  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM quotation
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${pattern}
  `;

  const current = rows[0]?.max_seq ?? 0;
  return formatQuotationNo(year, current + 1);
}

export function formatBookingNo(year: number, sequence: number): string {
  return formatDocumentNo(BOOKING_PREFIX, year, sequence);
}

/**
 * The next booking number.
 *
 * MAX over every row, unlike the quotation's DISTINCT: a booking number is not
 * shared by revisions, so each row is its own document. §9 Q10 asked whether
 * Sea and Air want separate series; unanswered, so one series covers both —
 * which is also the harder thing to undo in the wrong direction, since two
 * series can be split out of one but not merged back.
 */
export async function nextBookingNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const pattern = `${BOOKING_PREFIX}-${year}-%`;

  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM shipment
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${pattern}
  `;

  const current = rows[0]?.max_seq ?? 0;
  return formatBookingNo(year, current + 1);
}

export function formatShippingOrderNo(year: number, sequence: number): string {
  return formatDocumentNo(SHIPPING_ORDER_PREFIX, year, sequence);
}

/**
 * The next shipping order number.
 *
 * §5.4 rule 2: numbered on issue, never on draft, and a cancelled one keeps its
 * number forever — so MAX over every row including the cancelled ones. Reusing
 * a number a warehouse has already seen is the one thing this must not do.
 */
export async function nextShippingOrderNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const pattern = `${SHIPPING_ORDER_PREFIX}-${year}-%`;

  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM shipping_order
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${pattern}
  `;

  const current = rows[0]?.max_seq ?? 0;
  return formatShippingOrderNo(year, current + 1);
}

export function formatCargoReceiptNo(year: number, sequence: number): string {
  return formatDocumentNo(CARGO_RECEIPT_PREFIX, year, sequence);
}

/**
 * The next cargo receipt number.
 *
 * §5.5 rule 4: "A booking may have several receipts; each is numbered and
 * kept." The number is per workspace per year, while receipt_seq is that
 * receipt's place in ITS booking — two different counts, and conflating them
 * would make the second receipt on the tenth booking read as CR-…-000002.
 */
export async function nextCargoReceiptNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const pattern = `${CARGO_RECEIPT_PREFIX}-${year}-%`;

  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM cargo_receipt
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${pattern}
  `;

  const current = rows[0]?.max_seq ?? 0;
  return formatCargoReceiptNo(year, current + 1);
}

/** The year a document belongs to — its own date, not today's. */
export function seriesYearOf(documentDate: Date): number {
  return documentDate.getUTCFullYear();
}

// ---------------------------------------------------------------------------
// Documentation module (docs/MODULE_DOCUMENTATION.md)
// ---------------------------------------------------------------------------

/** The shipment advise, SA-2026-000001. */
export const SHIPMENT_ADVISE_PREFIX = 'SA';
/** The BL draft, BLD-2026-000001. */
export const BL_DRAFT_PREFIX = 'BLD';

export function formatShipmentAdviseNo(year: number, sequence: number): string {
  return formatDocumentNo(SHIPMENT_ADVISE_PREFIX, year, sequence);
}

export async function nextShipmentAdviseNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const pattern = `${SHIPMENT_ADVISE_PREFIX}-${year}-%`;
  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM shipment_advise
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${pattern}
  `;
  return formatShipmentAdviseNo(year, (rows[0]?.max_seq ?? 0) + 1);
}

export function formatBlDraftNo(year: number, sequence: number): string {
  return formatDocumentNo(BL_DRAFT_PREFIX, year, sequence);
}

/**
 * The next BL draft number, counted over the whole workspace.
 *
 * Through a SECURITY DEFINER function rather than a MAX() here, because §2.4
 * lets a CUSTOMER create one and RLS narrows what their session can see to
 * their own drafts. Counting those gave the first customer to draft anything
 * BLD-<year>-000001, which the forwarder had already issued — and the insert
 * died on the unique constraint (found by demo:docs, fixed in
 * 20260920140000).
 *
 * The rule, for whatever is added to the portal next: a per-tenant sequence
 * computed with MAX() is wrong in any session that cannot see every row.
 */
export async function nextBlDraftNo(
  db: TenantDb,
  tenantId: bigint,
  year: number,
): Promise<string> {
  const rows = await db.$queryRaw<{ seq: number }[]>`
    SELECT app_next_bl_draft_seq(${tenantId}, ${year}) AS seq
  `;
  return formatBlDraftNo(year, rows[0]?.seq ?? 1);
}

/**
 * The House BL number — the one number on these screens the customer quotes
 * back at you, and the only one the client gave a format for.
 *
 * Cell Q14 of the sea advise sheet reads `TSL+26+09+001`: a company prefix, a
 * two-digit year, a two-digit month, and a serial that restarts each month.
 * This reproduces it as `TSL2609001`.
 *
 * **The prefix is open question 3** (MODULE_DOCUMENTATION §12). `TSL` is this
 * client's own initials, and nothing in the spec says where a second workspace
 * would get its own — so it is derived from the tenant slug until they answer,
 * and changing it later means changing this function and nothing else.
 *
 * Numbers already issued are never recomputed: the serial is MAX+1 over every
 * row of that month INCLUDING cancelled ones, for the same reason a cancelled
 * shipping order keeps its number forever. Handing a number a customer has
 * already seen to a different shipment is the one thing this must not do.
 */
export function houseBlPrefixFor(tenantSlug: string): string {
  const letters = tenantSlug.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return (letters.slice(0, 3) || 'HBL').padEnd(3, 'X');
}

export function formatHouseBlNo(prefix: string, date: Date, sequence: number): string {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}${yy}${mm}${String(sequence).padStart(3, '0')}`;
}

export async function nextHouseBlNo(
  db: TenantDb,
  tenantId: bigint,
  tenantSlug: string,
  date: Date,
): Promise<string> {
  const prefix = houseBlPrefixFor(tenantSlug);
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const stem = `${prefix}${yy}${mm}`;

  // The serial is whatever follows the fixed 7-character stem, so it grows
  // past 999 rather than wrapping. The regex keeps a hand-typed or imported
  // number that does not fit the format out of the MAX entirely.
  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX(right(house_bl_no, length(house_bl_no) - ${stem.length})::int) AS max_seq
      FROM shipment_advise
     WHERE tenant_id = ${tenantId}
       AND house_bl_no ~ ${`^${stem}[0-9]+$`}
  `;
  return formatHouseBlNo(prefix, date, (rows[0]?.max_seq ?? 0) + 1);
}
