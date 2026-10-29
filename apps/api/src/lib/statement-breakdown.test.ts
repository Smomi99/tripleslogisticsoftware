import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client';
import { Breakdown, type ChartAccount, LISTED_VOUCHERS, type VoucherRow } from './statement-breakdown';

/** The popup's rows: the oldest vouchers summed into one once there are too many to list. */

const bank: ChartAccount = { id: 1n, accountType: 'ASSET', systemKey: null, parentKey: 'ASSET.BANK', label: 'Bank › City Bank' };
const head = { line: 'BANK', label: 'Cash at Bank', currencyCode: 'BDT', basis: null, column: 'AS_AT', period: { from: null, to: '2026-10-31' }, notes: [] };

function vouchers(n: number): VoucherRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: BigInt(i + 1),
    code: `RV-2026-${String(i + 1).padStart(6, '0')}`,
    kind: 'INCOME' as const,
    // One a day from the start of 2025, so the order is the date's.
    entryDate: new Date(Date.UTC(2025, 0, 1 + i)),
    description: null,
    accountId: 1n,
    partyName: null,
    debit: new Prisma.Decimal(i + 1),
    credit: new Prisma.Decimal(0),
  }));
}

describe('a breakdown with more vouchers than it lists', () => {
  it('brings the oldest forward as one row, and keeps every subtotal whole', () => {
    const out = new Breakdown();
    out.addVouchers(vouchers(LISTED_VOUCHERS + 2), new Map([['1', bank]]), () => true);
    const total = ((LISTED_VOUCHERS + 2) * (LISTED_VOUCHERS + 3)) / 2;
    const dto = out.dto({ ...head, total: new Prisma.Decimal(total) });

    expect(dto.entries).toHaveLength(LISTED_VOUCHERS + 1);
    expect(dto.entries[0]).toMatchObject({ source: 'EARLIER', date: '2025-01-02', reference: '2 earlier voucher entries', amount: '3.00' });
    expect(dto.entries[1]).toMatchObject({ source: 'VOUCHER', documentCode: 'RV-2026-000003', amount: '3.00' });
    expect(dto.entries.reduce((sum, e) => sum + Number(e.amount), 0).toFixed(2)).toBe(dto.total);
    expect(dto.groups).toEqual([{ label: 'Bank › City Bank', count: LISTED_VOUCHERS + 2, amount: `${total}.00` }]);
  });

  it('lists them all when they fit', () => {
    const out = new Breakdown();
    out.addVouchers(vouchers(3), new Map([['1', bank]]), () => false);
    const dto = out.dto({ ...head, total: new Prisma.Decimal(-6) });
    expect(dto.entries.map((e) => [e.source, e.amount])).toEqual([
      ['VOUCHER', '-1.00'],
      ['VOUCHER', '-2.00'],
      ['VOUCHER', '-3.00'],
    ]);
  });
});
