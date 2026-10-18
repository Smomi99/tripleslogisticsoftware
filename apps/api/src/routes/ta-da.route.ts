import ExcelJS from 'exceljs';
import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  isoCurrency,
  TA_DA_STATUS_LABEL,
  type TaDaClaimDto,
  type TaDaClaimSaveData,
  taDaClaimSaveSchema,
  type TaDaListRow,
  taDaListQuerySchema,
  type TaDaOptionsDto,
  taDaPaySchema,
  taDaReasonSchema,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { baseCurrency } from '../lib/currency-rate';
import { money } from '../lib/debit-invoice';
import { HttpError } from '../lib/http-error';
import { nextTaDaNo, seriesYearOf } from '../lib/inquiry-no';
import { accountOption, accountTotals, createEntry, isMoney, isUsable, loadAccounts, systemAccount } from '../lib/ledger';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';

/**
 * Accounts → TA/DA (Menu M17) — packages/shared/src/ta-da.ts.
 *
 *   GET   /                list (search, status)
 *   GET   /export          the list as a workbook
 *   GET   /options         employees, and the cash and bank accounts to pay from
 *   POST  /                a new claim (DRAFT)
 *   GET   /:id             one claim
 *   PATCH /:id             change a DRAFT or REJECTED claim
 *   POST  /:id/submit      → SUBMITTED
 *   POST  /:id/approve     → APPROVED
 *   POST  /:id/reject      → REJECTED, with a reason
 *   POST  /:id/pay         → PAID: posts an Expense voucher on the TA/DA account
 *   POST  /:id/cancel      → CANCELLED, with a reason
 *
 * Every transition re-reads the claim inside its transaction and checks the
 * state it is leaving, so two people acting at once cannot both win.
 */
export const taDaRouter: Router = Router();
taDaRouter.use(authenticate);

const FEATURE = 'ACCOUNTS.TA_DA';

const CLAIM_SELECT = {
  id: true,
  code: true,
  employeeId: true,
  claimDate: true,
  purpose: true,
  status: true,
  totalTa: true,
  totalDa: true,
  totalAmount: true,
  submittedAt: true,
  decidedAt: true,
  rejectReason: true,
  paidAt: true,
  cancelledAt: true,
  cancelReason: true,
  currency: { select: { currency: true } },
  employee: { select: { code: true, name: true, department: true, designation: true } },
  submittedByUser: { select: { username: true, employee: { select: { name: true } } } },
  decidedByUser: { select: { username: true, employee: { select: { name: true } } } },
  paidByUser: { select: { username: true, employee: { select: { name: true } } } },
  journalEntry: { select: { id: true, code: true } },
  lines: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      travelDate: true,
      fromPlace: true,
      toPlace: true,
      mode: true,
      description: true,
      taAmount: true,
      daAmount: true,
      amount: true,
    },
  },
} satisfies Prisma.TaDaClaimSelect;

type ClaimRow = Prisma.TaDaClaimGetPayload<{ select: typeof CLAIM_SELECT }>;

const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const who = (u: { username: string; employee: { name: string } | null } | null): string | null =>
  u === null ? null : (u.employee?.name ?? u.username);

function claimDto(row: ClaimRow): TaDaClaimDto {
  return {
    id: row.id.toString(),
    code: row.code,
    employeeId: row.employeeId.toString(),
    employeeName: row.employee.name,
    employeeCode: row.employee.code,
    department: row.employee.department,
    designation: row.employee.designation,
    claimDate: day(row.claimDate) ?? '',
    purpose: row.purpose,
    status: row.status,
    currencyCode: isoCurrency(row.currency.currency),
    totalTa: money(row.totalTa),
    totalDa: money(row.totalDa),
    totalAmount: money(row.totalAmount),
    lines: row.lines.map((l) => ({
      id: l.id.toString(),
      travelDate: day(l.travelDate) ?? '',
      fromPlace: l.fromPlace,
      toPlace: l.toPlace,
      mode: l.mode,
      description: l.description,
      taAmount: money(l.taAmount),
      daAmount: money(l.daAmount),
      amount: money(l.amount),
    })),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submittedByName: who(row.submittedByUser),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByName: who(row.decidedByUser),
    rejectReason: row.rejectReason,
    paidAt: row.paidAt?.toISOString() ?? null,
    paidByName: who(row.paidByUser),
    voucher: row.journalEntry === null ? null : { id: row.journalEntry.id.toString(), code: row.journalEntry.code },
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    editable: row.status === 'DRAFT' || row.status === 'REJECTED',
  };
}

async function loadClaim(db: TenantDb, id: bigint): Promise<ClaimRow> {
  const row = await db.taDaClaim.findFirst({ where: { id, deletedAt: null }, select: CLAIM_SELECT });
  if (row === null) throw HttpError.notFound('TA/DA claim not found.');
  return row;
}

/** Refuses a move from any state but the ones named, in the claim's own words. */
function requireStatus(row: { code: string; status: string }, allowed: string[], doing: string): void {
  if (!allowed.includes(row.status)) {
    throw new HttpError(409, 'WRONG_STATUS', `${row.code} is ${TA_DA_STATUS_LABEL[row.status as keyof typeof TA_DA_STATUS_LABEL].toLowerCase()}, so it cannot be ${doing}.`);
  }
}

async function requireEmployee(db: TenantDb, id: string): Promise<bigint> {
  const employee = await db.employee.findFirst({ where: { id: BigInt(id), deletedAt: null }, select: { id: true } });
  if (employee === null) throw HttpError.badRequest('That employee is not available.');
  return employee.id;
}

/** Replace the lines, then read the GENERATED amounts back for the totals. */
async function writeClaimLines(
  db: TenantDb,
  args: { tenantId: bigint; userId: bigint; claimId: bigint; lines: TaDaClaimSaveData['lines'] },
): Promise<void> {
  const { tenantId, userId, claimId, lines } = args;
  await db.taDaClaimLine.updateMany({
    where: { claimId, deletedAt: null },
    data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
  });
  await db.taDaClaimLine.createMany({
    data: lines.map((l, index) => ({
      tenantId,
      claimId,
      sortOrder: index,
      travelDate: new Date(`${l.travelDate}T00:00:00.000Z`),
      fromPlace: l.fromPlace,
      toPlace: l.toPlace,
      mode: l.mode,
      description: l.description,
      taAmount: l.taAmount,
      daAmount: l.daAmount,
      createdBy: userId,
      updatedBy: userId,
    })),
  });
  const saved = await db.taDaClaimLine.findMany({
    where: { claimId, deletedAt: null },
    select: { taAmount: true, daAmount: true, amount: true },
  });
  const sum = (pick: (l: (typeof saved)[number]) => Prisma.Decimal | null) =>
    saved.reduce((s, l) => s.plus(pick(l) ?? 0), new Prisma.Decimal(0));
  await db.taDaClaim.update({
    where: { id: claimId },
    data: { totalTa: sum((l) => l.taAmount), totalDa: sum((l) => l.daAmount), totalAmount: sum((l) => l.amount) },
  });
}

/** Approving one's own claim is the one thing an approver may not do. */
async function refuseOwnClaim(db: TenantDb, auth: AuthContext, employeeId: bigint, doing: string): Promise<void> {
  if (auth.isSuperadmin) return;
  const me = await db.user.findFirst({ where: { id: auth.userId }, select: { employeeId: true } });
  if (me?.employeeId === employeeId) {
    throw HttpError.forbidden(`You cannot ${doing} your own claim. Ask another approver.`);
  }
}

// ---------------------------------------------------------------------- list

function listWhere(query: ReturnType<typeof taDaListQuerySchema.parse>): Prisma.TaDaClaimWhereInput {
  const needle = query.search;
  return {
    deletedAt: null,
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(needle === undefined
      ? {}
      : {
          OR: [
            { code: { contains: needle, mode: 'insensitive' } },
            { purpose: { contains: needle, mode: 'insensitive' } },
            { employee: { name: { contains: needle, mode: 'insensitive' } } },
          ],
        }),
  };
}

const LIST_SELECT = {
  id: true,
  code: true,
  claimDate: true,
  purpose: true,
  status: true,
  totalTa: true,
  totalDa: true,
  totalAmount: true,
  employee: { select: { name: true } },
  journalEntry: { select: { code: true } },
} satisfies Prisma.TaDaClaimSelect;

function listRow(row: Prisma.TaDaClaimGetPayload<{ select: typeof LIST_SELECT }>): TaDaListRow {
  return {
    id: row.id.toString(),
    code: row.code,
    claimDate: day(row.claimDate) ?? '',
    employeeName: row.employee.name,
    purpose: row.purpose,
    totalTa: money(row.totalTa),
    totalDa: money(row.totalDa),
    totalAmount: money(row.totalAmount),
    status: row.status,
    voucherCode: row.journalEntry?.code ?? null,
  };
}

function orderOf(query: ReturnType<typeof taDaListQuerySchema.parse>): Prisma.TaDaClaimOrderByWithRelationInput[] {
  const sortable: Record<string, Prisma.TaDaClaimOrderByWithRelationInput> = {
    code: { code: query.sortOrder },
    claimDate: { claimDate: query.sortOrder },
    amount: { totalAmount: query.sortOrder },
  };
  // A register of claims: newest first.
  return [sortable[query.sortBy ?? ''] ?? { claimDate: 'desc' }, { id: 'desc' }];
}

taDaRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = taDaListQuerySchema.parse(req.query);
  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where = listWhere(query);
    const [found, counted] = await Promise.all([
      db.taDaClaim.findMany({
        where,
        orderBy: orderOf(query),
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: LIST_SELECT,
      }),
      db.taDaClaim.count({ where }),
    ]);
    return { rows: found, total: counted };
  });
  const payload: ApiSuccess<TaDaListRow[]> = {
    success: true,
    data: rows.map(listRow),
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

taDaRouter.get('/export', requirePermission(`${FEATURE}.EXPORT`), async (req, res) => {
  const auth = req.auth!;
  const query = taDaListQuerySchema.parse(req.query);
  const rows = await withTenant(auth.tenantId, (db) =>
    db.taDaClaim.findMany({ where: listWhere(query), orderBy: orderOf(query), take: 10_000, select: LIST_SELECT }),
  );

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('TA-DA');
  sheet.columns = [
    { header: 'Claim No', width: 20 },
    { header: 'Date', width: 12 },
    { header: 'Employee', width: 28 },
    { header: 'Purpose', width: 40 },
    { header: 'TA', width: 14 },
    { header: 'DA', width: 14 },
    { header: 'Total', width: 14 },
    { header: 'Status', width: 12 },
    { header: 'Paid by voucher', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const r of rows.map(listRow)) {
    const line = sheet.addRow([
      r.code,
      r.claimDate,
      r.employeeName,
      r.purpose,
      Number(r.totalTa),
      Number(r.totalDa),
      Number(r.totalAmount),
      TA_DA_STATUS_LABEL[r.status],
      r.voucherCode ?? '',
    ]);
    for (const column of [5, 6, 7]) line.getCell(column).numFmt = '#,##0.00';
  }
  const body = Buffer.from(await book.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ta-da-claims.xlsx"');
  res.send(body);
});

taDaRouter.get('/options', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, async (db): Promise<TaDaOptionsDto> => {
    const [employees, me, accounts, totals, base] = await Promise.all([
      db.employee.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.user.findFirst({ where: { id: auth.userId }, select: { employeeId: true } }),
      loadAccounts(db),
      accountTotals(db, auth.tenantId),
      baseCurrency(db, auth.tenantId),
    ]);
    return {
      employees: employees.map((e) => ({ id: e.id.toString(), label: `${e.name} (${e.code})` })),
      myEmployeeId: me?.employeeId?.toString() ?? null,
      moneyAccounts: accounts
        .filter((a) => isMoney(a) && isUsable(a))
        .map((a) => {
          const option = accountOption(a, totals);
          return { id: option.id, label: option.label, balance: option.balance };
        }),
      baseCurrencyCode: base === null ? null : isoCurrency(base.currency),
    };
  });
  const payload: ApiSuccess<TaDaOptionsDto> = { success: true, data };
  res.json(payload);
});

// --------------------------------------------------------------------- write

taDaRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = taDaClaimSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const base = await baseCurrency(db, auth.tenantId);
    if (base === null) {
      throw new HttpError(409, 'NO_BASE_CURRENCY', 'This workspace has no base currency. Set one on Settings → Currency.');
    }
    const employeeId = await requireEmployee(db, input.employeeId);
    const claimDate = new Date(`${input.claimDate}T00:00:00.000Z`);
    const year = seriesYearOf(claimDate);

    let claimId: bigint | null = null;
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT && claimId === null; attempt += 1) {
      const code = await nextTaDaNo(db, auth.tenantId, year);
      try {
        claimId = (
          await db.taDaClaim.create({
            data: {
              tenantId: auth.tenantId,
              code,
              seriesYear: year,
              employeeId,
              claimDate,
              purpose: input.purpose,
              currencyId: base.id,
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
    if (claimId === null) throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a claim number.');

    await writeClaimLines(db, { tenantId: auth.tenantId, userId: auth.userId, claimId, lines: input.lines });
    return claimDto(await loadClaim(db, claimId));
  });

  const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
  res.status(201).json(payload);
});

taDaRouter.get('/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'TA/DA claim');
  const data = await withTenant(auth.tenantId, async (db) => claimDto(await loadClaim(db, id)));
  const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
  res.json(payload);
});

taDaRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'TA/DA claim');
  const input = taDaClaimSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadClaim(db, id);
    requireStatus(row, ['DRAFT', 'REJECTED'], 'changed');
    await db.taDaClaim.update({
      where: { id },
      data: {
        employeeId: await requireEmployee(db, input.employeeId),
        claimDate: new Date(`${input.claimDate}T00:00:00.000Z`),
        purpose: input.purpose,
        updatedBy: auth.userId,
      },
    });
    await writeClaimLines(db, { tenantId: auth.tenantId, userId: auth.userId, claimId: id, lines: input.lines });
    return claimDto(await loadClaim(db, id));
  });

  const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
  res.json(payload);
});

// --------------------------------------------------------------- transitions

taDaRouter.post(
  '/:id/submit',
  requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'TA/DA claim');
    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadClaim(db, id);
      requireStatus(row, ['DRAFT', 'REJECTED'], 'submitted');
      if (row.lines.length === 0 || row.totalAmount.lessThanOrEqualTo(0)) {
        throw HttpError.badRequest('Add at least one trip or day with an amount before submitting.');
      }
      await db.taDaClaim.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedBy: auth.userId,
          decidedAt: null,
          decidedBy: null,
          rejectReason: null,
          updatedBy: auth.userId,
        },
      });
      return claimDto(await loadClaim(db, id));
    });
    const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
    res.json(payload);
  },
);

taDaRouter.post('/:id/approve', requirePermission(`${FEATURE}.APPROVE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'TA/DA claim');
  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadClaim(db, id);
    requireStatus(row, ['SUBMITTED'], 'approved');
    await refuseOwnClaim(db, auth, row.employeeId, 'approve');
    await db.taDaClaim.update({
      where: { id },
      data: { status: 'APPROVED', decidedAt: new Date(), decidedBy: auth.userId, updatedBy: auth.userId },
    });
    return claimDto(await loadClaim(db, id));
  });
  const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
  res.json(payload);
});

taDaRouter.post('/:id/reject', requirePermission(`${FEATURE}.APPROVE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'TA/DA claim');
  const input = taDaReasonSchema.parse(req.body);
  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadClaim(db, id);
    requireStatus(row, ['SUBMITTED'], 'rejected');
    await refuseOwnClaim(db, auth, row.employeeId, 'reject');
    await db.taDaClaim.update({
      where: { id },
      data: {
        status: 'REJECTED',
        decidedAt: new Date(),
        decidedBy: auth.userId,
        rejectReason: input.reason,
        updatedBy: auth.userId,
      },
    });
    return claimDto(await loadClaim(db, id));
  });
  const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
  res.json(payload);
});

/**
 * Pay: an Expense voucher, Dr TA/DA (EXPENSE.OPERATING.TA_DA) Cr the cash or
 * bank account, posted the way Transaction → Expense posts one. Cancelling
 * that voucher on the Expense screen puts the claim back to APPROVED
 * (lib/ledger.ts, unsettle).
 */
taDaRouter.post(
  '/:id/pay',
  requirePermission(`${FEATURE}.VIEW`),
  requirePermission('ACCOUNTS.EXPENSE.CREATE'),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'TA/DA claim');
    const input = taDaPaySchema.parse(req.body);
    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadClaim(db, id);
      requireStatus(row, ['APPROVED'], 'paid');
      if ((await baseCurrency(db, auth.tenantId)) === null) {
        throw new HttpError(409, 'NO_BASE_CURRENCY', 'This workspace has no base currency. Set one on Settings → Currency.');
      }
      const account = await systemAccount(db, 'EXPENSE.OPERATING.TA_DA');
      const amount = row.totalAmount.toFixed(2);
      const entryId = await createEntry(db, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        posting: true,
        input: {
          kind: 'EXPENSE',
          entryDate: input.paymentDate,
          description: `TA/DA ${row.code} — ${row.employee.name}: ${row.purpose}`.slice(0, 2000),
          moneyAccountId: input.moneyAccountId,
          amount,
          lines: [{ ledgerAccountId: account.id.toString(), amount }],
          settlement: null,
        },
      });
      await db.taDaClaim.update({
        where: { id },
        data: { status: 'PAID', journalEntryId: entryId, paidAt: new Date(), paidBy: auth.userId, updatedBy: auth.userId },
      });
      return claimDto(await loadClaim(db, id));
    });
    const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
    res.json(payload);
  },
);

taDaRouter.post('/:id/cancel', requirePermission(`${FEATURE}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'TA/DA claim');
  const input = taDaReasonSchema.parse(req.body);
  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadClaim(db, id);
    if (row.status === 'PAID') {
      throw new HttpError(
        409,
        'WRONG_STATUS',
        `${row.code} has been paid by ${row.journalEntry?.code ?? 'a voucher'}. Cancel that voucher on Transaction → Expense first.`,
      );
    }
    requireStatus(row, ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'], 'cancelled');
    await db.taDaClaim.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: auth.userId,
        cancelReason: input.reason,
        updatedBy: auth.userId,
      },
    });
    return claimDto(await loadClaim(db, id));
  });
  const payload: ApiSuccess<TaDaClaimDto> = { success: true, data };
  res.json(payload);
});
