import type { RatePriceChangeDto } from '@ff/shared';

import { isoCurrency } from './currency-label';
import { Prisma } from '../generated/prisma/client';
import type { TenantDb } from './tenant-client';

/**
 * How a price on the Price drawer got where it is (client, 2026-10-26).
 *
 * "The price" is the lane's, not the row's: this carrier, this POL and POD,
 * this mode and goods type, this container size or weight break — across
 * every rate keyed for it. A lane re-bought next month is a new rate, and its
 * figure is the next entry in the same story.
 *
 * Read from audit_log, as agent-quote-history is. Rates are edited in place
 * now (freight-rate.route's Update), and the Phase 0 trigger records every
 * write to freight_rate_line with sell_price already computed — the BEFORE
 * trigger sets it, the AFTER trigger copies it. A second history table would
 * be a second thing to keep correct.
 */

interface TrailRow {
  record_id: bigint;
  action: string;
  actor_type: string;
  changed_by: bigint | null;
  created_at: Date;
  /** Read with ->> so the figure arrives as Postgres wrote it, not as a JS float. */
  old_sell: string | null;
  new_sell: string | null;
}

interface Point {
  at: Date;
  /** Tie-break for two entries in the same instant: the trail's own order. */
  seq: number;
  rateCode: string;
  currencyCode: string;
  sellPrice: Prisma.Decimal;
  changedBy: string | null;
}

/**
 * Newest first, at most `limit` entries. Empty when the line is not this
 * workspace's — the tenant client and RLS both see to that.
 */
export async function ratePriceHistory(
  db: TenantDb,
  tenantId: bigint,
  rateLineId: bigint,
  limit = 30,
): Promise<RatePriceChangeDto[]> {
  const line = await db.freightRateLine.findFirst({
    where: { id: rateLineId, deletedAt: null },
    select: {
      tierId: true,
      rate: {
        select: { mode: true, polId: true, podId: true, carrierId: true, goodsTypeId: true },
      },
    },
  });
  if (line === null) return [];

  const lines = await db.freightRateLine.findMany({
    where: {
      tierId: line.tierId,
      deletedAt: null,
      rate: { ...line.rate, deletedAt: null },
    },
    select: {
      id: true,
      createdAt: true,
      sellPrice: true,
      rate: { select: { code: true, currency: { select: { currency: true } } } },
    },
  });
  if (lines.length === 0) return [];

  const ids = lines.map((l) => l.id);
  const trail = await db.$queryRaw<TrailRow[]>`
    SELECT record_id, action::text AS action, actor_type::text AS actor_type,
           changed_by, created_at,
           old_values ->> 'sell_price' AS old_sell,
           new_values ->> 'sell_price' AS new_sell
      FROM audit_log
     WHERE tenant_id = ${tenantId}
       AND table_name = 'freight_rate_line'
       AND record_id IN (${Prisma.join(ids)})
       AND action IN ('CREATE', 'UPDATE')
     ORDER BY id ASC`;

  // Only USER actors are in the user table; a platform user or the system is
  // reported as nobody rather than as whichever staff member shares the id.
  const userIds = [
    ...new Set(
      trail
        .filter((r) => r.actor_type === 'USER' && r.changed_by !== null)
        .map((r) => r.changed_by!.toString()),
    ),
  ].map((id) => BigInt(id));
  const users =
    userIds.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true },
        });
  const username = new Map(users.map((u) => [u.id.toString(), u.username]));

  const trailByLine = new Map<string, TrailRow[]>();
  trail.forEach((row) => {
    const key = row.record_id.toString();
    trailByLine.set(key, [...(trailByLine.get(key) ?? []), row]);
  });

  const points: Point[] = [];
  let seq = 0;
  for (const l of lines) {
    const base = { rateCode: l.rate.code, currencyCode: isoCurrency(l.rate.currency.currency) };
    const rows = trailByLine.get(l.id.toString()) ?? [];

    /*
     * A line keyed before the trigger existed, or by a script with no tenant
     * in scope, has no CREATE. Its starting figure is still knowable: what the
     * first recorded edit changed it FROM, or failing any edit, what it is now.
     */
    if (!rows.some((r) => r.action === 'CREATE')) {
      const first = rows.find((r) => r.old_sell !== null)?.old_sell;
      const start = first ?? l.sellPrice?.toString() ?? null;
      if (start !== null) {
        points.push({
          ...base,
          at: l.createdAt,
          seq: seq++,
          sellPrice: new Prisma.Decimal(start),
          changedBy: null,
        });
      }
    }

    for (const row of rows) {
      if (row.new_sell === null) continue;
      const after = new Prisma.Decimal(row.new_sell);
      // An edit that moved the buy price and the margin by the same amount, or
      // only touched the remarks, did not move the price.
      if (row.action === 'UPDATE' && row.old_sell !== null && after.equals(row.old_sell)) {
        continue;
      }
      points.push({
        ...base,
        at: row.created_at,
        seq: seq++,
        sellPrice: after,
        changedBy:
          row.actor_type === 'USER' && row.changed_by !== null
            ? (username.get(row.changed_by.toString()) ?? null)
            : null,
      });
    }
  }

  points.sort((a, b) => a.at.getTime() - b.at.getTime() || a.seq - b.seq);

  const entries = points.map((point, index): RatePriceChangeDto => {
    const previous = index === 0 ? undefined : points[index - 1];
    return {
      at: point.at.toISOString(),
      rateCode: point.rateCode,
      currencyCode: point.currencyCode,
      sellPrice: point.sellPrice.toFixed(4),
      change:
        previous === undefined || previous.currencyCode !== point.currencyCode
          ? null
          : point.sellPrice.minus(previous.sellPrice).toFixed(4),
      changedBy: point.changedBy,
    };
  });

  return entries.reverse().slice(0, limit);
}
