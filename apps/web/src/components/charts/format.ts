/**
 * Number and month formatting for charts. Values arrive from the server
 * already counted; nothing here adds anything up.
 */

/** 1284 -> "1,284". */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** 4_200_000 -> "4.2M", for axis ticks and headline figures where space is short. */
export function compact(n: number): string {
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

/** A full amount for a tooltip or table: "1,450,000". Whole units — the overview is not a ledger. */
export function whole(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** "2026-10" -> "Oct", or "Jan ’27" where a new year starts so the axis says which year. */
export function monthShort(month: string, isFirst = false): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const name = new Date(Date.UTC(year, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return m === 1 || isFirst ? `${name} ’${String(year).slice(2)}` : name;
}

/** "2026-10" -> "October 2026". */
export function monthLong(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(day: string): [number, number, number] {
  return day.split('-').map(Number) as [number, number, number];
}

/** "2026-10-05" -> "5 Oct". */
export function dayShort(day: string): string {
  const [, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "2026-10-05" -> "5 Oct 2026". */
export function dayLong(day: string): string {
  const [y] = parts(day);
  return `${dayShort(day)} ${y}`;
}

/**
 * A range as people say it: "31 Oct 2026", "1–31 Oct 2026",
 * "1 May – 31 Oct 2026", "15 Dec 2025 – 10 Jan 2026".
 */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return dayLong(from);
  const [fy, fm, fd] = parts(from);
  const [ty, tm] = parts(to);
  if (fy === ty && fm === tm) return `${fd}–${dayLong(to)}`;
  if (fy === ty) return `${dayShort(from)} – ${dayLong(to)}`;
  return `${dayLong(from)} – ${dayLong(to)}`;
}

/** A column's labels, whether it is a day (YYYY-MM-DD) or a month (YYYY-MM). */
export function bucketLabels(bucket: string, isFirst: boolean): { label: string; title: string } {
  return bucket.length === 10
    ? { label: dayShort(bucket), title: dayLong(bucket) }
    : { label: monthShort(bucket, isFirst), title: monthLong(bucket) };
}
