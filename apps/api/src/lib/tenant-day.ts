import type { TenantDb } from './tenant-client';

/**
 * A calendar day as the workspace reads it.
 *
 * CLAUDE.md §9: stored UTC, shown in the workspace's zone. It matters most on a
 * printed document — a bill issued at 01:00 in Dhaka is still 19:00 the day
 * before in UTC, and the date of issue on an original is not something to be a
 * day out on.
 */
export async function tenantDayOf(
  db: TenantDb,
  tenantId: bigint,
): Promise<(at: Date) => string> {
  return dayIn(await tenantZoneOf(db, tenantId));
}

/** The workspace's time zone, Asia/Dhaka where none is set. */
export async function tenantZoneOf(db: TenantDb, tenantId: bigint): Promise<string> {
  const tenant = await db.tenant.findFirst({
    where: { id: tenantId },
    select: { timezone: true },
  });
  return tenant?.timezone ?? 'Asia/Dhaka';
}

/** The calendar day a moment falls on in `zone`, as YYYY-MM-DD. */
export function dayIn(zone: string): (at: Date) => string {
  let format: Intl.DateTimeFormat;
  try {
    // en-CA formats as YYYY-MM-DD, the shape every other date here prints in.
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    // A zone name the runtime does not know: fall back to UTC rather than fail
    // the print over it.
    return (at) => at.toISOString().slice(0, 10);
  }
  return (at) => format.format(at);
}

/**
 * The first moment of a calendar day in `zone` — the other way round from
 * `dayIn`, for a filter on a timestamp column ("booked between 1 and 5
 * November" means Dhaka's 1 November, which began at 18:00 UTC on the 31st).
 *
 * Read at the day's own offset, so a zone that changes its clocks lands on the
 * right hour either side of the change. An unknown zone reads as UTC, the same
 * fallback as `dayIn`.
 */
export function startOfDayIn(day: string, zone: string): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  let parts: Intl.DateTimeFormat;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return new Date(midnightUtc);
  }
  // How far ahead of UTC the zone's clocks read at `at`.
  const offsetAt = (at: number): number => {
    const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p['year']),
      Number(p['month']) - 1,
      Number(p['day']),
      Number(p['hour']),
      Number(p['minute']),
      Number(p['second']),
    );
    return asUtc - Math.floor(at / 1000) * 1000;
  };
  const guess = midnightUtc - offsetAt(midnightUtc);
  return new Date(midnightUtc - offsetAt(guess));
}

/** The calendar day after `day`, as YYYY-MM-DD. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
