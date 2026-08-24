/**
 * Building an agent quotation in a test.
 *
 * A quotation is a tree now — options, each holding charge lines — so the
 * bodies that used to be four fields are a nested literal that every test would
 * otherwise spell out for itself. One builder, so a change to the shape lands
 * in one place instead of eight.
 */

export interface TestLine {
  costHeadId: string;
  currencyId: string;
  quantity?: string;
  unitPrice?: string;
  carrierId?: string;
  containerTypeId?: string;
  costUnitId?: string;
  remarks?: string;
}

export interface TestOption {
  lines?: TestLine[];
  transitDays?: number | '';
  via?: string;
  podFreeDays?: number | '';
  validUntil?: string;
  etd?: string;
  eta?: string;
  remarks?: string;
  carrierId?: string;
}

/** One option holding one line — the smallest quotation the schema accepts. */
export function quoteBody(
  base: { costHeadId: bigint; currencyId: bigint },
  overrides: { unitPrice?: string; quantity?: string; option?: TestOption } = {},
): { options: TestOption[] } {
  const line: TestLine = {
    costHeadId: base.costHeadId.toString(),
    currencyId: base.currencyId.toString(),
    quantity: overrides.quantity ?? '1',
    unitPrice: overrides.unitPrice ?? '1450.50',
  };
  return {
    options: [
      {
        lines: [line],
        transitDays: 22,
        via: 'Singapore',
        podFreeDays: 14,
        validUntil: '2026-09-30',
        remarks: 'Subject to space.',
        ...overrides.option,
      },
    ],
  };
}
