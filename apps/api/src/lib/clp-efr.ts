import type { TenantDb } from './tenant-client';

/**
 * The EFR numbers cargo arrived under — one definition, for every screen and
 * document that prints them.
 *
 * The client's loading-type sheet (2026-09-16) puts an EFR No on every PO row
 * of a container plan: one EFR for an FCL booking, one per exporter's booking
 * in an LCL box. The number itself is recorded where the wireframe put it —
 * `cargo_receipt.efr_no`, typed when the goods are received at CFS — so a
 * cargo line's EFR is read from the receipts its cartons actually came in on.
 *
 * Nothing is copied onto the plan. That reproduces every table on the sheet
 * without a column that could disagree with the receipt, and it is also why no
 * count is enforced: a booking delivered on two receipts has two EFRs, which
 * is what the sheet's Consol box table shows.
 *
 * Only cartons that are genuinely in count: an ACCEPTED line on a CONFIRMED,
 * undeleted receipt — the same rule the pool is drawn from (MODULE_CLP.md
 * §2.4). A declined delivery's EFR is not the EFR of anything in the box.
 */
export async function efrNosOfCargoLines(
  db: TenantDb,
  cargoLineIds: bigint[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (cargoLineIds.length === 0) return found;

  const rows = await db.cargoReceiptLine.findMany({
    where: {
      shipmentCargoLineId: { in: cargoLineIds },
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { status: 'CONFIRMED', deletedAt: null },
    },
    // Delivery order, so "EFR-001, EFR-002" reads the way the cargo arrived.
    orderBy: [{ receipt: { receiptSeq: 'asc' } }, { id: 'asc' }],
    select: { shipmentCargoLineId: true, receipt: { select: { efrNo: true } } },
  });

  for (const row of rows) {
    const efr = row.receipt.efrNo?.trim() ?? '';
    if (efr === '') continue;
    const key = row.shipmentCargoLineId.toString();
    const list = found.get(key) ?? [];
    if (!list.includes(efr)) list.push(efr);
    found.set(key, list);
  }
  return found;
}

/** Several lines' EFRs as one list, first-seen order, no repeats. */
export function mergeEfrNos(lists: (string[] | undefined)[]): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const efr of list ?? []) if (!merged.includes(efr)) merged.push(efr);
  }
  return merged;
}
