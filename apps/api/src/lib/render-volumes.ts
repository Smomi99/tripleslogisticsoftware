import type { Prisma } from '../generated/prisma/client';

/**
 * "20STD(1) + 40HC(1)", or "200 Kg" — the client's own rendering of what a
 * shipment needs, from the volumes captured on the inquiry.
 *
 * Shared because the Quotation List (§6.7 of the inquiry/quotation module) and
 * the Booking List (§6.2 of the booking module) both draw a Required Container
 * column, and the two showing the same shipment differently is the kind of
 * thing an operator notices and nobody can explain.
 */
export function renderVolumes(
  volumes: {
    quantity: number | null;
    cbm: Prisma.Decimal | null;
    weightKg: Prisma.Decimal | null;
    containerSizeNote: string | null;
    containerSize: { name: string } | null;
  }[],
): string {
  /*
    Trailing zeros go only AFTER a decimal point.

    The original stripped them unconditionally, so an inquiry for 200 Kg
    displayed as "2 Kg" and 1000 Kg as "1 Kg" — on the Live Inquiry list,
    the Quotation List and every booking screen. Found 2026-09-14 while
    writing the fallback test for renderRequiredContainer.
  */
  const trim = (value: Prisma.Decimal) =>
    value
      .toString()
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  const parts = volumes
    .map((v) => {
      const box = v.containerSize?.name ?? v.containerSizeNote;
      if (box !== null && box !== undefined && box !== '') {
        return v.quantity === null ? box : `${box}(${v.quantity})`;
      }
      if (v.weightKg !== null) return `${trim(v.weightKg)} Kg`;
      if (v.cbm !== null) return `${trim(v.cbm)} CBM`;
      return null;
    })
    .filter((p): p is string => p !== null);
  return parts.length === 0 ? '—' : parts.join(' + ');
}

/**
 * "Required Container" downstream of a quotation.
 *
 * The inquiry is what the customer ASKED for, and it is all that exists on
 * the Live Inquiry list. Once a quotation has been priced and accepted, the
 * agreed containers are its own lines — and that is what every screen after
 * it should show, because that is what the booking was made against and what
 * MODULE_CLP.md §4.4 reconciles the container plan to.
 *
 * Reported 2026-09-14: a quotation priced 1x20STD + 1x40STD while the inquiry
 * held a single LCL row with the free-text note "20std" and no quantity. Every
 * screen from the quotation list to the load plan read the inquiry and showed
 * "20std", so the second container was invisible all the way to the CFS.
 *
 * The count per size is the LARGEST quantity charged against it, not the sum.
 * Charges are levied per container, so a 20STD carrying ocean freight, THC and
 * a seal fee appears on three lines of one container — adding them would
 * report three boxes.
 */
export function renderRequiredContainer(
  lines: { containerSizeName: string | null; quantity: Prisma.Decimal | null }[],
  volumes: Parameters<typeof renderVolumes>[0],
): string {
  // First-seen order, which is the order somebody built the quotation in.
  const byName = new Map<string, number>();
  for (const line of lines) {
    const name = line.containerSizeName;
    if (name === null || name === '') continue;
    const qty = line.quantity === null ? 1 : Math.round(Number(line.quantity));
    if (qty <= 0) continue;
    byName.set(name, Math.max(byName.get(name) ?? 0, qty));
  }

  if (byName.size === 0) return renderVolumes(volumes);
  return [...byName].map(([name, qty]) => `${name}(${qty})`).join(' + ');
}
