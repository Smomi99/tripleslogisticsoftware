import ExcelJS from 'exceljs';
import { Router } from 'express';

import { type ApiSuccess, type IncomeStatementDto, incomeStatementQuerySchema, isoCurrency } from '@ff/shared';

import { baseCurrency } from '../lib/currency-rate';
import { incomeStatement } from '../lib/income-statement';
import { letterheadOf } from '../lib/letterhead';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Accounts → Income Statement (docs/DESIGN-UPDATE-2026-10-04.md §9, Menu M13).
 *
 *   GET /income-statement          the statement for a month
 *   GET /income-statement/export   the same figures as an Excel workbook
 *
 * Read-only, and the existing ACCOUNTS.INCOME_STATEMENT feature (VIEW,
 * EXPORT). What each line is made of is lib/income-statement.ts.
 */

export const incomeStatementRouter: Router = Router();
incomeStatementRouter.use(authenticate);

const FEATURE = 'ACCOUNTS.INCOME_STATEMENT';

async function build(db: TenantDb, tenantId: bigint, query: { month: string; yearStartMonth: number }): Promise<IncomeStatementDto> {
  const base = await baseCurrency(db, tenantId);
  return incomeStatement(db, tenantId, { ...query, currencyCode: base === null ? 'Base' : isoCurrency(base.currency) });
}

incomeStatementRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = incomeStatementQuerySchema.parse(req.query);
  const data = await withTenant(auth.tenantId, (db) => build(db, auth.tenantId, query));
  const payload: ApiSuccess<IncomeStatementDto> = { success: true, data };
  res.json(payload);
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-01" → "01-Oct-2026", the sheet's own date style (C6). */
const sheetDay = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
};

incomeStatementRouter.get('/export', requirePermission(`${FEATURE}.EXPORT`), async (req, res) => {
  const auth = req.auth!;
  const query = incomeStatementQuerySchema.parse(req.query);
  const { statement, company } = await withTenant(auth.tenantId, async (db) => ({
    statement: await build(db, auth.tenantId, query),
    company: (await letterheadOf(db, auth.tenantId)).companyName,
  }));

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Income statement');
  sheet.columns = [{ width: 46 }, { width: 18 }, { width: 18 }, { width: 18 }];
  const { currentMonth, ytd, previousYtd } = statement.periods;

  sheet.addRow([company]).font = { bold: true, size: 13 };
  sheet.addRow(['Income statement']).font = { bold: true, size: 12 };
  sheet.addRow([`Period: ${sheetDay(currentMonth.from)} to ${sheetDay(currentMonth.to)}`]);
  sheet.addRow([`YTD: ${sheetDay(ytd.from)} to ${sheetDay(ytd.to)} · Previous Year YTD: ${sheetDay(previousYtd.from)} to ${sheetDay(previousYtd.to)}`]);
  sheet.addRow(['Branch: All']);
  sheet.addRow([`Currency: ${statement.currencyCode}`]);
  sheet.addRow(['Basis: Accrual']);
  sheet.addRow([]);
  const header = sheet.addRow(['Particulars', 'Current Month', 'YTD', 'Previous Year YTD']);
  header.font = { bold: true };
  header.eachCell((cell, n) => {
    cell.alignment = { horizontal: n === 1 ? 'left' : 'right' };
    cell.border = { bottom: { style: 'thin' } };
  });

  for (const row of statement.rows) {
    const values = row.amounts.map((a) => (a === null ? null : Number(a)));
    const line = sheet.addRow([row.kind === 'LINE' ? `   ${row.label}` : row.label, ...values]);
    if (row.kind !== 'LINE') line.font = { bold: true };
    for (let column = 2; column <= 4; column += 1) {
      const cell = line.getCell(column);
      cell.numFmt =
        row.kind === 'PERCENT'
          ? '0.0"%";[Red]-0.0"%"'
          : row.deduction === true
            ? '(#,##0.00);(#,##0.00)'
            : '#,##0.00;[Red]-#,##0.00';
      cell.alignment = { horizontal: 'right' };
    }
    if (row.kind === 'TOTAL') line.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
  }

  const body = Buffer.from(await book.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="income-statement-${query.month}.xlsx"`);
  res.send(body);
});
