import PDFDocument from 'pdfkit';

/**
 * The Debit Invoice document — docs/MODULE_ACCOUNTS.md §9, what `Print` and
 * `Save & Send` put in front of the customer (sheet D64, C64).
 *
 * Two rules shape it.
 *
 * It carries the SELLING side only. The cost blocks, what the carrier charged
 * and the margin are the forwarder's business (§3.9) — they are not passed in,
 * so no future edit to this file can print them by accident.
 *
 * Every figure is the one the database stored, never re-added here — the
 * quotation's rule (§5.3 rule 6): a document that disagrees with the record it
 * came from is worse than no document.
 */

export interface DebitInvoicePdfInput {
  companyName: string;
  companyAddress: string | null;
  logo: Buffer | null;

  invoiceNo: string;
  invoiceDate: string;
  /** DRAFT and CANCELLED are watermarked; an issued invoice is not. */
  status: 'DRAFT' | 'ISSUED' | 'CANCELLED';

  customerName: string;
  customerAddress: string | null;

  /** Null on an OTHER invoice raised without a booking. */
  booking: {
    bookingNo: string;
    quotationNo: string | null;
    inquiryNo: string | null;
    shipmentType: string;
    isAir: boolean;
    polName: string;
    podName: string;
    carrierName: string;
    commodity: string;
    requiredContainer: string;
  } | null;

  currencyCode: string;
  lines: {
    description: string;
    containerSize: string | null;
    unit: string | null;
    quantity: string;
    unitPrice: string;
    amount: string;
  }[];
  total: string;
  amountInWords: string;

  /**
   * §12 Q6: when the invoice is not in the workspace's base currency, the
   * frozen rate and the base equivalent — the rate the payment is booked at.
   * Null when it is in the base.
   */
  baseEquivalent: { baseCurrencyCode: string; rate: string; totalBase: string } | null;
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';
const ALERT = '#B3403A';

export function renderDebitInvoicePdf(input: DebitInvoicePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    /*
     * A draft that can be mistaken for an invoice is the one way this page does
     * real damage — a customer pays against numbers nobody has approved. The
     * BL draft's watermark, for the same reason.
     */
    const watermark = (): void => {
      if (input.status === 'ISSUED') return;
      doc.save();
      doc
        .rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font('Helvetica-Bold')
        .fontSize(90)
        .fillColor(input.status === 'CANCELLED' ? ALERT : STEEL)
        .opacity(0.12)
        .text(input.status, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.opacity(1);
    };
    watermark();
    doc.on('pageAdded', watermark);

    // ---------------------------------------------------------- letterhead
    let headerX = left;
    if (input.logo !== null) {
      try {
        doc.image(input.logo, left, 36, { fit: [110, 44] });
        headerX = left + 122;
      } catch {
        // An unreadable logo is not a reason to withhold the invoice.
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
    doc.font('Helvetica-Bold').fontSize(13).fillColor(HULL).text('DEBIT NOTE', left, y, {
      width,
      align: 'center',
    });
    y = doc.y + 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 10;

    const field = (label: string, value: string | null, x: number, w: number, atY: number): void => {
      doc.font('Helvetica').fontSize(6.5).fillColor(STEEL).text(label.toUpperCase(), x, atY, { width: w });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(HULL)
        .text(value === null || value === '' ? '—' : value, x, atY + 9, { width: w });
    };

    const col = width / 4;
    field('Debit Invoice No', input.invoiceNo, left, col - 8, y);
    field('Date', input.invoiceDate, left + col, col - 8, y);
    field('Booking No', input.booking?.bookingNo ?? null, left + col * 2, col - 8, y);
    field('Quotation No', input.booking?.quotationNo ?? null, left + col * 3, col - 8, y);
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

    // ----------------------------------------------------- the shipment
    if (input.booking !== null) {
      const b = input.booking;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
      y += 8;
      field('Shipment Type', b.shipmentType, left, col - 8, y);
      field(b.isAir ? 'AOL' : 'POL', b.polName, left + col, col - 8, y);
      field(b.isAir ? 'AOD' : 'POD', b.podName, left + col * 2, col - 8, y);
      field(b.isAir ? 'Airlines' : 'Carrier', b.carrierName, left + col * 3, col - 8, y);
      y += 32;
      field('Commodity', b.commodity, left, col * 2 - 8, y);
      field('Required Container', b.requiredContainer, left + col * 2, col - 8, y);
      field('Inquiry No', b.inquiryNo, left + col * 3, col - 8, y);
      y += 36;
    }

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
          `${input.currencyCode} ${line.unitPrice}`,
          `${input.currencyCode} ${line.amount}`,
        ],
        false,
      );
    }

    y += 3;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 6;

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(HULL)
      .text(`Total: ${input.currencyCode} ${input.total}`, left, y, { width, align: 'right' });
    y = doc.y + 2;

    if (input.baseEquivalent !== null) {
      const eq = input.baseEquivalent;
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(STEEL)
        .text(
          `Conversion rate: 1 ${input.currencyCode} = ${eq.rate} ${eq.baseCurrencyCode}   ·   ` +
            `Total in ${eq.baseCurrencyCode}: ${eq.totalBase}`,
          left,
          y,
          { width, align: 'right' },
        );
      y = doc.y + 4;
    }
    y += 6;

    if (input.amountInWords !== '') {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(HULL)
        .text(`In word (${input.currencyCode}): `, left, y, { continued: true });
      doc.font('Helvetica').fillColor(HULL).text(input.amountInWords);
      y = doc.y + 14;
    }

    // --------------------------------------------------------------- signed
    y = Math.max(y + 26, doc.page.height - 96);
    doc.font('Helvetica').fontSize(9).fillColor(STEEL).text('For and on behalf of', left, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(HULL).text(input.companyName, left, doc.y + 2);

    doc.end();
  });
}
