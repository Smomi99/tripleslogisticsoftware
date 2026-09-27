import { Router } from 'express';

import {
  type ApiSuccess,
  type BankAccountDto,
  bankAccountInputSchema,
  bankAccountListQuerySchema,
  type BankDto,
  bankInputSchema,
  bankListQuerySchema,
  buildMeta,
  type ChartDto,
  type ChartLedgerDto,
  CODE_PREFIX,
  type DocumentPartyDto,
  documentPartyQuerySchema,
  type JournalEntryData,
  type JournalEntryDto,
  journalEntryCancelSchema,
  journalEntryInputSchema,
  type JournalEntryKind,
  journalEntryListQuerySchema,
  type JournalEntryListRow,
  type JournalEntryOptionsDto,
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_KIND_LABEL,
  type LedgerAccountDto,
  ledgerAccountCreateSchema,
  ledgerAccountRenameSchema,
  LEDGER_ACCOUNT_TYPE_LABEL,
  LEDGER_ACCOUNT_TYPES,
  type OpenDocumentDto,
  openDocumentsQuerySchema,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { type BaseCurrency, baseCurrency, resolveRates } from '../lib/currency-rate';
import { day, dec, describeLines, isoOf, money, paymentOf } from '../lib/debit-invoice';
import { HttpError } from '../lib/http-error';
import { seriesYearOf } from '../lib/inquiry-no';
import {
  accountOption,
  accountsSummary,
  type AccountRow,
  accountTotals,
  balanceOf,
  bankLedgerName,
  buildLines,
  ensureChart,
  ENTRY_SELECT,
  entryDto,
  entryParty,
  entrySettlement,
  isMoney,
  isPostable,
  isUsable,
  labelOf,
  loadAccounts,
  loadEntry,
  nextVoucherNo,
  openingOutstanding,
  serviceKeyOf,
  settle,
  STRUCTURAL_KEYS,
  supplierColumns,
  systemAccount,
  unsettle,
} from '../lib/ledger';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Accounts — the books (docs/MODULE_ACCOUNTS.md §14).
 *
 *   /chart                  Chart of accounts (Menu M7)
 *   /banks                  Bank Set up (M18)
 *   /bank-accounts          Account Set up (M19)
 *   /journal, /expense,     the four Transaction screens (M9–M12), one route
 *   /income,                set each, so every route carries exactly its own
 *   /internal-transfer      screen's permission (§7)
 *   /vouchers/...           the lookups the four forms share
 *
 * Every write re-reads what it changes inside its transaction.
 */
export const ledgerRouter: Router = Router();
ledgerRouter.use(authenticate);

const CHART = 'ACCOUNTS.CHART_OF_ACCOUNTS';
const BANK = 'ACCOUNTS.BANK_SETUP';
const ACCOUNT = 'ACCOUNTS.ACCOUNT_SETUP';

const holds = (auth: AuthContext, key: string): boolean => auth.isSuperadmin || auth.permissions.has(key);

async function requireBase(db: TenantDb, tenantId: bigint): Promise<BaseCurrency> {
  const base = await baseCurrency(db, tenantId);
  if (base === null) {
    throw new HttpError(
      409,
      'NO_BASE_CURRENCY',
      'This workspace has no base currency. Set one on Settings → Currency before keeping the books.',
    );
  }
  return base;
}

// ===========================================================================
// Chart of accounts (sheet `Chart of accounts`, §14.1)
// ===========================================================================

function accountDto(
  a: AccountRow,
  totals: Awaited<ReturnType<typeof accountTotals>>,
  balance?: Prisma.Decimal,
): LedgerAccountDto {
  return {
    id: a.id.toString(),
    code: a.code,
    accountType: a.accountType,
    parentId: a.parentId?.toString() ?? null,
    name: a.name,
    systemKey: a.systemKey,
    isActive: a.isActive,
    bankAccountId: a.bankAccount !== null && a.bankAccount.deletedAt === null ? a.bankAccount.id.toString() : null,
    balance: money(balance ?? balanceOf(a.accountType, totals.get(a.id.toString()))),
    postable: isPostable(a),
  };
}

ledgerRouter.get('/chart', requirePermission(`${CHART}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, async (db): Promise<ChartDto> => {
    await ensureChart(db, auth.tenantId, auth.userId);
    const [accounts, totals, base] = await Promise.all([
      loadAccounts(db),
      accountTotals(db, auth.tenantId),
      baseCurrency(db, auth.tenantId),
    ]);
    const subsOf = new Map<string, AccountRow[]>();
    for (const a of accounts) {
      if (a.parentId === null) continue;
      const key = a.parentId.toString();
      subsOf.set(key, [...(subsOf.get(key) ?? []), a]);
    }
    return {
      baseCurrencyCode: base === null ? null : isoOf(base),
      heads: LEDGER_ACCOUNT_TYPES.map((accountType) => ({
        accountType,
        label: LEDGER_ACCOUNT_TYPE_LABEL[accountType],
        ledgers: accounts
          .filter((a) => a.parentId === null && a.accountType === accountType)
          .map((ledger): ChartLedgerDto => {
            const subs = subsOf.get(ledger.id.toString()) ?? [];
            // A ledger's balance is its own postings and every sub ledger's.
            const balance = subs.reduce(
              (sum, s) => sum.plus(balanceOf(s.accountType, totals.get(s.id.toString()))),
              balanceOf(ledger.accountType, totals.get(ledger.id.toString())),
            );
            return { ...accountDto(ledger, totals, balance), subLedgers: subs.map((s) => accountDto(s, totals)) };
          }),
      })),
    };
  });
  const payload: ApiSuccess<ChartDto> = { success: true, data };
  res.json(payload);
});

/** "+ ADD new" beside a ledger (F10, L10, R10, X10, AD10), or "++" for a ledger (C9). */
ledgerRouter.post('/chart', requirePermission(`${CHART}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = ledgerAccountCreateSchema.parse(req.body);

  await withTenant(auth.tenantId, async (db) => {
    await ensureChart(db, auth.tenantId, auth.userId);
    let accountType = input.accountType;
    let parentId: bigint | null = null;
    if (input.parentId !== null) {
      const parent = await db.ledgerAccount.findFirst({
        where: { id: BigInt(input.parentId), deletedAt: null },
        select: { id: true, parentId: true, accountType: true, systemKey: true, name: true },
      });
      if (parent === null) throw HttpError.badRequest('That ledger is not on this chart.');
      if (parent.parentId !== null) {
        throw HttpError.badRequest(`${parent.name} is a sub ledger. The chart is two levels deep: ledger, then sub ledger.`);
      }
      if (parent.systemKey === 'ASSET.BANK') {
        throw HttpError.badRequest(
          'Bank accounts are added on Account Set up, which keeps the account number and branch with them.',
        );
      }
      // A sub ledger is always of its ledger's head (trigger ledger_account_parent_guard).
      accountType = parent.accountType;
      parentId = parent.id;
    }

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'ledgerAccount', CODE_PREFIX.ledgerAccount, auth.tenantId);
      try {
        await db.ledgerAccount.create({
          data: {
            tenantId: auth.tenantId,
            code,
            accountType,
            parentId,
            name: input.name,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
        });
        return;
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        if (isUniqueViolation(error)) {
          throw new HttpError(409, 'DUPLICATE_NAME', `There is already an account called “${input.name}” there.`);
        }
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate an account code. Please try again.');
  });

  const payload: ApiSuccess<{ created: true }> = { success: true, data: { created: true } };
  res.status(201).json(payload);
});

async function editableAccount(db: TenantDb, id: bigint) {
  const account = await db.ledgerAccount.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      isActive: true,
      parentId: true,
      systemKey: true,
      bankAccount: { select: { id: true, deletedAt: true } },
    },
  });
  if (account === null) throw HttpError.notFound('Account not found.');
  if (account.bankAccount !== null && account.bankAccount.deletedAt === null) {
    throw new HttpError(
      409,
      'BANK_ACCOUNT_LEDGER',
      `${account.name} is a bank account's own ledger. Change it on Account Set up, so the two never disagree.`,
    );
  }
  return account;
}

ledgerRouter.patch('/chart/:id', requirePermission(`${CHART}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'account');
  const input = ledgerAccountRenameSchema.parse(req.body);

  await withTenant(auth.tenantId, async (db) => {
    await editableAccount(db, id);
    try {
      await db.ledgerAccount.update({ where: { id }, data: { name: input.name, updatedBy: auth.userId } });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'DUPLICATE_NAME', `There is already an account called “${input.name}” there.`);
      }
      throw error;
    }
  });

  const payload: ApiSuccess<{ saved: true }> = { success: true, data: { saved: true } };
  res.json(payload);
});

/**
 * §4 rule 3: an account is retired, never removed — every voucher that posted
 * to it keeps pointing at it. Switched off, it leaves the pickers and keeps its
 * balance on the chart.
 */
ledgerRouter.post('/chart/:id/toggle-status', requirePermission(`${CHART}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'account');

  const isActive = await withTenant(auth.tenantId, async (db) => {
    const account = await editableAccount(db, id);
    if (account.isActive && account.systemKey !== null && STRUCTURAL_KEYS.has(account.systemKey)) {
      throw new HttpError(
        409,
        'STRUCTURAL_ACCOUNT',
        `${account.name} is where every payment and deposit is drawn from, so it stays on.`,
      );
    }
    if (account.isActive && account.parentId === null) {
      const live = await db.ledgerAccount.count({ where: { parentId: id, deletedAt: null, isActive: true } });
      if (live > 0) {
        throw new HttpError(
          409,
          'HAS_SUB_LEDGERS',
          `${account.name} still has ${live} active sub ledger${live === 1 ? '' : 's'}. Switch those off first.`,
        );
      }
    }
    const updated = await db.ledgerAccount.update({
      where: { id },
      data: { isActive: !account.isActive, updatedBy: auth.userId },
      select: { isActive: true },
    });
    return updated.isActive;
  });

  const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
  res.json(payload);
});

// ===========================================================================
// Bank Set up (sheet `bank setup`, §14.3)
// ===========================================================================

const BANK_SELECT = {
  id: true,
  code: true,
  bankName: true,
  branch: true,
  bankAddress: true,
  swiftNo: true,
  routingNo: true,
  ibanNo: true,
  isActive: true,
} satisfies Prisma.BankSelect;

const bankDto = (b: Prisma.BankGetPayload<{ select: typeof BANK_SELECT }>): BankDto => ({
  id: b.id.toString(),
  code: b.code,
  bankName: b.bankName,
  branch: b.branch,
  bankAddress: b.bankAddress,
  swiftNo: b.swiftNo,
  routingNo: b.routingNo,
  ibanNo: b.ibanNo,
  isActive: b.isActive,
});

const duplicateBank = (bankName: string, branch: string): HttpError =>
  new HttpError(409, 'DUPLICATE_BANK', `${bankName}, ${branch} branch is already set up.`);

ledgerRouter.get('/banks', requirePermission(`${BANK}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = bankListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.BankWhereInput = {
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { bankName: { contains: query.search, mode: 'insensitive' } },
              { branch: { contains: query.search, mode: 'insensitive' } },
              { swiftNo: { contains: query.search, mode: 'insensitive' } },
              { routingNo: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }),
    };
    const [found, counted] = await Promise.all([
      db.bank.findMany({
        where,
        select: BANK_SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { branch: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.bank.count({ where }),
    ]);
    return { rows: found.map(bankDto), total: counted };
  });

  const payload: ApiSuccess<BankDto[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

ledgerRouter.post('/banks', requirePermission(`${BANK}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = bankInputSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'bank', CODE_PREFIX.bank, auth.tenantId);
      try {
        return bankDto(
          await db.bank.create({
            data: { tenantId: auth.tenantId, code, ...input, createdBy: auth.userId, updatedBy: auth.userId },
            select: BANK_SELECT,
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        if (isUniqueViolation(error)) throw duplicateBank(input.bankName, input.branch);
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a bank code. Please try again.');
  });

  const payload: ApiSuccess<BankDto> = { success: true, data };
  res.status(201).json(payload);
});

ledgerRouter.patch('/banks/:id', requirePermission(`${BANK}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'bank');
  const input = bankInputSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.bank.findFirst({ where: { id, deletedAt: null }, select: { bankName: true } });
    if (existing === null) throw HttpError.notFound('Bank not found.');
    let updated;
    try {
      updated = await db.bank.update({ where: { id }, data: { ...input, updatedBy: auth.userId }, select: BANK_SELECT });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateBank(input.bankName, input.branch);
      throw error;
    }
    // Every account of this bank is named after it on the chart.
    if (existing.bankName !== input.bankName) {
      const bankLedger = await systemAccount(db, 'ASSET.BANK');
      const accounts = await db.bankAccount.findMany({
        where: { bankId: id, deletedAt: null },
        select: { accountNo: true, ledgerAccountId: true },
      });
      for (const a of accounts) {
        await db.ledgerAccount.update({
          where: { id: a.ledgerAccountId },
          data: {
            name: await bankLedgerName(db, input.bankName, a.accountNo, bankLedger.id, a.ledgerAccountId),
            updatedBy: auth.userId,
          },
        });
      }
    }
    return bankDto(updated);
  });

  const payload: ApiSuccess<BankDto> = { success: true, data };
  res.json(payload);
});

ledgerRouter.post('/banks/:id/toggle-status', requirePermission(`${BANK}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'bank');
  const isActive = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.bank.findFirst({ where: { id, deletedAt: null }, select: { isActive: true } });
    if (existing === null) throw HttpError.notFound('Bank not found.');
    const updated = await db.bank.update({
      where: { id },
      data: { isActive: !existing.isActive, updatedBy: auth.userId },
      select: { isActive: true },
    });
    return updated.isActive;
  });
  const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
  res.json(payload);
});

// ===========================================================================
// Account Set up (sheet `Account setup`, §14.3)
// ===========================================================================

const BANK_ACCOUNT_SELECT = {
  id: true,
  code: true,
  accountName: true,
  accountNo: true,
  bankId: true,
  ledgerAccountId: true,
  isActive: true,
  bank: { select: BANK_SELECT },
  ledgerAccount: { select: { name: true, accountType: true } },
} satisfies Prisma.BankAccountSelect;

function bankAccountDto(
  a: Prisma.BankAccountGetPayload<{ select: typeof BANK_ACCOUNT_SELECT }>,
  totals: Awaited<ReturnType<typeof accountTotals>>,
): BankAccountDto {
  return {
    id: a.id.toString(),
    code: a.code,
    accountName: a.accountName,
    accountNo: a.accountNo,
    bankId: a.bankId.toString(),
    bankName: a.bank.bankName,
    branch: a.bank.branch,
    bankAddress: a.bank.bankAddress,
    swiftNo: a.bank.swiftNo,
    routingNo: a.bank.routingNo,
    ibanNo: a.bank.ibanNo,
    ledgerAccountId: a.ledgerAccountId.toString(),
    ledgerName: a.ledgerAccount.name,
    balance: money(balanceOf(a.ledgerAccount.accountType, totals.get(a.ledgerAccountId.toString()))),
    isActive: a.isActive,
  };
}

ledgerRouter.get('/bank-accounts', requirePermission(`${ACCOUNT}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = bankAccountListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.BankAccountWhereInput = {
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { accountName: { contains: query.search, mode: 'insensitive' } },
              { accountNo: { contains: query.search, mode: 'insensitive' } },
              { bank: { bankName: { contains: query.search, mode: 'insensitive' } } },
              { bank: { branch: { contains: query.search, mode: 'insensitive' } } },
            ],
          }),
    };
    const [found, counted, totals] = await Promise.all([
      db.bankAccount.findMany({
        where,
        select: BANK_ACCOUNT_SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.bankAccount.count({ where }),
      accountTotals(db, auth.tenantId),
    ]);
    return { rows: found.map((a) => bankAccountDto(a, totals)), total: counted };
  });

  const payload: ApiSuccess<BankAccountDto[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/** "Select Bank" and "Select Branch": every bank setup row still switched on. */
ledgerRouter.get('/bank-accounts/banks', requirePermission(`${ACCOUNT}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const rows = await withTenant(auth.tenantId, (db) =>
    db.bank.findMany({
      where: { deletedAt: null, isActive: true },
      select: BANK_SELECT,
      orderBy: [{ bankName: 'asc' }, { branch: 'asc' }],
    }),
  );
  const payload: ApiSuccess<BankDto[]> = { success: true, data: rows.map(bankDto) };
  res.json(payload);
});

async function activeBank(db: TenantDb, id: bigint): Promise<{ id: bigint; bankName: string }> {
  const bank = await db.bank.findFirst({
    where: { id, deletedAt: null, isActive: true },
    select: { id: true, bankName: true },
  });
  if (bank === null) throw HttpError.badRequest('That bank branch is not available. Set it up on Bank Set up first.');
  return bank;
}

const duplicateAccount = (accountNo: string): HttpError =>
  new HttpError(409, 'DUPLICATE_ACCOUNT', `Account ${accountNo} is already set up at that branch.`);

/**
 * An account and its sub ledger under Asset → Bank are made together (§14.3):
 * the sheet's "Bank Asia Ltd-878" on the chart is this account, and it is what
 * every Expense, Income and Transfer voucher posts to.
 */
ledgerRouter.post('/bank-accounts', requirePermission(`${ACCOUNT}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = bankAccountInputSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    await ensureChart(db, auth.tenantId, auth.userId);
    const bank = await activeBank(db, BigInt(input.bankId));
    const bankLedger = await systemAccount(db, 'ASSET.BANK');
    const name = await bankLedgerName(db, bank.bankName, input.accountNo, bankLedger.id, null);

    let ledgerId: bigint | null = null;
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT && ledgerId === null; attempt += 1) {
      const code = await nextCode(db, 'ledgerAccount', CODE_PREFIX.ledgerAccount, auth.tenantId);
      try {
        ledgerId = (
          await db.ledgerAccount.create({
            data: {
              tenantId: auth.tenantId,
              code,
              accountType: 'ASSET',
              parentId: bankLedger.id,
              name,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          })
        ).id;
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        if (isUniqueViolation(error)) {
          throw new HttpError(409, 'DUPLICATE_NAME', `There is already an account called “${name}” under Bank.`);
        }
        throw error;
      }
    }
    if (ledgerId === null) {
      throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate an account code. Please try again.');
    }

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'bankAccount', CODE_PREFIX.bankAccount, auth.tenantId);
      try {
        const made = await db.bankAccount.create({
          data: {
            tenantId: auth.tenantId,
            code,
            accountName: input.accountName,
            accountNo: input.accountNo,
            bankId: bank.id,
            ledgerAccountId: ledgerId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: BANK_ACCOUNT_SELECT,
        });
        return bankAccountDto(made, new Map());
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        if (isUniqueViolation(error)) throw duplicateAccount(input.accountNo);
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate an account code. Please try again.');
  });

  const payload: ApiSuccess<BankAccountDto> = { success: true, data };
  res.status(201).json(payload);
});

ledgerRouter.patch('/bank-accounts/:id', requirePermission(`${ACCOUNT}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'bank account');
  const input = bankAccountInputSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.bankAccount.findFirst({
      where: { id, deletedAt: null },
      select: { ledgerAccountId: true, bankId: true },
    });
    if (existing === null) throw HttpError.notFound('Bank account not found.');
    const bank =
      BigInt(input.bankId) === existing.bankId
        ? await db.bank.findFirstOrThrow({ where: { id: existing.bankId }, select: { id: true, bankName: true } })
        : await activeBank(db, BigInt(input.bankId));
    const bankLedger = await systemAccount(db, 'ASSET.BANK');

    try {
      await db.bankAccount.update({
        where: { id },
        data: { accountName: input.accountName, accountNo: input.accountNo, bankId: bank.id, updatedBy: auth.userId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateAccount(input.accountNo);
      throw error;
    }
    await db.ledgerAccount.update({
      where: { id: existing.ledgerAccountId },
      data: {
        name: await bankLedgerName(db, bank.bankName, input.accountNo, bankLedger.id, existing.ledgerAccountId),
        updatedBy: auth.userId,
      },
    });
    const [row, totals] = await Promise.all([
      db.bankAccount.findFirstOrThrow({ where: { id }, select: BANK_ACCOUNT_SELECT }),
      accountTotals(db, auth.tenantId),
    ]);
    return bankAccountDto(row, totals);
  });

  const payload: ApiSuccess<BankAccountDto> = { success: true, data };
  res.json(payload);
});

/** Switching an account off switches its sub ledger off with it, and back. */
ledgerRouter.post('/bank-accounts/:id/toggle-status', requirePermission(`${ACCOUNT}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'bank account');
  const isActive = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.bankAccount.findFirst({
      where: { id, deletedAt: null },
      select: { isActive: true, ledgerAccountId: true },
    });
    if (existing === null) throw HttpError.notFound('Bank account not found.');
    const next = !existing.isActive;
    await db.bankAccount.update({ where: { id }, data: { isActive: next, updatedBy: auth.userId } });
    await db.ledgerAccount.update({
      where: { id: existing.ledgerAccountId },
      data: { isActive: next, updatedBy: auth.userId },
    });
    return next;
  });
  const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
  res.json(payload);
});

// ===========================================================================
// The lookups the four voucher forms share
// ===========================================================================

const ALL_CREATE = (Object.values(JOURNAL_ENTRY_FEATURE) as string[]).map((f) => `${f}.CREATE`);

ledgerRouter.get(
  '/vouchers/options',
  requireAnyPermission(...ALL_CREATE, 'ACCOUNTS.JOURNAL.EDIT'),
  async (req, res) => {
    const auth = req.auth!;
    const data = await withTenant(auth.tenantId, async (db): Promise<JournalEntryOptionsDto> => {
      await ensureChart(db, auth.tenantId, auth.userId);
      const [accounts, totals, base, inactive] = await Promise.all([
        loadAccounts(db),
        accountTotals(db, auth.tenantId),
        baseCurrency(db, auth.tenantId),
        inactiveMasters(db),
      ]);
      const usable = accounts.filter(isUsable);
      const live = { deletedAt: null, isActive: true };
      const option = (r: { id: bigint; name: string }) => ({ id: r.id.toString(), label: r.name });
      const [customers, vendors, carriers, agents] = await Promise.all([
        db.customer.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        db.vendor.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        db.carrier.findMany({
          where: { ...live, ...excludeInactive(inactive, 'carrier') },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.agent.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      ]);
      return {
        baseCurrencyCode: base === null ? null : isoOf(base),
        moneyAccounts: usable.filter(isMoney).map((a) => accountOption(a, totals)),
        accounts: usable.map((a) => accountOption(a, totals)),
        customers: customers.map(option),
        vendors: vendors.map(option),
        carriers: carriers.map(option),
        agents: agents.map(option),
      };
    });
    const payload: ApiSuccess<JournalEntryOptionsDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * "Select Invoice No :" — what the party still owes (a customer's issued debit
 * invoices) or is owed (a supplier's credit invoices), with anything left on
 * their CRM opening balance on that side.
 */
ledgerRouter.get(
  '/vouchers/open-documents',
  requireAnyPermission('ACCOUNTS.EXPENSE.CREATE', 'ACCOUNTS.INCOME.CREATE'),
  async (req, res) => {
    const auth = req.auth!;
    const query = openDocumentsQuerySchema.parse(req.query);
    const partyId = BigInt(query.partyId);

    const data = await withTenant(auth.tenantId, async (db): Promise<OpenDocumentDto[]> => {
      const out: OpenDocumentDto[] = [];
      const base = await baseCurrency(db, auth.tenantId);
      const side = query.partyType === 'CUSTOMER' ? 'RECEIVABLE' : 'PAYABLE';
      const opening = await openingOutstanding(db, query.partyType, partyId, side);
      if (opening !== null && opening.outstanding.greaterThan(0)) {
        const openingBase = base !== null && opening.position.currencyId === base.id;
        const rate = openingBase
          ? '1'
          : ((await resolveRates(db, auth.tenantId, [opening.position.currencyId])).get(opening.position.currencyId.toString())?.rate.toString() ?? null);
        out.push({
          against: 'OPENING',
          documentId: null,
          reference: 'Opening balance',
          date: '',
          description: 'What CRM holds as their opening balance',
          currencyCode: opening.position.currencyCode,
          total: money(side === 'RECEIVABLE' ? opening.position.receivable : opening.position.payable),
          outstanding: money(opening.outstanding),
          conversionRate: rate,
          isBaseCurrency: openingBase,
          debitInvoiceId: null,
          serviceKey: null,
        });
      }

      const shipmentSelect = { select: { code: true, shipmentType: true, loadingType: true } } as const;
      if (query.partyType === 'CUSTOMER') {
        const invoices = await db.debitInvoice.findMany({
          where: { customerId: partyId, status: 'ISSUED', deletedAt: null },
          orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            code: true,
            invoiceDate: true,
            currencyId: true,
            currencyCode: true,
            conversionRate: true,
            totalAmount: true,
            shipment: shipmentSelect,
            receipts: { where: { deletedAt: null }, select: { amount: true } },
          },
        });
        for (const inv of invoices) {
          const payment = paymentOf(inv.totalAmount, inv.receipts);
          if (payment.outstanding.isZero()) continue;
          out.push({
            against: 'INVOICE',
            documentId: inv.id.toString(),
            reference: inv.code,
            date: day(inv.invoiceDate) ?? '',
            description: inv.shipment === null ? 'Debit invoice' : `Freight — ${inv.shipment.code}`,
            currencyCode: inv.currencyCode,
            total: money(inv.totalAmount),
            outstanding: money(payment.outstanding),
            conversionRate: inv.conversionRate.toString(),
            isBaseCurrency: base !== null && inv.currencyId === base.id,
            debitInvoiceId: inv.id.toString(),
            serviceKey: serviceKeyOf(inv.shipment),
          });
        }
      } else {
        const blocks = await db.debitInvoiceCost.findMany({
          where: {
            partyType: query.partyType,
            ...supplierColumns(query.partyType, partyId),
            deletedAt: null,
            debitInvoice: { status: 'ISSUED', deletedAt: null },
          },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            supplierInvoiceNo: true,
            currencyId: true,
            currencyCode: true,
            conversionRate: true,
            totalAmount: true,
            lines: {
              where: { deletedAt: null },
              orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
              select: { costHeadName: true, quantity: true, containerSizeName: true },
            },
            payments: { where: { deletedAt: null }, select: { amount: true } },
            debitInvoice: { select: { id: true, code: true, invoiceDate: true, shipment: shipmentSelect } },
          },
        });
        for (const block of blocks) {
          const paid = paymentOf(block.totalAmount, block.payments);
          if (paid.outstanding.isZero()) continue;
          const inv = block.debitInvoice;
          out.push({
            against: 'INVOICE',
            documentId: block.id.toString(),
            reference: block.supplierInvoiceNo ?? inv.code,
            date: day(inv.invoiceDate) ?? '',
            description: `${describeLines(block.lines)} — ${inv.shipment?.code ?? inv.code}`,
            currencyCode: block.currencyCode,
            total: money(block.totalAmount),
            outstanding: money(paid.outstanding),
            conversionRate: block.conversionRate.toString(),
            isBaseCurrency: base !== null && block.currencyId === base.id,
            debitInvoiceId: inv.id.toString(),
            serviceKey: serviceKeyOf(inv.shipment),
          });
        }
      }
      return out;
    });

    const payload: ApiSuccess<OpenDocumentDto[]> = { success: true, data };
    res.json(payload);
  },
);

/**
 * Whose invoice it is — what `Receive` (a debit invoice) and `Make Payment` (a
 * credit invoice) open the voucher on, so the link need only name the invoice.
 */
ledgerRouter.get(
  '/vouchers/document-party',
  requireAnyPermission('ACCOUNTS.EXPENSE.CREATE', 'ACCOUNTS.INCOME.CREATE'),
  async (req, res) => {
    const auth = req.auth!;
    const query = documentPartyQuerySchema.parse(req.query);
    const data = await withTenant(auth.tenantId, async (db): Promise<DocumentPartyDto> => {
      if (query.debitInvoice !== null) {
        const inv = await db.debitInvoice.findFirst({
          where: { id: BigInt(query.debitInvoice), deletedAt: null },
          select: { customerId: true, customer: { select: { name: true } } },
        });
        if (inv === null) throw HttpError.notFound('Debit invoice not found.');
        return { partyType: 'CUSTOMER', partyId: inv.customerId.toString(), partyName: inv.customer.name };
      }
      const cost = await db.debitInvoiceCost.findFirst({
        where: { id: BigInt(query.creditInvoice!), deletedAt: null },
        select: {
          partyType: true,
          carrierId: true,
          agentId: true,
          vendorId: true,
          carrier: { select: { name: true } },
          agent: { select: { name: true } },
          vendor: { select: { name: true } },
        },
      });
      if (cost === null) throw HttpError.notFound('Credit invoice not found.');
      const id = cost.carrierId ?? cost.agentId ?? cost.vendorId;
      return {
        partyType: cost.partyType,
        partyId: id?.toString() ?? '',
        partyName: cost.carrier?.name ?? cost.agent?.name ?? cost.vendor?.name ?? '—',
      };
    });
    const payload: ApiSuccess<DocumentPartyDto> = { success: true, data };
    res.json(payload);
  },
);

// ===========================================================================
// The four Transaction screens (sheets `Journal`, `Expense-*`, `Income*`,
// `Internal Transfer`, §14.4–§14.6)
// ===========================================================================

const SLUG: Record<JournalEntryKind, string> = {
  JOURNAL: 'journal',
  EXPENSE: 'expense',
  INCOME: 'income',
  TRANSFER: 'internal-transfer',
};

async function dtoFor(db: TenantDb, tenantId: bigint, id: bigint, kind: JournalEntryKind): Promise<JournalEntryDto> {
  const [row, base] = await Promise.all([loadEntry(db, id, kind), baseCurrency(db, tenantId)]);
  return entryDto(row, { baseCurrencyCode: base === null ? null : isoOf(base), displayName: displayNameFromKey });
}

/** Resolves every account a voucher names, in one query. */
async function accountsFor(db: TenantDb, input: JournalEntryData): Promise<Map<string, AccountRow>> {
  const ids = new Set<string>(input.lines.map((l) => l.ledgerAccountId));
  if (input.kind !== 'JOURNAL') ids.add(input.moneyAccountId);
  const rows = await loadAccounts(db);
  return new Map(rows.filter((r) => ids.has(r.id.toString())).map((r) => [r.id.toString(), r]));
}

/** Writes the lines of a voucher, replacing any a draft already had. */
async function writeLines(
  db: TenantDb,
  args: { tenantId: bigint; userId: bigint; entryId: bigint; lines: ReturnType<typeof buildLines> },
): Promise<Prisma.Decimal> {
  await db.journalLine.updateMany({
    where: { journalEntryId: args.entryId, deletedAt: null },
    data: { deletedAt: new Date(), isActive: false, updatedBy: args.userId },
  });
  await db.journalLine.createMany({
    data: args.lines.map((l, index) => ({
      tenantId: args.tenantId,
      journalEntryId: args.entryId,
      sortOrder: index,
      ledgerAccountId: l.ledgerAccountId,
      debit: l.debit,
      credit: l.credit,
      createdBy: args.userId,
      updatedBy: args.userId,
    })),
  });
  return args.lines.reduce((sum, l) => sum.plus(l.debit), new Prisma.Decimal(0));
}

for (const kind of Object.keys(SLUG) as JournalEntryKind[]) {
  const path = `/${SLUG[kind]}`;
  const feature = JOURNAL_ENTRY_FEATURE[kind];
  const label = JOURNAL_ENTRY_KIND_LABEL[kind];

  ledgerRouter.get(path, requirePermission(`${feature}.VIEW`), async (req, res) => {
    const auth = req.auth!;
    const query = journalEntryListQuerySchema.parse({ ...req.query, kind });

    const { rows, total } = await withTenant(auth.tenantId, async (db) => {
      const where: Prisma.JournalEntryWhereInput = {
        kind,
        deletedAt: null,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.search === undefined
          ? {}
          : {
              OR: [
                { code: { contains: query.search, mode: 'insensitive' } },
                { description: { contains: query.search, mode: 'insensitive' } },
                { customer: { name: { contains: query.search, mode: 'insensitive' } } },
                { vendor: { name: { contains: query.search, mode: 'insensitive' } } },
                { carrier: { name: { contains: query.search, mode: 'insensitive' } } },
                { agent: { name: { contains: query.search, mode: 'insensitive' } } },
              ],
            }),
      };
      const sortable: Record<string, Prisma.JournalEntryOrderByWithRelationInput> = {
        code: { code: query.sortOrder },
        entryDate: { entryDate: query.sortOrder },
        amount: { totalAmount: query.sortOrder },
      };
      const [found, counted] = await Promise.all([
        db.journalEntry.findMany({
          where,
          // A register of vouchers: newest first.
          orderBy: [sortable[query.sortBy ?? ''] ?? { entryDate: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: ENTRY_SELECT,
        }),
        db.journalEntry.count({ where }),
      ]);
      return { rows: found, total: counted };
    });

    const data: JournalEntryListRow[] = rows.map((row) => ({
      id: row.id.toString(),
      code: row.code,
      kind: row.kind,
      status: row.status,
      entryDate: day(row.entryDate) ?? '',
      description: row.description,
      partyName: entryParty(row)?.name ?? null,
      accounts: accountsSummary({
        lines: row.lines.map((l) => ({ debit: l.debit, credit: l.credit, ledgerAccount: { name: l.ledgerAccount.name } })),
      }),
      settledReference: entrySettlement(row)?.reference ?? null,
      totalAmount: money(row.totalAmount),
    }));

    const payload: ApiSuccess<JournalEntryListRow[]> = {
      success: true,
      data,
      meta: buildMeta(query.page, query.limit, total),
    };
    res.json(payload);
  });

  ledgerRouter.post(path, requirePermission(`${feature}.CREATE`), async (req, res) => {
    const auth = req.auth!;
    const input = journalEntryInputSchema.parse({ ...req.body, kind });

    const posting = input.kind !== 'JOURNAL' || input.post;
    if (input.kind === 'JOURNAL' && input.post && !holds(auth, 'ACCOUNTS.JOURNAL.APPROVE')) {
      throw HttpError.forbidden('You may write a journal, but not agree it into the books. Save it for someone who can.');
    }
    // MODULE_ACCOUNTS §6: saying a customer paid an invoice is its own grant.
    if (input.kind === 'INCOME' && input.settlement?.against === 'INVOICE' && !holds(auth, 'ACCOUNTS.DEBIT_INVOICE.RECEIVE')) {
      throw HttpError.forbidden('You do not have permission to record money received against a debit invoice.');
    }

    const id = await withTenant(auth.tenantId, async (db) => {
      const base = await requireBase(db, auth.tenantId);
      await ensureChart(db, auth.tenantId, auth.userId);
      const lines = buildLines(input, await accountsFor(db, input));
      const entryDate = new Date(`${input.entryDate}T00:00:00.000Z`);
      const year = seriesYearOf(entryDate);
      const now = new Date();

      let entryId: bigint | null = null;
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT && entryId === null; attempt += 1) {
        const code = await nextVoucherNo(db, auth.tenantId, kind, year);
        try {
          entryId = (
            await db.journalEntry.create({
              data: {
                tenantId: auth.tenantId,
                code,
                seriesYear: year,
                kind,
                entryDate,
                description: input.description,
                status: posting ? 'POSTED' : 'DRAFT',
                postedAt: posting ? now : null,
                postedBy: posting ? auth.userId : null,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              },
              select: { id: true },
            })
          ).id;
        } catch (error) {
          if (isUniqueViolation(error, 'code')) continue;
          throw error;
        }
      }
      if (entryId === null) {
        throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a voucher number. Please try again.');
      }

      const total = await writeLines(db, { tenantId: auth.tenantId, userId: auth.userId, entryId, lines });
      await db.journalEntry.update({ where: { id: entryId }, data: { totalAmount: total } });

      if ((input.kind === 'EXPENSE' || input.kind === 'INCOME') && input.settlement !== null && input.settlement !== undefined) {
        await settle(db, {
          tenantId: auth.tenantId,
          userId: auth.userId,
          entryId,
          entryDate,
          kind: input.kind,
          settlement: input.settlement,
          baseAmount: dec(input.amount),
          base,
        });
      }
      return entryId;
    });

    const data = await withTenant(auth.tenantId, (db) => dtoFor(db, auth.tenantId, id, kind));
    const payload: ApiSuccess<JournalEntryDto> = { success: true, data };
    res.status(201).json(payload);
  });

  ledgerRouter.get(`${path}/:id`, requirePermission(`${feature}.VIEW`), async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, label.toLowerCase());
    const data = await withTenant(auth.tenantId, (db) => dtoFor(db, auth.tenantId, id, kind));
    const payload: ApiSuccess<JournalEntryDto> = { success: true, data };
    res.json(payload);
  });

  /** `Save & agreed` on a draft, or a draft cancelled; a posted voucher only cancels. */
  ledgerRouter.post(`${path}/:id/cancel`, requirePermission(`${feature}.CANCEL`), async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, label.toLowerCase());
    const input = journalEntryCancelSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadEntry(db, id, kind);
      if (row.status === 'CANCELLED') {
        throw new HttpError(409, 'ALREADY_CANCELLED', `${row.code} was already cancelled.`);
      }
      await db.journalEntry.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: auth.userId,
          cancelReason: input.reason,
          updatedBy: auth.userId,
        },
      });
      // What it paid or banked against goes back on the party's ledger.
      await unsettle(db, id, auth.userId);
      return dtoFor(db, auth.tenantId, id, kind);
    });

    const payload: ApiSuccess<JournalEntryDto> = { success: true, data };
    res.json(payload);
  });

  // "Upload file" / "Upload Payment voucher". Only the key is stored (CLAUDE.md §2).
  ledgerRouter.post(`${path}/:id/file`, requirePermission(`${feature}.CREATE`), uploadSingle, async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, label.toLowerCase());
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const stored = await withTenant(auth.tenantId, async (db) => {
      const row = await loadEntry(db, id, kind);
      if (row.status === 'CANCELLED') {
        throw new HttpError(409, 'ALREADY_CANCELLED', `${row.code} was cancelled and cannot be changed.`);
      }
      const put = await putFile(auth.tenantId, 'voucher', file);
      await db.journalEntry.update({ where: { id }, data: { attachmentFile: put.key, updatedBy: auth.userId } });
      // Removed after the row points at the new one, so a failure here never
      // leaves the record naming a file that is gone.
      if (row.attachmentFile !== null) await removeFile(auth.tenantId, row.attachmentFile);
      return put;
    });

    const payload: ApiSuccess<{ fileName: string }> = {
      success: true,
      data: { fileName: displayNameFromKey(stored.key) },
    };
    res.status(201).json(payload);
  });

  ledgerRouter.get(`${path}/:id/file`, requirePermission(`${feature}.VIEW`), async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, label.toLowerCase());
    const key = await withTenant(auth.tenantId, async (db) => {
      const row = await loadEntry(db, id, kind);
      if (row.attachmentFile === null) throw HttpError.notFound('Nothing has been uploaded for this voucher.');
      return row.attachmentFile;
    });
    const { stream, sizeBytes } = await openFile(auth.tenantId, key);
    res.setHeader('Content-Length', sizeBytes);
    res.setHeader('Content-Disposition', `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`);
    stream.pipe(res);
  });
}

// ------------------------------------------------ the Journal's draft (§14.4)

/** `Save` again on a draft journal, optionally `& agreed`. */
ledgerRouter.patch('/journal/:id', requirePermission('ACCOUNTS.JOURNAL.EDIT'), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'journal');
  const input = journalEntryInputSchema.parse({ ...req.body, kind: 'JOURNAL' });
  if (input.kind !== 'JOURNAL') throw HttpError.badRequest('That is not a journal.');
  if (input.post && !holds(auth, 'ACCOUNTS.JOURNAL.APPROVE')) {
    throw HttpError.forbidden('You may write a journal, but not agree it into the books. Save it for someone who can.');
  }

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadEntry(db, id, 'JOURNAL');
    if (row.status !== 'DRAFT') {
      throw new HttpError(
        409,
        'NOT_DRAFT',
        `${row.code} is ${row.status === 'POSTED' ? 'in the books' : 'cancelled'} and cannot be changed. ` +
          'Cancel it and write it again.',
      );
    }
    const lines = buildLines(input, await accountsFor(db, input));
    const total = await writeLines(db, { tenantId: auth.tenantId, userId: auth.userId, entryId: id, lines });
    const entryDate = new Date(`${input.entryDate}T00:00:00.000Z`);
    await db.journalEntry.update({
      where: { id },
      data: {
        entryDate,
        description: input.description,
        totalAmount: total,
        ...(input.post ? { status: 'POSTED' as const, postedAt: new Date(), postedBy: auth.userId } : {}),
        updatedBy: auth.userId,
      },
    });
    return dtoFor(db, auth.tenantId, id, 'JOURNAL');
  });

  const payload: ApiSuccess<JournalEntryDto> = { success: true, data };
  res.json(payload);
});

/** `Save & agreed` on a draft that is already right as it stands. */
ledgerRouter.post('/journal/:id/post', requirePermission('ACCOUNTS.JOURNAL.APPROVE'), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'journal');
  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadEntry(db, id, 'JOURNAL');
    if (row.status !== 'DRAFT') {
      throw new HttpError(409, 'NOT_DRAFT', `${row.code} is not a draft.`);
    }
    // The accounts may have been switched off since the draft was written.
    const accounts = new Map((await loadAccounts(db)).map((a) => [a.id.toString(), a]));
    for (const line of row.lines) {
      const account = accounts.get(line.ledgerAccountId.toString());
      if (account === undefined || !isUsable(account)) {
        throw HttpError.badRequest(
          `${account === undefined ? 'One of its accounts' : labelOf(account)} can no longer be posted to. Edit the draft first.`,
        );
      }
    }
    await db.journalEntry.update({
      where: { id },
      data: { status: 'POSTED', postedAt: new Date(), postedBy: auth.userId, updatedBy: auth.userId },
    });
    return dtoFor(db, auth.tenantId, id, 'JOURNAL');
  });
  const payload: ApiSuccess<JournalEntryDto> = { success: true, data };
  res.json(payload);
});
