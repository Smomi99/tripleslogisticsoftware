import type { FreightRateDto, RateMode } from '@ff/shared';
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
 */

const MODE_TITLE: Record<RateMode, string> = {
  SEA_FCL: 'Sea FCL Price List',
  SEA_LCL: 'Sea LCL Price List',
  AIR: 'Air Price List',
};

/** True when the caller was permitted the cost columns (§4 rule 5). */
function includesBuyPrice(rates: FreightRateDto[]): boolean {
  return rates.some((rate) => rate.lines.some((line) => line.buyPrice !== undefined));
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
    'Code',
    'POL',
    'POD',
    'Carrier',
    'Goods type',
    'Currency',
    'Transit days',
    'Free days',
    'Valid from',
    'Valid to',
    'Status',
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
      rate.transitDays ?? '',
      rate.freeDays ?? '',
      rate.validFrom,
      rate.validTo,
      rate.status,
      ...tiers.map((t) => priceOf(t.id, 'sell')),
      ...(showBuy ? tiers.map((t) => priceOf(t.id, 'buy')) : []),
      rate.localChargeCount === 0 ? '' : Number(rate.localChargeTotal),
    ]);
  }

  // Numeric columns get a real number format so Excel sums them.
  const firstPriceColumn = 12;
  const priceColumnCount = tiers.length * (showBuy ? 2 : 1) + 1;
  for (let i = 0; i < priceColumnCount; i += 1) {
    sheet.getColumn(firstPriceColumn + i).numFmt = '#,##0.0000';
    sheet.getColumn(firstPriceColumn + i).alignment = { horizontal: 'right' };
  }
  sheet.columns.forEach((column) => {
    column.width = Math.max(12, String(column.values?.[4] ?? '').length + 4);
  });

  /*
   * Local charges, one row each, on a sheet of their own.
   *
   * The main sheet keeps a total per rate because that is what makes it a
   * price list — one row per lane, sortable and summable. The breakdown cannot
   * live there without breaking that: charges vary in number per rate, so
   * putting them inline turns every formula and filter into a special case.
   *
   * A second sheet keyed by rate code answers the same question without
   * damaging the first, and Excel is built for exactly this — filter the sheet
   * by a code and you have that rate's charges.
   */
  const charges = rates.flatMap((rate) =>
    rate.localCharges.map((charge) => ({ rate, charge })),
  );

  if (charges.length > 0) {
    const detail = workbook.addWorksheet('Local charges', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    detail.getRow(1).values = [
      'Rate code',
      'POL',
      'POD',
      'Carrier',
      'Cost head',
      'Side',
      'Container',
      'Unit',
      'Amount',
      'Currency',
      'Remarks',
    ];
    detail.getRow(1).font = { bold: true };
    detail.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF4F6F5' },
    };

    for (const { rate, charge } of charges) {
      detail.addRow([
        rate.code,
        rate.polName,
        rate.podName,
        rate.carrierName,
        charge.costHeadName,
        charge.side,
        // "All" is the client's own wording for a charge that bills whatever
        // the equipment — a documentation fee rather than a per-box one.
        charge.containerSizeCode ?? 'All',
        charge.costUnitName ?? '',
        Number(charge.amount),
        charge.currencyCode,
        charge.remarks ?? '',
      ]);
    }

    detail.getColumn(9).numFmt = '#,##0.0000';
    detail.getColumn(9).alignment = { horizontal: 'right' };
    detail.columns.forEach((column) => {
      column.width = Math.max(12, String(column.values?.[1] ?? '').length + 6);
    });
  }

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

    const columns = [
      { label: 'Code', width: 58 },
      // Wider than the code columns they replace: a port name needs the room,
      // and a reader should not have to decode CGP on a printed sheet.
      { label: 'POL', width: 84 },
      { label: 'POD', width: 84 },
      { label: 'Carrier', width: 92 },
      { label: 'Validity', width: 108 },
      ...tiers.map((t) => ({ label: t.code, width: 62 })),
      ...(showBuy ? tiers.map((t) => ({ label: `${t.code} buy`, width: 62 })) : []),
    ];

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
        return raw ?? '—';
      };

      drawRow(
        [
          rate.code,
          rate.polName,
          rate.podName,
          rate.carrierName,
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
       * opposite reason. A total with no breakdown is the thing a carrier
       * queries first, and answering it should not mean opening the app.
       */
      for (const charge of rate.localCharges) {
        drawDetail(
          `${charge.costHeadName} · ${charge.side}` +
            (charge.containerSizeCode === null ? '' : ` · ${charge.containerSizeCode}`),
          `${charge.amount} ${charge.currencyCode}`,
        );
      }
      if (rate.localCharges.length > 0) {
        drawDetail('Local charges total', `${rate.localChargeTotal} ${rate.currencyCode}`, true);
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
