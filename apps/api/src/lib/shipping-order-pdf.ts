import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * The Shipping Order document — MODULE_BOOKING_CARGO.md §6.6.
 *
 * §5.4 rule 4: "The PDF carries the tenant's letterhead, address and QR code —
 * from tenant settings, not hardcoded, exactly as the Quotation PDF." So every
 * word of the header comes in as data; nothing about one forwarder is written
 * into this file.
 *
 * §9 Q5, answered 2026-09-02: the QR is the compact offline payload, because
 * the reader is a warehouse gate in a yard with no signal.
 */

export interface ShippingOrderPdfInput {
  /** From tenant settings (§5.4 rule 4). */
  companyName: string;
  companyAddress: string | null;

  soNo: string;
  bookingNo: string;
  quotationNo: string;
  issueDate: string;
  qrPayload: string;

  customerName: string;
  exporterName: string | null;
  exporterAddress: string | null;
  importerName: string | null;
  importerAddress: string | null;

  isAir: boolean;
  carrierName: string;
  firstVesselOrFlight: string | null;
  polName: string;
  podName: string;
  cutOff: string | null;
  etd: string | null;
  eta: string | null;
  warehouseCfs: string | null;

  lines: {
    poNo: string;
    itemCode: string;
    sku: string | null;
    ctnQty: number;
    pcsQty: number | null;
    netWeightKg: string | null;
    grossWeightKg: string | null;
    volumeCbm: string | null;
    chargeableWtKg: string | null;
  }[];
  totals: {
    ctnQty: number;
    pcsQty: number;
    netWeightKg: string;
    grossWeightKg: string;
    volumeCbm: string;
    chargeableWtKg: string;
  };
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';

export async function renderShippingOrderPdf(input: ShippingOrderPdfInput): Promise<Buffer> {
  // Generated before the document opens: pdfkit's stream ends synchronously and
  // awaiting inside it would close the file before the image landed.
  const qr = await QRCode.toBuffer(input.qrPayload, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 220,
  });

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
    doc.font('Helvetica-Bold').fontSize(15).fillColor(HULL).text(input.companyName, left, 40);
    if (input.companyAddress !== null && input.companyAddress !== '') {
      doc.font('Helvetica').fontSize(8).fillColor(STEEL).text(input.companyAddress, { width: 320 });
    }

    // The QR sits top-right, where a hand reaching for a scanner expects it.
    doc.image(qr, right - 78, 36, { width: 78 });

    doc.moveDown(1.2);
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(HULL)
      .text('SHIPPING ORDER', left, doc.y, { width: width - 90 });

    let y = doc.y + 10;
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
    field('S/O No', input.soNo, left, col - 8, y);
    field('Booking No', input.bookingNo, left + col, col - 8, y);
    field('Quotation No', input.quotationNo, left + col * 2, col - 8, y);
    field('Issue date', input.issueDate, left + col * 3, col - 8, y);
    y += 32;

    field('Customer', input.customerName, left, col * 2 - 8, y);
    field(input.isAir ? 'Airlines' : 'Carrier', input.carrierName, left + col * 2, col - 8, y);
    field(
      input.isAir ? 'First flight' : 'First vessel',
      input.firstVesselOrFlight,
      left + col * 3,
      col - 8,
      y,
    );
    y += 32;

    field('Exporter', input.exporterName, left, col * 2 - 8, y);
    field('Importer', input.importerName, left + col * 2, col * 2 - 8, y);
    y += 32;
    if (input.exporterAddress !== null || input.importerAddress !== null) {
      field('Exporter address', input.exporterAddress, left, col * 2 - 8, y);
      field('Importer address', input.importerAddress, left + col * 2, col * 2 - 8, y);
      y += 32;
    }

    field(input.isAir ? 'AOL' : 'POL', input.polName, left, col - 8, y);
    field(input.isAir ? 'AOD' : 'POD', input.podName, left + col, col - 8, y);
    field('Cut off', input.cutOff, left + col * 2, col - 8, y);
    field('Warehouse / CFS', input.warehouseCfs, left + col * 3, col - 8, y);
    y += 32;

    field('ETD', input.etd, left, col - 8, y);
    field('ETA', input.eta, left + col, col - 8, y);
    y += 34;

    // -------------------------------------------------------------- cargo
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;

    // Chargeable weight is an air column only (§2.3).
    const headers = input.isAir
      ? ['PO', 'Item', 'SKU', 'CTN', 'PCS', 'N.WT', 'G.WT', 'CBM', 'Chg WT']
      : ['PO', 'Item', 'SKU', 'CTN', 'PCS', 'N.WT', 'G.WT', 'CBM'];
    const widths = input.isAir
      ? [70, 70, 60, 38, 38, 55, 55, 55, 55]
      : [80, 80, 70, 45, 45, 65, 65, 65];
    const numeric = headers.map((h) => !['PO', 'Item', 'SKU'].includes(h));

    const row = (cells: (string | number)[], bold: boolean): void => {
      let x = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(bold ? HULL : '#1A2B3C');
      cells.forEach((cell, i) => {
        doc.text(String(cell), x, y, {
          width: widths[i]! - 4,
          align: numeric[i] === true ? 'right' : 'left',
          lineBreak: false,
        });
        x += widths[i]!;
      });
      y += bold ? 14 : 12;
    };

    row(headers, true);
    doc.moveTo(left, y - 2).lineTo(right, y - 2).strokeColor(LINE).stroke();
    y += 2;

    for (const line of input.lines) {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = doc.page.margins.top;
        row(headers, true);
      }
      const cells: (string | number)[] = [
        line.poNo,
        line.itemCode,
        line.sku ?? '—',
        line.ctnQty,
        line.pcsQty ?? '—',
        line.netWeightKg ?? '—',
        line.grossWeightKg ?? '—',
        line.volumeCbm ?? '—',
      ];
      if (input.isAir) cells.push(line.chargeableWtKg ?? '—');
      row(cells, false);
    }

    y += 2;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 4;
    const totalCells: (string | number)[] = [
      'Grand Total',
      '',
      '',
      input.totals.ctnQty,
      input.totals.pcsQty,
      input.totals.netWeightKg,
      input.totals.grossWeightKg,
      input.totals.volumeCbm,
    ];
    if (input.isAir) totalCells.push(input.totals.chargeableWtKg);
    row(totalCells, true);

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(STEEL)
      .text(
        `Only the approved POs appear on this order. Issued ${input.issueDate}.`,
        left,
        doc.page.height - 60,
        { width },
      );

    doc.end();
  });
}
