import { Prisma, type PrismaClient } from '../generated/prisma/client';

/**
 * The nightly expiry job (docs/MODULE_PURCHASE_SALES.md §4 rule 3).
 *
 * "A nightly job flips status to EXPIRED where valid_to < today."
 *
 * Deliberately NOT tenant-scoped: this is platform maintenance, not a request.
 * It runs as the owner role across every workspace at once, which is why it
 * takes a plain client rather than going through withTenant — a per-tenant loop
 * would need a tenant list, and one missed workspace means a lane that quietly
 * stays quotable after it lapsed.
 *
 * A single UPDATE rather than read-then-write, so a rate created between the
 * two cannot slip through, and so the whole thing is one statement no matter
 * how many rates exist.
 *
 * It only touches PUBLISHED rows. A DRAFT that lapsed was never quotable, and
 * expiring it would hide it from the buyer who is still working on it.
 */
export interface ExpiryResult {
  expired: number;
  /** The date the job treated as "today", in UTC. */
  asOf: string;
}

export async function expireLapsedRates(
  db: Pick<PrismaClient, '$executeRaw' | '$queryRaw'>,
  asOf: Date = new Date(),
): Promise<ExpiryResult> {
  const today = new Date(asOf.toISOString().slice(0, 10));

  const expired = await db.$executeRaw`
    UPDATE freight_rate
       SET status = 'EXPIRED', updated_at = now()
     WHERE status = 'PUBLISHED'
       AND deleted_at IS NULL
       AND valid_to < ${today}::date
  `;

  return { expired, asOf: today.toISOString().slice(0, 10) };
}

/**
 * Rates lapsing within the warning window, so the pricing team can re-buy
 * before the gap (§4 rule 3's `--signal` dot).
 *
 * The list screens compute this per row from validTo, which is enough to render
 * a dot. This is the other half — a digest the job can report, or a future
 * notification can send, without every screen re-deriving it.
 */
export async function ratesExpiringSoon(
  db: Pick<PrismaClient, '$queryRaw'>,
  withinDays: number,
  asOf: Date = new Date(),
): Promise<{ tenantId: bigint; code: string; validTo: string }[]> {
  const today = new Date(asOf.toISOString().slice(0, 10));

  const rows = await db.$queryRaw<{ tenant_id: bigint; code: string; valid_to: Date }[]>`
    SELECT tenant_id, code, valid_to
      FROM freight_rate
     WHERE status = 'PUBLISHED'
       AND deleted_at IS NULL
       AND valid_to >= ${today}::date
       AND valid_to <= (${today}::date + ${Prisma.raw(String(Math.trunc(withinDays)))} * INTERVAL '1 day')
     ORDER BY valid_to ASC, tenant_id ASC
  `;

  return rows.map((row) => ({
    tenantId: row.tenant_id,
    code: row.code,
    validTo: row.valid_to.toISOString().slice(0, 10),
  }));
}
