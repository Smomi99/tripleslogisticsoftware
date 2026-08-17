import type { TenantDb } from './tenant-client';

/**
 * The Inquiry No (docs/MODULE_PURCHASE_SALES.md §9 Q9, answered).
 *
 * `INQ-2026-000001` — per tenant, per year, restarting each January.
 *
 * lib/codes' nextCode cannot produce this: it does MAX+1 over a plain numeric
 * suffix, and `INQ-2026-000001` has a year in the middle, so its regex never
 * matches and every inquiry would come out as INQ-1. Hence a generator of its
 * own rather than a parameter on that one.
 *
 * Same concurrency story as nextCode: two callers racing compute the same
 * number, and UNIQUE(tenant_id, code) is the real guarantee — the loser gets a
 * unique violation and retries. Correctness rests on the constraint, not on
 * this winning the race.
 */

export const INQUIRY_PREFIX = 'INQ';
/** Six digits, as §3.3 writes it. Grows past six rather than wrapping. */
const SEQUENCE_WIDTH = 6;

export function formatInquiryNo(year: number, sequence: number): string {
  return `${INQUIRY_PREFIX}-${year}-${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`;
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

/** The year an inquiry belongs to — its own date, not today's. */
export function seriesYearOf(inquiryDate: Date): number {
  return inquiryDate.getUTCFullYear();
}
