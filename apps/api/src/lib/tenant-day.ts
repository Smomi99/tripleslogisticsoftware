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
  const tenant = await db.tenant.findFirst({
    where: { id: tenantId },
    select: { timezone: true },
  });

  let format: Intl.DateTimeFormat;
  try {
    // en-CA formats as YYYY-MM-DD, the shape every other date here prints in.
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: tenant?.timezone ?? 'Asia/Dhaka',
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
