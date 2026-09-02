import PDFDocument from 'pdfkit';

/**
 * The Quotation document — MODULE_INQUIRY_QUOTATION.md §6.6.
 *
 * §6.6 is emphatic on one point and it shapes the signature: the header "must
 * come from the tenant, not be hardcoded". So the company name, the logo and
 * the three standing notes all arrive as data, and nothing about one forwarder
 * is written into this file.
 *
 * The other rule is §2.2's, inherited from the quotation itself: every figure
 * printed here is the one the database stored. Nothing is recomputed on the way
 * to the page — a document that disagrees with the record it came from is worse
 * than no document.
 */

export interface QuotationPdfInput {
  /** From tenant settings (§6.6). */
  companyName: string;
  companyAddress: string | null;
  /** PNG or JPEG bytes; omitted when the workspace has not uploaded one. */
  logo: Buffer | null;

  inquiryNo: string;
  inquiryDate: string | null;
  quotationNo: string;
  revisionNo: number;
  quotationDate: string;
  validTill: string | null;

  customerName: string;
  customerAddress: string | null;

  shipmentType: string;
  isAir: boolean;
  polName: string;
  podName: string;
  goodsTypeName: string | null;
  commodity: string;
  loadingType: string | null;
  tosName: string | null;
  modeName: string | null;
  carrierName: string | null;
  firstVesselName: string | null;
  transitType: string | null;
  etd: string | null;
  eta: string | null;

  /** §6.6 prints the rate on the line table. */
  conversionRate: string;
  localCurrencyCode: string;

  lines: {
    description: string;
    containerSize: string | null;
    unit: string | null;
    quantity: string;
    sellingPrice: string;
    total: string;
    currencyCode: string;
  }[];

  totalUsd: string;
  totalLocal: string;
  /** §5.3 rule 7's stored words, not recomputed here. */
  amountInWords: string;

  /** §6.6's standing notes, the tenant's own or the product default. */
  notes: string[];
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';

export function renderQuotationPdf(input: QuotationPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ---------------------------------------------------------- letterhead
    let headerX = left;
    if (input.logo !== null) {
      try {
        doc.image(input.logo, left, 36, { fit: [110, 44] });
        headerX = left + 122;
      } catch {
        // A logo that pdfkit cannot read is not a reason to withhold the
        // quotation. The name below carries the letterhead on its own.
        headerX = left;
      }
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(HULL).text(input.companyName, headerX, 40);
    if (input.companyAddress !== null && input.companyAddress !== '') {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(STEEL)
        .text(input.companyAddress, headerX, doc.y, { width: 330 });
    }

    let y = Math.max(doc.y, 84) + 10;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(HULL).text('QUOTATION', left, y, {
      width,
      align: 'center',
    });
    y = doc.y + 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 10;

    /** A label above its value, in a column. */
    const field = (label: string, value: string | null, x: number, w: number, atY: number): void => {
      doc.font('Helvetica').fontSize(6.5).fillColor(STEEL).text(label.toUpperCase(), x, atY, { width: w });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(HULL)
        .text(value === null || value === '' ? '—' : value, x, atY + 9, { width: w });
    };

    const col = width / 4;
    field('Inquiry No', input.inquiryNo, left, col - 8, y);
    field('Inquiry Date', input.inquiryDate, left + col, col - 8, y);
    field(
      'Quotation No',
      input.revisionNo > 1 ? `${input.quotationNo} (rev ${input.revisionNo})` : input.quotationNo,
      left + col * 2,
      col - 8,
      y,
    );
    field('Quotation Date', input.quotationDate, left + col * 3, col - 8, y);
    y += 32;
    field('Valid Till', input.validTill, left, col - 8, y);
    y += 34;

    // ------------------------------------------------------------------ to,
    doc.font('Helvetica').fontSize(9).fillColor(HULL).text('To,', left, y);
    y = doc.y + 2;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(HULL).text(input.customerName, left, y, {
      width: width / 2,
    });
    if (input.customerAddress !== null && input.customerAddress !== '') {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(STEEL)
        .text(input.customerAddress, left, doc.y, { width: width / 2 });
    }
    y = doc.y + 12;

    // --------------------------------------------------- the header field set
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;
    field('Shipment Type', input.shipmentType, left, col - 8, y);
    field(input.isAir ? 'AOL' : 'POL', input.polName, left + col, col - 8, y);
    field(input.isAir ? 'AOD' : 'POD', input.podName, left + col * 2, col - 8, y);
    field('Commodity', input.commodity, left + col * 3, col - 8, y);
    y += 32;
    field('Goods Type', input.goodsTypeName, left, col - 8, y);
    field('Loading Type', input.loadingType, left + col, col - 8, y);
    field('TOS', input.tosName, left + col * 2, col - 8, y);
    field('Mode', input.modeName, left + col * 3, col - 8, y);
    y += 32;
    field(input.isAir ? 'Airlines' : 'Carrier', input.carrierName, left, col - 8, y);
    field('First Vessel', input.firstVesselName, left + col, col - 8, y);
    field('Transit Type', input.transitType, left + col * 2, col - 8, y);
    field('ETD / ETA', `${input.etd ?? '—'} / ${input.eta ?? '—'}`, left + col * 3, col - 8, y);
    y += 36;

    // ----------------------------------------------------------- the lines
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;

    const headers = ['Description', 'Size', 'Unit', 'Qty', 'Rate', 'Amount'];
    const widths = [200, 60, 60, 55, 80, 68];
    const numeric = [false, false, false, true, true, true];

    const row = (cells: string[], bold: boolean): void => {
      let x = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(bold ? HULL : '#1A2B3C');
      cells.forEach((cell, i) => {
        doc.text(cell, x, y, {
          width: widths[i]! - 4,
          align: numeric[i] === true ? 'right' : 'left',
          lineBreak: false,
        });
        x += widths[i]!;
      });
      y += bold ? 15 : 13;
    };

    row(headers, true);
    doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor(LINE).stroke();
    y += 2;

    for (const line of input.lines) {
      if (y > doc.page.height - 200) {
        doc.addPage();
        y = doc.page.margins.top;
        row(headers, true);
      }
      row(
        [
          line.description,
          line.containerSize ?? '—',
          line.unit ?? '—',
          line.quantity,
          `${line.currencyCode} ${line.sellingPrice}`,
          `${line.currencyCode} ${line.total}`,
        ],
        false,
      );
    }

    y += 3;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 6;

    // §6.6 prints the frozen rate beside the totals — the number the local
    // figure was computed from, so the customer can check the arithmetic.
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(STEEL)
      .text(`Conversion Rate: 1 USD = ${input.conversionRate} ${input.localCurrencyCode}`, left, y);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(HULL)
      .text(`Total: USD ${input.totalUsd}`, left, y, { width, align: 'right' });
    y = doc.y + 2;
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(HULL)
      .text(`${input.localCurrencyCode} ${input.totalLocal}`, left, y, { width, align: 'right' });
    y = doc.y + 8;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(HULL).text('In word (USD): ', left, y, {
      continued: true,
    });
    doc.font('Helvetica').fillColor(HULL).text(input.amountInWords);
    y = doc.y + 14;

    // ------------------------------------------------------------- the notes
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(HULL).text('Notes', left, y);
    y = doc.y + 3;
    input.notes.forEach((note, i) => {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#1A2B3C')
        .text(`${i + 1}. ${note}`, left, y, { width: width - 40 });
      y = doc.y + 2;
    });

    // --------------------------------------------------------------- signed
    y = Math.max(y + 26, doc.page.height - 96);
    doc.font('Helvetica').fontSize(9).fillColor(STEEL).text('For and on behalf of', left, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(HULL).text(input.companyName, left, doc.y + 2);

    doc.end();
  });
}
