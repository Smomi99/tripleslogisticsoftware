/**
 * The EFR No column (CR-005) — on the booking, worklist and container plan
 * tables alike.
 *
 * Each number stays whole: a dense table squeezes this column, and "EFR-" on
 * one line with "703" on the next is exactly the misreading §12's mono column
 * exists to prevent. A booking received under two EFRs shows one per line.
 * Before the cargo is received there is no EFR, and the cell says so.
 */
export function EfrNos({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="text-steel">—</span>;
  return (
    <span className="flex flex-col">
      {values.map((efr) => (
        <span key={efr} className="whitespace-nowrap">
          {efr}
        </span>
      ))}
    </span>
  );
}
