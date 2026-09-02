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
  const trim = (value: Prisma.Decimal) => value.toString().replace(/\.?0+$/, '');
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
