import PDFDocument from 'pdfkit';

/**
 * The Shipment Advise document — docs/MODULE_DOCUMENTATION.md §2.1, §2.2.
 *
 * The client's `Download & Print`, and what `Save & Send` attaches. Laid out as
 * the sheet draws it: the header block the schedule fills, then the PO grid
 * with its totals row, then the numbers the customer will quote back at you.
 *
 * The company name arrives as data, like the shipping order's — nothing about
 * one forwarder is written into this file. The letterhead stops at the name:
 * the address line other documents print is the email signature block, and the
 * client does not want it on the advise.
 */

export interface ShipmentAdvisePdfInput {
  companyName: string;

  adviseNo: string;
  /** CR-005: every booking the advise covers, comma-separated. */
  bookingNo: string;
  soNo: string | null;
  issueDate: string;
  /** CR-005: more than one booking, so each PO row says which it is on. */
  showBooking?: boolean;

  customerName: string;
  exporterName: string | null;

  isAir: boolean;
  carrierName: string;
  transitType: string;
  firstVesselOrFlight: string | null;
  voyageNo: string | null;
  polName: string;
  podName: string;
  etd: string | null;
  eta: string | null;

  houseBlNo: string;
  mblNo: string | null;

  lines: {
    bookingNo?: string;
    poNo: string;
    itemCode: string;
    sku: string | null;
    ctnQty: number;
    pcsQty: number | null;
    netWeightKg: string | null;
    grossWeightKg: string | null;
    volumeCbm: string | null;
    chargeableWtKg: string | null;
    cargoReceiptDate: string | null;
    stuffingDate: string | null;
    efrNo: string | null;
    containerNo: string | null;
    sealNo: string | null;
    containerSize: string | null;
  }[];
  totals: {
    poCount: number;
    ctnQty: number;
    pcsQty: string;
    netWeightKg: string;
    grossWeightKg: string;
    volumeCbm: string;
    chargeableWtKg: string;
  };
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';

export function renderShipmentAdvisePdf(input: ShipmentAdvisePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ---------------------------------------------------------- letterhead
    doc.font('Helvetica-Bold').fontSize(15).fillColor(HULL).text(input.companyName, left, 40);

    // The two numbers this page exists to carry, where the eye lands first.
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(STEEL)
      .text(input.isAir ? 'HAWB NO' : 'HOUSE BL NO', right - 180, 40, { width: 180, align: 'right' });
    doc
      .font('Courier-Bold')
      .fontSize(13)
      .fillColor(HULL)
      .text(input.houseBlNo, right - 180, 50, { width: 180, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(STEEL)
      .text(input.isAir ? 'MAWB NO' : 'MBL NO', right - 180, 68, { width: 180, align: 'right' });
    doc
      .font('Courier')
      .fontSize(10)
      .fillColor(HULL)
      .text(input.mblNo ?? '—', right - 180, 78, { width: 180, align: 'right' });

    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(HULL)
      .text(input.isAir ? 'SHIPMENT ADVISE - AIR' : 'SHIPMENT ADVISE', left, 92, {
        width: width - 200,
      });

    let y = 112;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 10;

    const field = (label: string, value: string | null, x: number, w: number, atY: number): void => {
      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(STEEL)
        .text(label.toUpperCase(), x, atY, { width: w, lineBreak: false });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(HULL)
        .text(value === null || value === '' ? '—' : value, x, atY + 9, {
          width: w,
          lineBreak: false,
        });
    };

    const col = width / 5;
    field('Advise No', input.adviseNo, left, col - 8, y);
    field('Booking No', input.bookingNo, left + col, col - 8, y);
    field('S/O No', input.soNo, left + col * 2, col - 8, y);
    field('Customer', input.customerName, left + col * 3, col - 8, y);
    field('Date', input.issueDate, left + col * 4, col - 8, y);
    y += 30;

    field('Exporter', input.exporterName, left, col - 8, y);
    field(input.isAir ? 'Airline' : 'Carrier', input.carrierName, left + col, col - 8, y);
    field('Transit type', input.transitType === 'DIRECT' ? 'Direct' : 'Indirect', left + col * 2, col - 8, y);
    field(
      input.isAir ? '1st leg flight' : '1st leg vessel',
      [input.firstVesselOrFlight, input.voyageNo].filter((v) => (v ?? '') !== '').join(' / ') || null,
      left + col * 3,
      col * 2 - 8,
      y,
    );
    y += 30;

    field(input.isAir ? 'AOL' : 'POL', input.polName, left, col - 8, y);
    field(input.isAir ? 'AOD' : 'POD', input.podName, left + col, col - 8, y);
    field(input.isAir ? 'Departure' : 'ETD', input.etd, left + col * 2, col - 8, y);
    field(input.isAir ? 'Arrival' : 'ETA', input.eta, left + col * 3, col - 8, y);
    y += 34;

    // ------------------------------------------------------------ PO grid
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;

    const showBooking = input.showBooking === true;
    const houseLabel = input.isAir ? 'HAWB No' : 'House BL No';
    const masterLabel = input.isAir ? 'MAWB No' : 'MBL No';
    // Sea opens on the container the cartons went into; air has none (§3.7).
    // The bill numbers close every row, after the EFR.
    const columns: [string, number][] = [
      ...(input.isAir ? [] : ([['Container No', 66], ['Seal No', 50], ['Size', 32]] as [string, number][])),
      // CR-005: one advise for several bookings says which booking each PO is on.
      ...(showBooking ? ([['Booking', 70]] as [string, number][]) : []),
      ['PO', 58],
      ['Item', 40],
      ['SKU', 58],
      ['CTN', 30],
      ['PCS', 34],
      ['N.WT', 40],
      ['G.WT', 40],
      ['CBM', 34],
      ...(input.isAir ? ([['Chg WT', 40]] as [string, number][]) : []),
      ['Rcvd', 46],
      ['Stuffed', 46],
      ['EFR', 50],
      // Air has the room the three container columns would take.
      [houseLabel, input.isAir ? 100 : 82],
      [masterLabel, 60],
    ];
    // A wide grid (several bookings) shrinks to the page rather than running off it.
    const scale = Math.min(1, width / columns.reduce((acc, [, w]) => acc + w, 0));
    const headers = columns.map(([h]) => h);
    const widths = columns.map(([, w]) => w * scale);
    const isText = (h: string): boolean =>
      ['Container No', 'Seal No', 'Size', 'Booking', 'PO', 'Item', 'SKU', 'Rcvd', 'Stuffed', 'EFR', houseLabel, masterLabel].includes(h);

    const row = (cells: (string | number)[], bold: boolean): void => {
      let x = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? HULL : '#1A2B3C');
      cells.forEach((cell, i) => {
        const text = isText(headers[i] ?? '');
        const value = String(cell);
        // Figures stop short of the next column, so a number never runs into a date.
        const room = (widths[i] ?? 50) - (text ? 4 : 10);
        // A long seal, PO or EFR shrinks to its column rather than wrapping into the row below.
        let size = 7.5 * scale;
        doc.fontSize(size);
        while (size > 5 && doc.widthOfString(value) > room) {
          size -= 0.25;
          doc.fontSize(size);
        }
        doc.text(value, x, y, { width: room, align: text ? 'left' : 'right', lineBreak: false });
        x += widths[i] ?? 50;
      });
      y += bold ? 14 : 12;
    };

    row(headers, true);
    doc.moveTo(left, y - 2).lineTo(right, y - 2).strokeColor(LINE).stroke();
    y += 2;

    for (const line of input.lines) {
      if (y > doc.page.height - 110) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
        y = doc.page.margins.top;
        row(headers, true);
      }
      const cells: (string | number)[] = [
        ...(input.isAir ? [] : [line.containerNo ?? '—', line.sealNo ?? '—', line.containerSize ?? '—']),
        ...(showBooking ? [line.bookingNo ?? '—'] : []),
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
      cells.push(
        line.cargoReceiptDate ?? '—',
        line.stuffingDate ?? '—',
        line.efrNo ?? '—',
        input.houseBlNo,
        input.mblNo ?? '—',
      );
      row(cells, false);
    }

    y += 2;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 4;

    // Row 21 of the sheet, in the client's own shape: "3 PO", then the sums.
    const totalCells: (string | number)[] = [
      ...(input.isAir ? [] : ['', '', '']),
      ...(showBooking ? [''] : []),
      `${input.totals.poCount} PO`,
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
        `Shipment Advise of Booking no : ${input.bookingNo}. Issued ${input.issueDate}.`,
        left,
        doc.page.height - 52,
        { width },
      );

    doc.end();
  });
}
