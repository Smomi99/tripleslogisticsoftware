import type { EfrGroupTag } from '@ff/shared';

/**
 * The EFR No column (CR-005) — on the booking, worklist and container plan
 * tables alike.
 *
 * Each number stays whole: a dense table squeezes this column, and "EFR-" on
 * one line with "703" on the next is exactly the misreading §12's mono column
 * exists to prevent. A booking received under two EFRs shows one per line.
 * Before the cargo is received there is no EFR, and the cell says so.
 *
 * With a group tag, a line underneath says what happens to the booking's
 * advise — "1 advise with 3B, 3E" — beside a dot coloured by its group, so the
 * bookings that will share one Shipment Advise can be picked out down the
 * table without opening anything.
 */

const GROUP_COLOURS = [
  'var(--color-group-1)',
  'var(--color-group-2)',
  'var(--color-group-3)',
  'var(--color-group-4)',
  'var(--color-group-5)',
  'var(--color-group-6)',
];

/**
 * One colour per group, handed out in the order the groups appear down the
 * table — so two groups on one page never share a colour (six before one
 * repeats). A hash would be the same on every page, and would also put two
 * neighbouring groups on one colour, which is the confusion this is for.
 */
export function groupColours(rows: { efrGroup: EfrGroupTag | null }[]): Map<string, string> {
  const colours = new Map<string, string>();
  for (const row of rows) {
    const key = row.efrGroup?.groupKey;
    if (key == null || colours.has(key)) continue;
    colours.set(key, GROUP_COLOURS[colours.size % GROUP_COLOURS.length]!);
  }
  return colours;
}

/**
 * Booking numbers without the part they all share — DEMO-EFR-3B reads as 3B
 * beside DEMO-EFR-3A. Cut at the last "-" of the common start, so a real
 * number like BKG-2026-000124 keeps its serial whole.
 */
function shortCodes(codes: string[], all: string[]): string[] {
  let prefix = all[0] ?? '';
  for (const code of all) {
    while (!code.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const cut = prefix.lastIndexOf('-') + 1;
  return codes.map((code) => code.slice(cut) || code);
}

function describe(group: EfrGroupTag, code: string): { text: string; title: string } {
  const all = [code, ...group.withBookings];
  const others = shortCodes(group.withBookings, all).join(', ');
  const full = group.withBookings.join(', ');
  switch (group.kind) {
    case 'SHARED':
      return { text: `1 advise with ${others}`, title: `One Shipment Advise and one BL with ${full}` };
    case 'ON_ADVISE':
      return group.withBookings.length === 0
        ? { text: `On ${group.adviseCode}`, title: `On ${group.adviseCode}` }
        : { text: `${group.adviseCode} with ${others}`, title: `${group.adviseCode} covers this booking and ${full}` };
    case 'JOINS':
      return {
        text: `Goes on ${group.adviseCode} (draft)`,
        title: `Its EFR is on ${group.adviseCode}, still a draft, with ${full}. Add it there.`,
      };
    case 'LATE':
      return {
        text: `${group.adviseCode} already sent — reissue to add`,
        title: `${group.adviseCode} was sent without it. Cancel and make the advise again to include it; that gives a new House BL number.`,
      };
    case 'CHECK':
      return {
        text: `Same EFR — check ${group.reason}`,
        title: `Same EFR, but a different ${group.reason}. Tick it on the Shipment Advise screen if it belongs on the same BL.`,
      };
    case 'OWN':
      return { text: `Own advise — ${group.reason}`, title: `Same EFR, but an advise of its own: ${group.reason}.` };
  }
}

function Marker({ group, colour }: { group: EfrGroupTag; colour: string | undefined }) {
  const base = 'mt-[5px] inline-block size-2 shrink-0 rounded-full';
  if (group.kind === 'OWN' || colour === undefined) {
    return <span aria-hidden className={`${base} border border-steel`} />;
  }
  // Half filled: belongs with the group, but not on its advise yet.
  if (group.kind === 'CHECK' || group.kind === 'LATE') {
    return (
      <span
        aria-hidden
        className={base}
        style={{ border: `1px solid ${colour}`, background: `linear-gradient(90deg, ${colour} 50%, transparent 50%)` }}
      />
    );
  }
  return <span aria-hidden className={base} style={{ background: colour }} />;
}

export function EfrNos({
  values,
  code,
  group,
  colours,
}: {
  values: string[];
  /** The row's booking number, so the group line can shorten the others'. */
  code?: string;
  group?: EfrGroupTag | null;
  /** From groupColours(rows) — the same map for every row of the table. */
  colours?: Map<string, string>;
}) {
  if (values.length === 0) return <span className="text-steel">—</span>;
  const tag = group == null || code === undefined ? null : describe(group, code);
  return (
    <span className="flex flex-col">
      {values.map((efr) => (
        <span key={efr} className="whitespace-nowrap">
          {efr}
        </span>
      ))}
      {group != null && tag !== null && (
        <span className="mt-0.5 flex min-w-36 items-start gap-1.5 font-sans text-cell text-steel" title={tag.title}>
          <Marker group={group} colour={group.groupKey === null ? undefined : colours?.get(group.groupKey)} />
          <span>{tag.text}</span>
        </span>
      )}
    </span>
  );
}
