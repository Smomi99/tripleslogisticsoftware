import { type FreightRateDto, purchasePrice, type RateMode } from '@ff/shared';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Price List export (docs/MODULE_PURCHASE_SALES.md §5.3, §4 rule 12).
 *
 * "Produces Excel and PDF of exactly the filtered rows the user is looking at,
 * respecting rule 5 — never include buy price or profit in an export the user
 * isn't permitted to see."
 *
 * The rows handed in here have ALREADY been through lib/rate-visibility, so a
 * withheld buy price is absent rather than blank. This module therefore decides
 * what to print purely from what it was given: it asks whether the key exists,
 * never whether the caller has a permission. That keeps one enforcement point
 * instead of two that can disagree — and a file is the worse place to get it
 * wrong, because a spreadsheet gets forwarded.
 *
 * Client decision, 2026-09-06: the price-list route now strips the cost columns
 * for everyone, so in practice showBuy is false there. The branches below stay
 * because this module's job is to print what it was handed, and the day another
 * caller hands it cost data the columns should appear rather than silently
 * vanish. That the spreadsheet gets forwarded is exactly why the caller decides
 * and not this file.
 */

/**
 * The fixed columns before the per-tier prices, in order.
 *
 * Named because the numeric formatting below has to know where the prices
 * start, and counting them by hand is how that index goes stale.
 */
/** The sheet's header row. Rows 1-3 are the title block above it. */
const HEADER_ROW = 4;

const LEAD_COLUMNS = [
  'Code',
  'POL',
  'POD',
  'Carrier',
  'Goods type',
  'Currency',
  'Route',
  'Transit days',
  'Free days',
  'Valid from',
  'Valid to',
  'Status',
] as const;

const MODE_TITLE: Record<RateMode, string> = {
  SEA_FCL: 'Sea FCL Price List',
  SEA_LCL: 'Sea LCL Price List',
  AIR: 'Air Price List',
};

/** True when the caller was permitted the cost columns (§4 rule 5). */
function includesBuyPrice(rates: FreightRateDto[]): boolean {
  return rates.some((rate) => rate.lines.some((line) => line.buyPrice !== undefined));
}

/**
 * One rate's local charges, written out in the cell that totals them.
 *
 * "Seal Charge (POL, 20STD) 13.0000 USD, ENS Charge (POL) 30.0000 USD".
 *
 * In the cell rather than on a sheet of its own, because a price list is read
 * one row at a time: whoever is looking at a lane's total wants to know what
 * makes it up without leaving the row, and a second sheet makes them find the
 * rate again somewhere else. The numeric total keeps its own column beside
 * this, so the sheet still sums.
 */
function chargeBreakdown(rate: FreightRateDto): string {
  return rate.localCharges
    .map((charge) => {
      const where = [charge.side, charge.containerSizeCode]
        .filter((part): part is string => part !== null && part !== undefined && part !== '')
        .join(', ');
      const label = where === '' ? charge.costHeadName : `${charge.costHeadName} (${where})`;
      return `${label} ${purchasePrice(charge.amount)} ${charge.currencyCode}`;
    })
    .join(', ');
}

/** Tier columns present across the result set, in the order they appear. */
function tierColumns(rates: FreightRateDto[]): { id: string; code: string }[] {
  const seen = new Map<string, string>();
  for (const rate of rates) {
    for (const line of rate.lines) {
      if (!seen.has(line.tierId)) seen.set(line.tierId, line.tierCode);
    }
  }
  return [...seen].map(([id, code]) => ({ id, code }));
}

/**
 * The PDF's columns, in order.
 *
 * Lifted out of the renderer so a test can assert what the page carries. A
 * PDF's text is font-subset encoded once it is written, so reading the bytes
 * back proves nothing about whether a column is present — the structure has to
 * be checkable before it becomes glyphs.
 */
export function pdfColumns(
  tiers: { id: string; code: string }[],
  showBuy: boolean,
): { label: string; width: number }[] {
  return [
    { label: 'Code', width: 58 },
    // Wider than the code columns they replace: a port name needs the room,
    // and a reader should not have to decode CGP on a printed sheet.
    { label: 'POL', width: 84 },
    { label: 'POD', width: 84 },
    { label: 'Carrier', width: 92 },
    { label: 'Route', width: 78 },
    { label: 'Validity', width: 108 },
    ...tiers.map((t) => ({ label: t.code, width: 62 })),
    ...(showBuy ? tiers.map((t) => ({ label: `${t.code} buy`, width: 62 })) : []),
  ];
}

export interface ExportContext {
  mode: RateMode;
  rates: FreightRateDto[];
  /** Named on the sheet so a forwarded file still says where it came from. */
  workspaceName: string;
  generatedBy: string;
}

export async function buildRateWorkbook(context: ExportContext): Promise<Buffer> {
  const { mode, rates } = context;
  const showBuy = includesBuyPrice(rates);
  const tiers = tierColumns(rates);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = context.workspaceName;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(MODE_TITLE[mode], {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }],
  });

  sheet.mergeCells('A1:D1');
  sheet.getCell('A1').value = MODE_TITLE[mode];
  sheet.getCell('A1').font = { size: 14, bold: true };
  sheet.getCell('A2').value = `${context.workspaceName} · exported ${new Date()
    .toISOString()
    .slice(0, 10)} by ${context.generatedBy}`;
  sheet.getCell('A2').font = { size: 9, color: { argb: 'FF6B7A88' } };

  const header = [
    ...LEAD_COLUMNS,
    ...tiers.map((t) => `${t.code} sell`),
    ...(showBuy ? tiers.map((t) => `${t.code} buy`) : []),
    'Local charges',
  ];

  sheet.getRow(4).values = header;
  sheet.getRow(4).font = { bold: true };
  sheet.getRow(4).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF4F6F5' },
  };

  for (const rate of rates) {
    const priceOf = (tierId: string, which: 'sell' | 'buy'): number | string => {
      const line = rate.lines.find((l) => l.tierId === tierId);
      if (line === undefined) return '';
      const raw = which === 'sell' ? line.sellPrice : line.buyPrice;
      return raw === undefined ? '' : Number(raw);
    };

    sheet.addRow([
      rate.code,
      // The name, not the code. Somebody reading a forwarded spreadsheet knows
      // Chittagong and would have to look up CGP.
      rate.polName,
      rate.podName,
      rate.carrierName,
      rate.goodsTypeName,
      rate.currencyCode,
      rate.route ?? '',
      rate.transitDays ?? '',
      rate.freeDays ?? '',
      rate.validFrom,
      rate.validTo,
      rate.status,
      ...tiers.map((t) => priceOf(t.id, 'sell')),
      ...(showBuy ? tiers.map((t) => priceOf(t.id, 'buy')) : []),
      chargeBreakdown(rate),
    ]);
  }

  // Numeric columns get a real number format so Excel sums them. The tier
  // prices, then the local charge TOTAL — the breakdown between them is text
  // and must not be formatted as a number.
  //
  // Derived from LEAD_COLUMNS rather than written as a literal. It used to be
  // a hardcoded 12, which adding one column ahead of the prices silently
  // shifted — the formatting would have landed on Status and the last tier
  // would have gone unformatted, with nothing to say so.
  const firstPriceColumn = LEAD_COLUMNS.length + 1;
  const tierColumnCount = tiers.length * (showBuy ? 2 : 1);
  for (let i = 0; i < tierColumnCount; i += 1) {
    /*
      Decimals only where a price actually has them (client, 2026-09-12).
      '#,##0.0000' printed 223.0000 for a price of 223, on every row of every
      export. The cell still holds the exact value — this is the display, so a
      per-CBM rate that really is 1450.5 is not quietly rounded in a
      spreadsheet somebody is about to compute with.
    */
    sheet.getColumn(firstPriceColumn + i).numFmt = '#,##0.####';
    sheet.getColumn(firstPriceColumn + i).alignment = { horizontal: 'right' };
  }

  /*
    Width from the widest cell in the column, not from the header.

    It used to measure row 4 — the header — alone, so any column whose data ran
    longer than its title was cut off in the file: "Evergreen Line" under a
    "Carrier" heading came out truncated, and nothing on the sheet said so.
    Capped, because the local-charge breakdown is a sentence and would
    otherwise push every other column off the screen.
  */
  sheet.columns.forEach((column, index) => {
    let longest = 0;
    // From the header row down. The title block above it is merged prose and
    // would size every column to the width of the report name.
    for (let rowNumber = HEADER_ROW; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const value = sheet.getRow(rowNumber).getCell(index + 1).value;
      const text = value === null || value === undefined ? '' : String(value);
      longest = Math.max(longest, text.length);
    }
    column.width = Math.min(56, Math.max(12, longest + 2));
  });
  // The breakdown is a sentence, not a figure. Wide enough to read, and
  // wrapped so a long one does not run across the sheet. Last column now that
  // the total is gone, and derived so it stays put if another one is added.
  const breakdownColumn = sheet.getColumn(firstPriceColumn + tierColumnCount);
  breakdownColumn.width = 52;
  breakdownColumn.alignment = { wrapText: true, vertical: 'top' };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function buildRatePdf(context: ExportContext): Promise<Buffer> {
  const { mode, rates } = context;
  const showBuy = includesBuyPrice(rates);
  const tiers = tierColumns(rates);

  return new Promise((resolve, reject) => {
    // Landscape: a price list is wider than it is tall, always.
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).fillColor('#10243A').text(MODE_TITLE[mode]);
    doc
      .fontSize(8)
      .fillColor('#6B7A88')
      .text(
        `${context.workspaceName} · exported ${new Date().toISOString().slice(0, 10)} by ${
          context.generatedBy
        }`,
      );
    doc.moveDown(0.8);

    const columns = pdfColumns(tiers, showBuy);

    const startX = doc.page.margins.left;
    let y = doc.y;

    const drawRow = (cells: string[], bold: boolean): void => {
      // A new page whenever the next row would cross the bottom margin.
      if (y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      let x = startX;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
      doc.fillColor(bold ? '#10243A' : '#10243A');
      cells.forEach((cell, index) => {
        const column = columns[index]!;
        doc.text(cell, x, y, { width: column.width - 4, ellipsis: true, lineBreak: false });
        x += column.width;
      });
      y += 14;
      doc
        .moveTo(startX, y - 4)
        .lineTo(x, y - 4)
        .strokeColor('#DDE3E3')
        .lineWidth(0.5)
        .stroke();
    };

    /** One indented line under a rate: what the charge is, and what it costs. */
    const drawDetail = (label: string, amount: string, bold = false): void => {
      if (y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
      doc.fillColor('#6B7A88');
      doc.text(label, startX + 16, y, { width: 320, ellipsis: true, lineBreak: false });
      doc.text(amount, startX + 340, y, { width: 110, lineBreak: false });
      y += 11;
    };

    drawRow(
      columns.map((c) => c.label),
      true,
    );

    for (const rate of rates) {
      const priceOf = (tierId: string, which: 'sell' | 'buy'): string => {
        const line = rate.lines.find((l) => l.tierId === tierId);
        if (line === undefined) return '—';
        const raw = which === 'sell' ? line.sellPrice : line.buyPrice;
        if (raw === undefined) return '—';
        /*
          The currency rides with the sell price (client, 2026-09-12). A column
          of its own would be tidier, but the table already runs to 1000pt on
          four tiers with buy prices against 778pt of landscape A4, and adding
          width is the wrong direction. The buy figure underneath is in the
          same currency and its column says "buy", so it stays bare.
        */
        return which === 'sell'
          ? `${purchasePrice(raw)} ${rate.currencyCode}`
          : purchasePrice(raw);
      };

      drawRow(
        [
          rate.code,
          rate.polName,
          rate.podName,
          rate.carrierName,
          rate.route ?? '—',
          `${rate.validFrom} – ${rate.validTo}`,
          ...tiers.map((t) => priceOf(t.id, 'sell')),
          ...(showBuy ? tiers.map((t) => priceOf(t.id, 'buy')) : []),
        ],
        false,
      );

      /*
       * The local charges, indented under the rate they belong to.
       *
       * A PDF is read rather than filtered, so here the breakdown belongs
       * beside its rate — the opposite call to the spreadsheet, for the
       * opposite reason: a PDF is read rather than filtered, so the charges
       * belong beside the rate they price.
       *
       * No total across them (client decision, 2026-09-06). Each cost head
       * carries its own currency, so summing them produced a figure nobody
       * could bill from while looking exactly like one they could.
       */
      for (const charge of rate.localCharges) {
        drawDetail(
          `${charge.costHeadName} · ${charge.side}` +
            (charge.containerSizeCode === null ? '' : ` · ${charge.containerSizeCode}`),
          `${purchasePrice(charge.amount)} ${charge.currencyCode}`,
        );
      }
    }

    if (rates.length === 0) {
      doc.fontSize(9).fillColor('#6B7A88').text('No rates matched these filters.', startX, y + 6);
    }

    doc.end();
  });
}

export function exportFilename(mode: RateMode, extension: 'xlsx' | 'pdf'): string {
  const slug = MODE_TITLE[mode].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${slug}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}
