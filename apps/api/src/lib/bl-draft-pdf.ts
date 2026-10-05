import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * The bill of lading — docs/MODULE_DOCUMENTATION.md §2.3, §13.
 *
 * Drawn on the client's own bill of lading (answered 2026-10-05, §13.10 Q1):
 * logo, name and serial top left, a QR in the middle, the title top right;
 * then one ruled grid — parties down the left, references down the right, the
 * routing under them, the particulars declared by the merchant with the
 * container list inside the description, and the freight, issue and signature
 * blocks at the foot. Set in a monospace face throughout, as their form is.
 *
 * The letterhead stops at the name and logo. The address line other documents
 * print is the email signature block, and the client does not want it here.
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
  /** The workspace's uploaded logo, when there is one. */
  logo: Buffer | null;
  /** The draft's own number, printed as the form's serial (SL. No.). */
  serialNo: string;

  blNo: string;
  manifestNo: string | null;
  /** Every booking the bill covers (CR-005), for the QR. */
  bookingNo: string;
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

  /** "PO / item" for each line of the bill's advise. */
  poItems: string[];
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
  /** YYYY-MM-DD. */
  ladenOnBoardDate: string | null;

  /**
   * §13, BL Print. One page per entry, each marked as what it is; absent on a
   * draft, which is a single unmarked page.
   */
  copies?: BlPrintMark[];
  /** §13: the day the bill was issued (YYYY-MM-DD), in the workspace's calendar. */
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

/** The client's form: blue rules and labels, black entries. */
const BLUE = '#2B3A8E';
const INK = '#111111';
const STEEL = '#6B7A88';
const MONO = 'Courier';
const MONO_BOLD = 'Courier-Bold';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** The receipt clause from the client's form, with the number of originals the bill states. */
function receivedClause(originals: number | null): string {
  const count =
    originals === null
      ? 'the number of'
      : `${NUMBER_WORDS[originals] ?? String(originals)}(${originals})`;
  return (
    'RECEIVED by the carrier the Goods as specified above in apparent good order and condition ' +
    'unless otherwise stated, the Goods as specified above for carriage by ocean vessel and/or ' +
    'other modes of transport from the place of receipt or port of loading to the port of ' +
    'discharge or place of delivery as indicated above. The goods to be delivered at the above ' +
    'mentioned port of discharge or place of delivery whichever applies. In accepting this Bill ' +
    'of Lading the Merchant(s) agree to be bound by all the stipulations, exceptions, terms and ' +
    'conditions on the front or back hereof, whether printed, stamped, written or otherwise ' +
    `incorporated. In witness whereof ${count} original Bills of Lading have been signed if not ` +
    'otherwise stated above, all of this tenor and date. One original Bill of Lading duly ' +
    'endorsed must be surrendered in exchange for the Goods or Delivery Order, upon which the ' +
    'other(s) shall stand void.'
  );
}

const WITNESS_CLAUSE =
  'In witness whereof, the master or agents of the vessel have signed the number of original ' +
  'Bills of Lading stated herein, all of this tenor and date, one of which being accomplished, ' +
  'the others to stand void. (Terms of Lading continued on the back hereof)';

const EXCESS_VALUE = 'REFER TO CLAUSE 6(4)(B) + (C) ON REVERSE SIDE';

/** 2026-09-22 → 22/09/2026, as the client's form writes a date. */
const dmy = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === '';

/**
 * The name at the top of a party block, without the address, cut to `max`
 * characters. "TO THE ORDER OF" is not a name: the bank it names is the next
 * line, so a consigned-to-order block keeps both.
 */
const nameOf = (block: string | null, max = 48): string | null => {
  const lines = (block ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return null;
  const name = /^to (the )?order( of)?:?$/i.test(lines[0]!) && lines[1] !== undefined
    ? `${lines[0]} ${lines[1]}`
    : lines[0]!;
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
};

/** The QR lists this many containers, then a count of the rest. */
const QR_CONTAINERS = 3;

/**
 * What the QR says when a phone scans it: the bill's particulars as plain
 * lines, so whoever holds the paper can check it against what it claims —
 * including whether this page is a draft, an original or a copy.
 *
 * Parties by name only, and only the first few containers: every character
 * makes the code denser, and it has to scan at the size it is printed.
 */
export function blQrText(input: BlDraftPdfInput, copy: BlPrintMark | null): string {
  const document = input.isDraft
    ? 'DRAFT - not valid'
    : copy === null
      ? 'Approved draft'
      : `${copy.mark} ${copy.note}`;
  const packages = input.containers.reduce((acc, c) => acc + (c.ctnQty ?? 0), 0);
  const containers = input.containers
    .slice(0, QR_CONTAINERS)
    .map((c) => [c.containerNo, c.containerSize, c.sealNo].filter((v) => !blank(v)).join(' / '));
  const more = input.containers.length - QR_CONTAINERS;
  if (more > 0) containers.push(`+ ${more} more`);

  const fields: [string, string | null][] = [
    ['B/L No', input.blNo],
    ['Document', document],
    ['Issued by', input.companyName],
    ['Booking', input.bookingNo],
    ['Shipper', nameOf(input.shipperText)],
    ['Consignee', nameOf(input.consigneeText)],
    ['Vessel/Voyage', input.oceanVesselVoyage],
    ['POL', input.polName],
    ['POD', input.podName],
    ['Delivery', input.placeOfDelivery],
    ['Container', containers.length === 0 ? null : containers.join('\n  ')],
    ['Packages', packages > 0 ? `${packages} CTNS` : null],
    ['Gross Wt', blank(input.grossWeightKg) ? null : `${input.grossWeightKg} KG`],
    ['Measurement', blank(input.measurementCbm) ? null : `${input.measurementCbm} CBM`],
    ['On Board', blank(input.ladenOnBoardDate) ? null : dmy(input.ladenOnBoardDate ?? '')],
    ['Issued', blank(input.issuedOn) ? null : dmy(input.issuedOn ?? '')],
    ['Originals', input.originalBlCount === null ? null : String(input.originalBlCount)],
  ];
  return [
    'BILL OF LADING',
    ...fields.filter(([, v]) => !blank(v)).map(([k, v]) => `${k}: ${v ?? ''}`),
  ].join('\n');
}

export async function renderBlDraftPdf(input: BlDraftPdfInput): Promise<Buffer> {
  const pages: (BlPrintMark | null)[] =
    input.copies === undefined || input.copies.length === 0 ? [null] : input.copies;
  // One code per page, since each page says whether it is an original or a
  // copy. Generated before the document opens: pdfkit's stream ends
  // synchronously and awaiting inside it would close the file before the
  // image landed. Low error correction keeps the denser text scannable.
  const qrs = await Promise.all(
    pages.map((copy) =>
      QRCode.toBuffer(blQrText(input, copy), { errorCorrectionLevel: 'L', margin: 0, width: 400 }),
    ),
  );

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 26 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const mid = left + 270;

    const rule = (x1: number, y1: number, x2: number, y2: number): void => {
      doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(BLUE).lineWidth(0.6).stroke();
    };
    const label = (text: string, x: number, y: number, w: number, align: 'left' | 'center' = 'left'): void => {
      doc.font(MONO).fontSize(6.5).fillColor(BLUE).text(text, x, y, { width: w, align });
    };
    const entry = (
      text: string | null,
      x: number,
      y: number,
      w: number,
      h: number,
      opts: { bold?: boolean; size?: number; align?: 'left' | 'center' | 'right' } = {},
    ): void => {
      if (blank(text)) return;
      doc
        .font(opts.bold === true ? MONO_BOLD : MONO)
        .fontSize(opts.size ?? 7)
        .fillColor(INK)
        .text(text ?? '', x, y, { width: w, height: h, ellipsis: true, align: opts.align ?? 'left', lineGap: 0.5 });
    };
    /** A boxed field: the label in its top-left corner, the entry under it. */
    const cell = (name: string, value: string | null, x1: number, y1: number, x2: number, y2: number): void => {
      doc.rect(x1, y1, x2 - x1, y2 - y1).strokeColor(BLUE).lineWidth(0.6).stroke();
      label(name, x1 + 3, y1 + 3, x2 - x1 - 6);
      entry(value, x1 + 3, y1 + 12, x2 - x1 - 6, y2 - y1 - 12);
    };

    /** Across the page at an angle, faint, and drawn last so nothing covers it. */
    const watermark = (text: string, color: string): void => {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .font('Helvetica-Bold')
        .fontSize(96)
        .fillColor(color)
        .opacity(0.1)
        .text(text, 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
      doc.opacity(1).restore();
    };

    /** One page of the bill: once for a draft, once per copy when printed (§13). */
    const drawPage = (copy: BlPrintMark | null, qr: Buffer): void => {
      // ------------------------------------------------------------- header
      let nameX = left + 2;
      if (input.logo !== null) {
        try {
          doc.image(input.logo, left + 2, 32, { fit: [38, 44] });
          nameX = left + 48;
        } catch {
          // An unreadable image costs the logo, never the bill.
        }
      }
      // The name shrinks to fit beside the QR rather than running under it.
      const qrX = 318;
      const name = input.companyName.toUpperCase();
      let size = 13;
      doc.font(MONO).fontSize(size);
      while (size > 8 && doc.widthOfString(name) > qrX - nameX - 8) {
        size -= 0.5;
        doc.fontSize(size);
      }
      doc.fillColor(BLUE).text(name, nameX, 40, { lineBreak: false });
      doc.font(MONO).fontSize(13).fillColor(BLUE).text(`SL.NO. ${input.serialNo}`, nameX, 62, { lineBreak: false });

      doc.image(qr, qrX, 28, { width: 64 });

      doc.font(MONO).fontSize(13).fillColor(BLUE).text('BILL OF LADING', qrX + 70, 52, {
        width: right - qrX - 70,
        align: 'right',
        lineBreak: false,
      });
      if (copy !== null) {
        // §13: what makes a printed bill an original or a copy, under its title.
        doc.font(MONO_BOLD).fontSize(10).fillColor(INK).text(copy.mark, qrX + 70, 70, {
          width: right - qrX - 70,
          align: 'right',
          lineBreak: false,
        });
        doc.font(MONO).fontSize(7.5).fillColor(INK).text(copy.note, qrX + 70, 82, {
          width: right - qrX - 70,
          align: 'right',
          lineBreak: false,
        });
      }

      // --------------------------------------------- parties and references
      const top = 96;
      const half = mid + 113;
      cell('Shipper/Exporter(Complete name/Street Address)', input.shipperText, left, top, mid, 152);
      cell('Manifest No', input.manifestNo, mid, top, half, 120);
      cell('Bill of Lading Number', input.blNo, half, top, right, 120);
      cell('Export References', input.exportReferences, mid, 120, right, 152);

      cell('Consignee(Not Negotiable Unless Consigned "to order")', input.consigneeText, left, 152, mid, 208);
      cell('Forwarding Agent-References', input.forwardingAgentReferences, mid, 152, right, 208);

      cell('Notify Party(Complete name/Street Address)', input.notifyText, left, 208, mid, 264);
      cell('Point and Country of origin', input.pointCountryOfOrigin, mid, 208, right, 232);
      cell('Also Notify, Routing and instructions', input.alsoNotifyText, mid, 232, right, 264);

      // ------------------------------------------------------------ routing
      const split = left + 115;
      cell('Pre-Carriage By(mode)*', input.preCarriageByModeName, left, 264, split, 292);
      cell('Place of Receipt*', input.placeOfReceipt, split, 264, mid, 292);
      // Two lines for the vessel and voyage, which rarely fit in one.
      cell('Ocean Vessel/Voyage', input.oceanVesselVoyage, left, 292, split, 322);
      cell('Port of Loading', input.polName, split, 292, mid, 322);
      cell('Port of Discharge', input.podName, left, 322, split, 346);
      cell('Place of Delivery', input.placeOfDelivery, split, 322, mid, 346);
      cell('For Delivery of Goods Please Apply to:', input.deliveryAgentText, mid, 264, right, 346);

      // ---------------------------------------------- particulars of cargo
      doc.rect(left, 346, right - left, 12).strokeColor(BLUE).lineWidth(0.6).stroke();
      label('Particulars Declared By the Merchant', left, 349, right - left, 'center');

      const cols = [left, left + 77, left + 149, left + 414, left + 476, right];
      const headTop = 358;
      const bodyTop = 392;
      const bodyBottom = 560;
      doc.rect(left, headTop, right - left, bodyBottom - headTop).strokeColor(BLUE).lineWidth(0.6).stroke();
      rule(left, bodyTop, right, bodyTop);
      for (const x of cols.slice(1, -1)) rule(x, headTop, x, bodyBottom);
      const heads = [
        'Marks and Numbers Container and Seal Numbers',
        'Purchase order number /Item Number',
        'Numbers and Description of Packages and Goods',
        'Gross Weight (KG)',
        'Measurement (cubic meters)',
      ];
      heads.forEach((h, i) => label(h, cols[i]! + 3, headTop + 4, cols[i + 1]! - cols[i]! - 6, 'center'));

      entry(input.marksAndNumbers, cols[0]! + 3, bodyTop + 6, cols[1]! - cols[0]! - 6, bodyBottom - bodyTop - 10, {
        size: 6.5,
      });
      entry(
        input.poItems.length === 0 ? null : input.poItems.join('\n'),
        cols[1]! + 3,
        bodyTop + 6,
        cols[2]! - cols[1]! - 6,
        bodyBottom - bodyTop - 10,
        { bold: true, size: 6.5, align: 'center' },
      );
      entry(input.grossWeightKg, cols[3]! + 3, bodyTop + 6, cols[4]! - cols[3]! - 6, 20, { bold: true, align: 'center' });
      entry(input.measurementCbm, cols[4]! + 3, bodyTop + 6, cols[5]! - cols[4]! - 6, 20, { bold: true, align: 'center' });

      // The container list sits at the foot of the description, as on the form.
      const rowH = 10;
      const fits = Math.floor((bodyBottom - bodyTop - 70 - 12) / rowH);
      const shown = input.containers.length > fits ? input.containers.slice(0, fits - 1) : input.containers;
      const more = input.containers.length - shown.length;
      const listRows = shown.length + (more > 0 ? 1 : 0);
      const tableX = cols[2]! + 2;
      const tableW = cols[3]! - cols[2]! - 4;
      const tableTop = input.containers.length === 0 ? bodyBottom : bodyBottom - 3 - 12 - listRows * rowH;

      entry(input.packagesDescription, cols[2]! + 3, bodyTop + 6, cols[3]! - cols[2]! - 6, tableTop - bodyTop - 10);

      if (input.containers.length > 0) {
        const tcols = [0, 70, 126, 182, 216, tableW].map((v) => tableX + v);
        const tableBottom = tableTop + 12 + listRows * rowH;
        doc.rect(tableX, tableTop, tableW, tableBottom - tableTop).strokeColor(BLUE).lineWidth(0.6).stroke();
        rule(tableX, tableTop + 12, tableX + tableW, tableTop + 12);
        // The column rules stop above the "+ N more" line, which runs the full width.
        for (const x of tcols.slice(1, -1)) rule(x, tableTop, x, tableTop + 12 + shown.length * rowH);
        ['Container', 'Size', 'Seal No', 'CBM', 'Gross WT'].forEach((h, i) => {
          doc.font(MONO_BOLD).fontSize(6.5).fillColor(BLUE).text(h, tcols[i]! + 2, tableTop + 3, {
            width: tcols[i + 1]! - tcols[i]! - 4,
            lineBreak: false,
          });
        });
        shown.forEach((c, r) => {
          const y = tableTop + 12 + r * rowH + 2;
          [c.containerNo, c.containerSize, c.sealNo, c.measurementCbm, c.grossWeightKg].forEach((v, i) => {
            const value = v ?? '—';
            const room = tcols[i + 1]! - tcols[i]! - 4;
            // A long seal or size shrinks to its column rather than losing characters.
            let size = 6.5;
            doc.font(MONO).fontSize(size);
            while (size > 4.5 && doc.widthOfString(value) > room) {
              size -= 0.25;
              doc.fontSize(size);
            }
            doc.fillColor(INK).text(value, tcols[i]! + 2, y, { width: room, lineBreak: false });
          });
        });
        if (more > 0) {
          doc
            .font(MONO)
            .fontSize(6.5)
            .fillColor(INK)
            .text(`+ ${more} more container${more === 1 ? '' : 's'}`, tcols[0]! + 2, tableTop + 12 + shown.length * rowH + 2, {
              width: tableW - 4,
              lineBreak: false,
            });
        }
      }

      // --------------------------------------------------------------- foot
      const c1 = left + 100;
      const c2 = left + 149;
      const c3 = left + 202;
      doc.rect(left, bodyBottom, c2 - left, 612 - bodyBottom).strokeColor(BLUE).lineWidth(0.6).stroke();
      label('FREIGHT/CHARGES. ITEM NO.', left + 3, bodyBottom + 3, c2 - left - 6);
      label('RATE/RATE BASIS', left + 3, bodyBottom + 11, c2 - left - 6);
      cell('Prepaid', null, c2, bodyBottom, c3, 636);
      cell('Collect', null, c3, bodyBottom, mid, 636);
      cell('Freight Payable at', input.freightPayableAt, left, 612, c1, 636);
      cell('Total Freight', null, c1, 612, c2, 636);
      cell(
        'No. of Original BL',
        input.originalBlCount === null ? null : String(input.originalBlCount),
        left,
        636,
        c2,
        660,
      );
      // The date of issue is BL Print's; a copy printed before then says so.
      const issued = blank(input.issuedOn) ? (copy === null ? null : 'Not issued') : dmy(input.issuedOn ?? '');
      cell('Place and date of issue', issued, c2, 636, mid, 660);
      cell(
        'Laden on Board Date',
        blank(input.ladenOnBoardDate) ? null : `${input.polName.toUpperCase()}, ${dmy(input.ladenOnBoardDate ?? '')}`,
        left,
        660,
        mid,
        684,
      );
      doc.rect(left, 684, mid - left, bottom - 684).strokeColor(BLUE).lineWidth(0.6).stroke();
      doc.font(MONO).fontSize(6.3).fillColor(INK).text(WITNESS_CLAUSE, left + 3, 688, { width: mid - left - 6 });

      doc.rect(mid, bodyBottom, right - mid, bottom - bodyBottom).strokeColor(BLUE).lineWidth(0.6).stroke();
      label('Excess Value Declaration', mid + 3, bodyBottom + 3, right - mid - 6);
      doc.font(MONO).fontSize(6.5).fillColor(INK).text(EXCESS_VALUE, mid + 3, bodyBottom + 11, {
        width: right - mid - 6,
        lineBreak: false,
      });
      rule(mid, bodyBottom + 22, right, bodyBottom + 22);
      doc
        .font(MONO)
        .fontSize(6.3)
        .fillColor(INK)
        .text(receivedClause(input.originalBlCount), mid + 3, bodyBottom + 26, {
          width: right - mid - 6,
          align: 'justify',
        });

      const signTop = 730;
      rule(mid, signTop, right, signTop);
      label('Signed as Agent For the Carrier', mid + 3, signTop + 3, right - mid - 6);
      if (copy !== null) {
        rule(mid + 40, bottom - 22, right - 40, bottom - 22);
        doc
          .font(MONO)
          .fontSize(6.5)
          .fillColor(STEEL)
          .text(`For ${input.companyName} — authorised signatory`, mid + 3, bottom - 17, {
            width: right - mid - 6,
            align: 'center',
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

    pages.forEach((copy, i) => {
      if (i > 0) doc.addPage();
      drawPage(copy, qrs[i]!);
    });

    doc.end();
  });
}
