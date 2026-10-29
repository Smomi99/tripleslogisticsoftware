import {
  type JournalEntryKind,
  MONEY_LEDGER_KEYS,
  type StatementBreakdownDto,
  type StatementEntryDto,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { PARTY_JOINS, PARTY_NAME } from './income-statement';
import type { TenantDb } from './tenant-client';

/**
 * What the Balance Sheet's and the Cash Flow Statement's breakdowns share
 * (client, 2026-10-28: "when I click on the amount it will pop up the
 * breakdown, so that I can track"). The Income Statement's breakdown is the
 * pattern: one row per document, subtotals by where the figure came from, and
 * a total that is the statement's own figure.
 */

const ZERO = new Prisma.Decimal(0);
const dec = (v: unknown): Prisma.Decimal => new Prisma.Decimal(v === null || v === undefined ? 0 : String(v));
const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * At most this many vouchers are listed; older ones are summed into one row.
 * A balance is everything since the books began, which for Cash at Bank is
 * every voucher there has ever been.
 */
export const LISTED_VOUCHERS = 500;

// ---------------------------------------------------------------- cash

const MONEY = Prisma.join(MONEY_LEDGER_KEYS.map((k) => Prisma.sql`${k}`));

/**
 * A line on a Cash or Bank sub ledger (or on the ledger itself). COALESCEd: a
 * workspace's own account has no system key and a ledger has no parent, and
 * `NULL IN (…)` is NULL — which NOT would leave NULL, and drop the line.
 */
export const isCash = (account: Prisma.Sql, parent: Prisma.Sql) =>
  Prisma.sql`(COALESCE(${account}.system_key, '') IN (${MONEY}) OR COALESCE(${parent}.system_key, '') IN (${MONEY}))`;

const MONEY_KEYS: ReadonlySet<string> = new Set(MONEY_LEDGER_KEYS);

// ---------------------------------------------------------------- the chart

export interface ChartAccount {
  id: bigint;
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  systemKey: string | null;
  parentKey: string | null;
  /** "Bank › City Bank 0123"; a ledger on its own is just its name. */
  label: string;
}

/** Every account, deactivated ones included: a voucher posted to one still counts. */
export async function chartAccounts(db: TenantDb, tenantId: bigint): Promise<ChartAccount[]> {
  const rows = await db.$queryRaw<
    { id: bigint; account_type: ChartAccount['accountType']; system_key: string | null; parent_key: string | null; name: string; parent_name: string | null }[]
  >`
    SELECT la.id, la.account_type::text AS account_type, la.system_key, p.system_key AS parent_key,
           la.name, p.name AS parent_name
      FROM ledger_account la
      LEFT JOIN ledger_account p ON p.tenant_id = la.tenant_id AND p.id = la.parent_id
     WHERE la.tenant_id = ${tenantId}
  `;
  return rows.map((r) => ({
    id: r.id,
    accountType: r.account_type,
    systemKey: r.system_key,
    parentKey: r.parent_key,
    label: r.parent_name === null ? r.name : `${r.parent_name} › ${r.name}`,
  }));
}

/** isCash, in code. */
export function isCashAccount(a: ChartAccount): boolean {
  return MONEY_KEYS.has(a.systemKey ?? '') || MONEY_KEYS.has(a.parentKey ?? '');
}

// ---------------------------------------------------------------- vouchers

export interface VoucherRow {
  id: bigint;
  code: string;
  kind: JournalEntryKind;
  entryDate: Date;
  description: string | null;
  accountId: bigint;
  partyName: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/**
 * Each posted voucher's lines on the accounts, one row per voucher per
 * account, to the end of `to` — from the start of `from` when it is given,
 * else since the books began. `movedCash` keeps only vouchers that also moved
 * a Cash or Bank account: the Cash Flow Statement's test.
 */
export async function voucherRows(
  db: TenantDb,
  tenantId: bigint,
  input: { accountIds: bigint[]; from: string | null; to: string; movedCash: boolean },
): Promise<VoucherRow[]> {
  if (input.accountIds.length === 0) return [];
  const rows = await db.$queryRaw<
    { id: bigint; code: string; kind: JournalEntryKind; entry_date: Date; description: string | null; account_id: bigint; party_name: string | null; debit: unknown; credit: unknown }[]
  >`
    SELECT je.id, je.code, je.kind::text AS kind, je.entry_date, je.description,
           jl.ledger_account_id AS account_id, ${PARTY_NAME} AS party_name,
           SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
      FROM journal_line jl
      JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
      ${PARTY_JOINS}
     WHERE jl.tenant_id = ${tenantId}
       AND jl.deleted_at IS NULL
       AND je.deleted_at IS NULL
       AND je.status = 'POSTED'
       AND jl.ledger_account_id IN (${Prisma.join(input.accountIds)})
       AND je.entry_date <= ${input.to}::date
       ${input.from === null ? Prisma.empty : Prisma.sql`AND je.entry_date >= ${input.from}::date`}
       ${
         input.movedCash
           ? Prisma.sql`AND EXISTS (
               SELECT 1
                 FROM journal_line ml
                 JOIN ledger_account ma ON ma.tenant_id = ml.tenant_id AND ma.id = ml.ledger_account_id
                 LEFT JOIN ledger_account mp ON mp.tenant_id = ma.tenant_id AND mp.id = ma.parent_id
                WHERE ml.tenant_id = je.tenant_id
                  AND ml.journal_entry_id = je.id
                  AND ml.deleted_at IS NULL
                  AND ${isCash(Prisma.sql`ma`, Prisma.sql`mp`)}
             )`
           : Prisma.empty
       }
     GROUP BY je.id, je.code, je.kind, je.entry_date, je.description, jl.ledger_account_id, cu.name, ag.name, ca.name, ve.name
  `;
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    kind: r.kind,
    entryDate: r.entry_date,
    description: r.description,
    accountId: r.account_id,
    partyName: r.party_name,
    debit: dec(r.debit),
    credit: dec(r.credit),
  }));
}

// ---------------------------------------------------------------- the popup

type Entry = Omit<StatementEntryDto, 'amount'> & { amount: Prisma.Decimal };

const money = (v: Prisma.Decimal): string => v.toFixed(2);

/** "10,000.00", for a sentence in a row's Details. */
export const shown = (v: Prisma.Decimal): string =>
  Number(v.toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const blank: Omit<Entry, 'source' | 'amount'> = {
  date: null,
  documentId: null,
  documentCode: null,
  voucherKind: null,
  partyType: null,
  partyId: null,
  partyName: null,
  reference: null,
  details: null,
};

/** Rows and subtotals as they are found, then the popup's DTO. */
export class Breakdown {
  private readonly entries: Entry[] = [];
  private readonly groups = new Map<string, { count: number; amount: Prisma.Decimal }>();
  private readonly withheld = { count: 0, amount: ZERO };

  /** One row, counted under its group. A zero adds nothing and is left out. */
  add(group: string, entry: Partial<Omit<Entry, 'source' | 'amount'>> & Pick<Entry, 'source' | 'amount'>): void {
    if (entry.amount.isZero()) return;
    const g = this.groups.get(group) ?? { count: 0, amount: ZERO };
    this.groups.set(group, { count: g.count + 1, amount: g.amount.plus(entry.amount) });
    this.entries.push({ ...blank, ...entry });
  }

  /**
   * A posted voucher's lines, read as the line reads its accounts: a debit-
   * natured one (an asset; cash) as debit − credit, the rest credit − debit.
   */
  addVouchers(rows: VoucherRow[], accounts: Map<string, ChartAccount>, debitNatured: (a: ChartAccount) => boolean): void {
    const sorted = [...rows].sort((a, b) => {
      const la = accounts.get(a.accountId.toString())?.label ?? '';
      const lb = accounts.get(b.accountId.toString())?.label ?? '';
      return la.localeCompare(lb);
    });
    for (const row of sorted) {
      const account = accounts.get(row.accountId.toString());
      if (account === undefined) continue;
      const amount = debitNatured(account) ? row.debit.minus(row.credit) : row.credit.minus(row.debit);
      this.add(account.label, {
        source: 'VOUCHER',
        date: day(row.entryDate),
        documentId: row.id.toString(),
        documentCode: row.code,
        voucherKind: row.kind,
        partyName: row.partyName,
        reference: account.label,
        details: row.description,
        amount,
      });
    }
  }

  /** A row the viewer may not see one by one (MODULE_ACCOUNTS §3.9): summed, not listed. */
  withhold(amount: Prisma.Decimal): void {
    if (amount.isZero()) return;
    this.withheld.count += 1;
    this.withheld.amount = this.withheld.amount.plus(amount);
  }

  dto(head: Omit<StatementBreakdownDto, 'total' | 'groups' | 'entries' | 'withheld'> & { total: Prisma.Decimal }): StatementBreakdownDto {
    // Oldest first; a figure, which has no date, after everything dated.
    const order = (e: Entry) => e.date ?? '9999-12-31';
    const sorted = this.entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => order(a.e).localeCompare(order(b.e)) || (a.e.documentCode ?? '').localeCompare(b.e.documentCode ?? '') || a.i - b.i)
      .map(({ e }) => e);

    // The newest vouchers are listed; the rest are brought forward as one row.
    const vouchers = sorted.filter((e) => e.source === 'VOUCHER');
    const earlier = vouchers.slice(0, Math.max(0, vouchers.length - LISTED_VOUCHERS));
    const rolled = new Set(earlier);
    const listed: Entry[] = [];
    if (earlier.length > 0) {
      listed.push({
        ...blank,
        source: 'EARLIER',
        date: earlier[earlier.length - 1]!.date,
        reference: `${earlier.length} earlier voucher entr${earlier.length === 1 ? 'y' : 'ies'}`,
        details: `Summed into one row; the ${LISTED_VOUCHERS} most recent are listed one by one.`,
        amount: earlier.reduce((sum, e) => sum.plus(e.amount), ZERO),
      });
    }
    listed.push(...sorted.filter((e) => !rolled.has(e)));

    return {
      ...head,
      total: money(head.total),
      groups: [...this.groups].map(([label, g]) => ({ label, count: g.count, amount: money(g.amount) })),
      entries: listed.map((e) => ({ ...e, amount: money(e.amount) })),
      withheld: this.withheld.count === 0 ? null : { count: this.withheld.count, amount: money(this.withheld.amount) },
    };
  }
}
