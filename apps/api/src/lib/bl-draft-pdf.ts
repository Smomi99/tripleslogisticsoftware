import PDFDocument from 'pdfkit';

/**
 * The BL draft document — docs/MODULE_DOCUMENTATION.md §2.3.
 *
 * Drawn on the geometry of the client's sheet, which is the geometry of a bill
 * of lading: boxed party blocks down the left, references down the right, the
 * routing across the middle, then the cargo description with its container
 * list and the foot.
 *
 * It says DRAFT across it until the forwarder approves it. A page that looks
 * like an original when it is not is how the wrong document gets presented at a
 * counter.
 *
 * BL Print (§13) draws the same bill, once per original — each stamped with its
 * number out of D56's "No. of Original BL" — or once as a non-negotiable copy.
 */

export interface BlDraftPdfInput {
  companyName: string;
  companyAddress: string | null;

  blNo: string;
  mblNo: string | null;
  manifestNo: string | null;
  bookingNo: string;
  status: string;
  /** Watermarked unless the draft has been approved or sent. */
  isDraft: boolean;

  shipperText: string;
  consigneeText: string;
  notifyText: string;
  alsoNotifyText: string | null;

  exportReferences: string | null;
  forwardingAgentReferences: string | null;
  pointCountryOfOrigin: string | null;

  preCarriageByModeName: string;
  placeOfReceipt: string;
  deliveryAgentText: string | null;

  oceanVesselVoyage: string | null;
  polName: string;
  podName: string;
  placeOfDelivery: string | null;

  packagesDescription: string | null;
  marksAndNumbers: string | null;
  grossWeightKg: string | null;
  measurementCbm: string | null;

  containers: {
    containerNo: string | null;
    containerSize: string | null;
    sealNo: string | null;
    ctnQty: number | null;
    grossWeightKg: string | null;
    measurementCbm: string | null;
  }[];

  freightPayableAt: string | null;
  originalBlCount: number | null;
  ladenOnBoardDate: string | null;

  /**
   * §13, BL Print. One page per entry, each marked as what it is; absent on a
   * draft, which is a single unmarked page.
   */
  copies?: BlPrintMark[];
  /** §13: the day the bill was issued, printed beside the mark. */
  issuedOn?: string | null;
}

/** §13: how one printed page of the bill is marked. */
export interface BlPrintMark {
  /** "ORIGINAL" or "COPY". */
  mark: string;
  /** "1 of 3", or "NON-NEGOTIABLE". */
  note: string;
  /** A copy carries a faint diagonal word, as a draft carries DRAFT. */
  watermark: string | null;
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';

export function renderBlDraftPdf(input: BlDraftPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const mid = left + width * 0.55;

    /** One boxed block of the bill, label inside the top-left corner. */
    const box = (
      label: string,
      value: string | null,
      x: number,
      w: number,
      atY: number,
      h: number,
      mono = false,
    ): number => {
      doc.rect(x, atY, w, h).strokeColor(LINE).lineWidth(0.8).stroke();
      doc
        .font('Helvetica')
        .fontSize(6)
        .fillColor(STEEL)
        .text(label.toUpperCase(), x + 5, atY + 4, { width: w - 10, lineBreak: false });
      doc
        .font(mono ? 'Courier-Bold' : 'Helvetica')
        .fontSize(mono ? 10 : 8.5)
        .fillColor(HULL)
        .text(value === null || value.trim() === '' ? '—' : value, x + 5, atY + 14, {
          width: w - 10,
          height: h - 18,
          ellipsis: true,
        });
      return atY + h;
    };

    /** Across the page at an angle, faint, and drawn last so nothing covers it. */
    const watermark = (text: string, color: string): void => {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .font('Helvetica-Bold')
        .fontSize(96)
        .fillColor(color)
        .opacity(0.10)
        .text(text, 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
      doc.opacity(1).restore();
    };

    /** One page of the bill: once for a draft, once per copy when printed (§13). */
    const drawPage = (copy: BlPrintMark | null): void => {
      // ---------------------------------------------------------- letterhead
      doc.font('Helvetica-Bold').fontSize(13).fillColor(HULL).text(input.companyName, left, 38);
      if (input.companyAddress !== null && input.companyAddress !== '') {
        doc.font('Helvetica').fontSize(7.5).fillColor(STEEL).text(input.companyAddress, { width: 300 });
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(HULL)
        .text('BILL OF LADING', mid, 38, { width: right - mid, align: 'right' });
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(STEEL)
        .text(`Booking ${input.bookingNo} · ${input.status}`, mid, 54, {
          width: right - mid,
          align: 'right',
        });

      let y = 76;

      // ------------------------------------------------- parties and references
      const leftW = width * 0.55 - 6;
      const rightX = mid;
      const rightW = right - mid;

      box('Shipper', input.shipperText, left, leftW, y, 74);
      box('Bill of Lading Number', input.blNo, rightX, rightW / 2 - 3, y, 34, true);
      box('MBL No', input.mblNo, rightX + rightW / 2 + 3, rightW / 2 - 3, y, 34, true);
      box('Manifest No', input.manifestNo, rightX, rightW / 2 - 3, y + 38, 36);
      box('Export References', input.exportReferences, rightX + rightW / 2 + 3, rightW / 2 - 3, y + 38, 36);
      y += 78;

      box('Consignee', input.consigneeText, left, leftW, y, 74);
      box('Forwarding Agent — References', input.forwardingAgentReferences, rightX, rightW, y, 36);
      box('Point & Country of Origin', input.pointCountryOfOrigin, rightX, rightW, y + 40, 34);
      y += 78;

      box('Notify Party', input.notifyText, left, leftW, y, 62);
      box('Also Notify Party', input.alsoNotifyText, rightX, rightW, y, 62);
      y += 66;

      // ------------------------------------------------------------- routing
      const q = width / 4;
      box('Pre-Carriage By (mode)', input.preCarriageByModeName, left, q - 4, y, 34);
      box('Place of Receipt', input.placeOfReceipt, left + q, q - 4, y, 34);
      box('For Delivery of Goods Apply to', input.deliveryAgentText, left + q * 2, q * 2 - 4, y, 34);
      y += 38;

      box('Ocean Vessel / Voyage', input.oceanVesselVoyage, left, q - 4, y, 34);
      box('Port of Loading', input.polName, left + q, q - 4, y, 34);
      box('Port of Discharge', input.podName, left + q * 2, q - 4, y, 34);
      box('Place of Delivery', input.placeOfDelivery, left + q * 3, q - 4, y, 34);
      y += 40;

      // ---------------------------------------------------------------- cargo
      const cargoTop = y;
      const markW = width * 0.32;
      const descW = width * 0.38;
      const wtW = width * 0.15;

      doc.rect(left, y, width, 20).fillAndStroke('#F4F6F5', LINE);
      const head = (label: string, x: number, w: number): void => {
        doc
          .font('Helvetica')
          .fontSize(6)
          .fillColor(STEEL)
          .text(label.toUpperCase(), x + 5, y + 7, { width: w - 10, lineBreak: false });
      };
      head('Marks and Numbers · Container and Seal Numbers', left, markW);
      head('Numbers and Description of Packages and Goods', left + markW, descW);
      head('Gross Weight (KG)', left + markW + descW, wtW);
      head('Measurement (CBM)', left + markW + descW + wtW, wtW);
      y += 20;

      const bodyTop = y;
      // The container list, one line each, in the left column where the sheet
      // puts container no / size and seal.
      doc.font('Courier').fontSize(8).fillColor(HULL);
      let markY = y + 5;
      for (const c of input.containers) {
        const line = [c.containerNo ?? '—', c.containerSize ?? '', c.sealNo === null ? '' : `Seal ${c.sealNo}`]
          .filter((v) => v !== '')
          .join('  ');
        doc.text(line, left + 5, markY, { width: markW - 10, lineBreak: false });
        markY += 11;
      }
      if (input.marksAndNumbers !== null && input.marksAndNumbers.trim() !== '') {
        doc.font('Helvetica').fontSize(8).fillColor(HULL);
        doc.text(input.marksAndNumbers, left + 5, markY + 4, { width: markW - 10, height: 150 });
      }

      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(HULL)
        .text(
          input.packagesDescription === null || input.packagesDescription.trim() === ''
            ? '—'
            : input.packagesDescription,
          left + markW + 5,
          bodyTop + 5,
          { width: descW - 10, height: 170 },
        );

      doc
        .font('Courier-Bold')
        .fontSize(9)
        .fillColor(HULL)
        .text(input.grossWeightKg ?? '—', left + markW + descW + 5, bodyTop + 5, {
          width: wtW - 10,
          align: 'right',
        });
      doc.text(input.measurementCbm ?? '—', left + markW + descW + wtW + 5, bodyTop + 5, {
        width: wtW - 10,
        align: 'right',
      });

      const cargoHeight = 186;
      y = cargoTop + 20 + cargoHeight;
      doc.rect(left, cargoTop + 20, width, cargoHeight).strokeColor(LINE).lineWidth(0.8).stroke();
      // The three vertical rules that make it a bill of lading rather than a form.
      for (const x of [left + markW, left + markW + descW, left + markW + descW + wtW]) {
        doc.moveTo(x, cargoTop).lineTo(x, y).strokeColor(LINE).stroke();
      }

      // ----------------------------------------------------------------- foot
      box('Freight Payable at', input.freightPayableAt, left, q * 2 - 4, y + 6, 34);
      box(
        'No. of Original BL',
        input.originalBlCount === null ? null : String(input.originalBlCount),
        left + q * 2,
        q - 4,
        y + 6,
        34,
      );
      box('Laden on Board Date', input.ladenOnBoardDate, left + q * 3, q - 4, y + 6, 34);

      if (copy !== null) {
        /*
         * §13. What makes a printed bill an original or a copy, set under the
         * foot where a counter clerk looks for it, beside the date of issue and
         * the line it is signed on.
         */
        const stampY = y + 58;
        const stampW = q * 2 - 4;
        doc.rect(left, stampY, stampW, 56).strokeColor(HULL).lineWidth(1.5).stroke();
        doc
          .font('Helvetica-Bold')
          .fontSize(22)
          .fillColor(HULL)
          .text(copy.mark, left, stampY + 8, { width: stampW, align: 'center', lineBreak: false });
        doc
          .font('Courier-Bold')
          .fontSize(10)
          .fillColor(HULL)
          .text(copy.note, left, stampY + 36, { width: stampW, align: 'center', lineBreak: false });

        const signX = left + q * 2;
        const signW = q * 2 - 4;
        doc
          .font('Helvetica')
          .fontSize(6)
          .fillColor(STEEL)
          .text('DATE OF ISSUE', signX, stampY, { width: signW, lineBreak: false });
        doc
          .font('Courier-Bold')
          .fontSize(10)
          .fillColor(HULL)
          .text(input.issuedOn ?? 'Not issued', signX, stampY + 10, { width: signW, lineBreak: false });
        doc
          .moveTo(signX, stampY + 48)
          .lineTo(signX + signW, stampY + 48)
          .strokeColor(HULL)
          .lineWidth(0.8)
          .stroke();
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(STEEL)
          .text(`For ${input.companyName} — authorised signatory`, signX, stampY + 52, {
            width: signW,
            lineBreak: false,
          });
      }

      if (input.isDraft) {
        /*
         * Rotated across the page, and drawn last so nothing covers it. A draft
         * that can be mistaken for an original is the one way this document can
         * do real damage.
         */
        watermark('DRAFT', '#B3403A');
      } else if (copy?.watermark != null) {
        // The same reasoning for a copy: it must never pass for an original.
        watermark(copy.watermark, STEEL);
      }
    };

    const pages: (BlPrintMark | null)[] =
      input.copies === undefined || input.copies.length === 0 ? [null] : input.copies;
    pages.forEach((copy, i) => {
      if (i > 0) doc.addPage();
      drawPage(copy);
    });

    doc.end();
  });
}
