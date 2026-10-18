import ExcelJS from 'exceljs';
import { Router } from 'express';

import {
  type ApiSuccess,
  type BalanceSheetDto,
  balanceSheetQuerySchema,
  type CashFlowDto,
  cashFlowQuerySchema,
  INCOME_STATEMENT_BASIS_LABEL,
  isoCurrency,
  type StatementRowDto,
} from '@ff/shared';

import { balanceSheet } from '../lib/balance-sheet';
import { cashFlowStatement } from '../lib/cash-flow';
import { baseCurrency } from '../lib/currency-rate';
import { letterheadOf } from '../lib/letterhead';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Accounts → Balance Sheet and Cash Flow Statement (Menu M15, M16).
 *
 *   GET /balance-sheet           the position on a day, and a year before
 *   GET /balance-sheet/export    the same as an Excel workbook
 *   GET /cash-flow               the cash flows of a month, YTD and last YTD
 *   GET /cash-flow/export        the same as an Excel workbook
 *
 * Read-only, on the existing ACCOUNTS.BALANCE_SHEET and
 * ACCOUNTS.CASH_FLOW_STATEMENT features (VIEW, EXPORT). How each figure is
 * made is lib/balance-sheet.ts and lib/cash-flow.ts.
 */

export const financialStatementsRouter: Router = Router();
financialStatementsRouter.use(authenticate);

const BALANCE = 'ACCOUNTS.BALANCE_SHEET';
const CASH_FLOW = 'ACCOUNTS.CASH_FLOW_STATEMENT';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-01" → "01-Oct-2026", the Income Statement's date style. */
const sheetDay = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
};

/** One statement as a workbook, laid out as the screen lays it out. */
async function workbook(input: {
  company: string;
  title: string;
  header: string[];
  columns: string[];
  rows: StatementRowDto[];
}): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(input.title);
  sheet.columns = [{ width: 52 }, ...input.columns.map(() => ({ width: 20 }))];
  sheet.addRow([input.company]).font = { bold: true, size: 13 };
  sheet.addRow([input.title]).font = { bold: true, size: 12 };
  for (const line of input.header) sheet.addRow([line]);
  sheet.addRow([]);
  const head = sheet.addRow(['Particulars', ...input.columns]);
  head.font = { bold: true };
  head.eachCell((cell, n) => {
    cell.alignment = { horizontal: n === 1 ? 'left' : 'right' };
    cell.border = { bottom: { style: 'thin' } };
  });
  for (const row of input.rows) {
    const label = row.kind === 'LINE' ? `   ${row.label}` : row.label;
    const line = sheet.addRow([label, ...row.amounts.map((a) => (a === null ? null : Number(a)))]);
    if (row.kind !== 'LINE') line.font = { bold: true };
    for (let column = 2; column <= input.columns.length + 1; column += 1) {
      const cell = line.getCell(column);
      cell.numFmt = '#,##0.00;[Red]-#,##0.00';
      cell.alignment = { horizontal: 'right' };
    }
    if (row.kind === 'TOTAL') line.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

function sendWorkbook(res: import('express').Response, body: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

// ---------------------------------------------------------------- balance sheet

async function buildBalanceSheet(tenantId: bigint, query: ReturnType<typeof balanceSheetQuerySchema.parse>) {
  return withTenant(tenantId, async (db) => {
    const base = await baseCurrency(db, tenantId);
    const statement = await balanceSheet(db, tenantId, {
      ...query,
      currencyCode: base === null ? 'Base' : isoCurrency(base.currency),
      base,
    });
    return { statement, company: (await letterheadOf(db, tenantId)).companyName };
  });
}

financialStatementsRouter.get('/balance-sheet', requirePermission(`${BALANCE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = balanceSheetQuerySchema.parse(req.query);
  const { statement } = await buildBalanceSheet(auth.tenantId, query);
  const payload: ApiSuccess<BalanceSheetDto> = { success: true, data: statement };
  res.json(payload);
});

financialStatementsRouter.get('/balance-sheet/export', requirePermission(`${BALANCE}.EXPORT`), async (req, res) => {
  const auth = req.auth!;
  const query = balanceSheetQuerySchema.parse(req.query);
  const { statement, company } = await buildBalanceSheet(auth.tenantId, query);
  const body = await workbook({
    company,
    title: 'Balance Sheet',
    header: [
      `As at ${sheetDay(query.asOf)}`,
      'Branch: All',
      `Currency: ${statement.currencyCode}`,
      `Basis: ${INCOME_STATEMENT_BASIS_LABEL[statement.basis]}`,
    ],
    columns: statement.columns.map((c) => sheetDay(c.asOf)),
    rows: statement.rows,
  });
  sendWorkbook(res, body, `balance-sheet-${query.asOf}-${query.basis.toLowerCase()}.xlsx`);
});

// -------------------------------------------------------------------- cash flow

async function buildCashFlow(tenantId: bigint, query: ReturnType<typeof cashFlowQuerySchema.parse>) {
  return withTenant(tenantId, async (db) => {
    const base = await baseCurrency(db, tenantId);
    const statement = await cashFlowStatement(db, tenantId, {
      ...query,
      currencyCode: base === null ? 'Base' : isoCurrency(base.currency),
    });
    return { statement, company: (await letterheadOf(db, tenantId)).companyName };
  });
}

financialStatementsRouter.get('/cash-flow', requirePermission(`${CASH_FLOW}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = cashFlowQuerySchema.parse(req.query);
  const { statement } = await buildCashFlow(auth.tenantId, query);
  const payload: ApiSuccess<CashFlowDto> = { success: true, data: statement };
  res.json(payload);
});

financialStatementsRouter.get('/cash-flow/export', requirePermission(`${CASH_FLOW}.EXPORT`), async (req, res) => {
  const auth = req.auth!;
  const query = cashFlowQuerySchema.parse(req.query);
  const { statement, company } = await buildCashFlow(auth.tenantId, query);
  const { currentMonth, ytd, previousYtd } = statement.periods;
  const body = await workbook({
    company,
    title: 'Cash Flow Statement',
    header: [
      `Period: ${sheetDay(currentMonth.from)} to ${sheetDay(currentMonth.to)}`,
      'Branch: All',
      `Currency: ${statement.currencyCode}`,
      'Method: Direct',
    ],
    columns: [
      `Current Month`,
      `YTD (${sheetDay(ytd.from)} – ${sheetDay(ytd.to)})`,
      `Previous Year YTD (${sheetDay(previousYtd.from)} – ${sheetDay(previousYtd.to)})`,
    ],
    rows: statement.rows,
  });
  sendWorkbook(res, body, `cash-flow-${query.month}.xlsx`);
});
