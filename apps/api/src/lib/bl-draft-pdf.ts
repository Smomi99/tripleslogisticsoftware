import type { FreightTerms } from '@ff/shared';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * The bill of lading — docs/MODULE_DOCUMENTATION.md §2.3, §13.
 *
 * Drawn on the client's own bill of lading (answered 2026-10-05, §13.10 Q1):
 * logo, name and serial top left, a QR in the middle, the title top right;
 * then one ruled grid — parties down the left, references down the right, the
 * routing under them, the particulars declared by the merchant with the
 * container lines under the description, and the freight, issue and signature
 * blocks at the foot. Solid black Helvetica throughout: their form's blue
 * Courier printed as broken dots (see INK).
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

  /** The first leg's vessel and voyage, which the form's Pre-Carriage By carries. */
  preCarriageVesselVoyage: string | null;
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
  /** Which of the Prepaid and Collect columns is marked; null marks neither. */
  freightTerms: FreightTerms | null;
  originalBlCount: number | null;
  /** YYYY-MM-DD. Also the date of issue the form prints, with the port of loading. */
  ladenOnBoardDate: string | null;

  /**
   * §13, BL Print. One page per entry, each marked as what it is; absent on a
   * draft, which is a single unmarked page.
   */
  copies?: BlPrintMark[];
  /** §13: the day the bill was issued (YYYY-MM-DD), in the workspace's calendar — for the QR. */
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

/**
 * Pure black, rules and words alike, in Helvetica (client, 2026-10-05). The
 * form's blue labels and rules and its Courier printed as broken dots: a black
 * and white printer halftones any colour, near-black included, and Courier's
 * hairline strokes break up at this size. Black is one solid pass of toner.
 */
const INK = '#000000';
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const RULE_WIDTH = 0.75;
/** What a party block or a field holds. */
const ENTRY_SIZE = 8;
/** A copy's diagonal word — the one thing meant to print faint. */
const COPY_GREY = '#6B7A88';

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
      doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(INK).lineWidth(RULE_WIDTH).stroke();
    };
    const box = (x1: number, y1: number, x2: number, y2: number): void => {
      doc.rect(x1, y1, x2 - x1, y2 - y1).strokeColor(INK).lineWidth(RULE_WIDTH).stroke();
    };
    const label = (text: string, x: number, y: number, w: number, align: 'left' | 'center' = 'left'): void => {
      doc.font(FONT).fontSize(6.5).fillColor(INK).text(text, x, y, { width: w, align });
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
        .font(opts.bold === true ? FONT_BOLD : FONT)
        .fontSize(opts.size ?? ENTRY_SIZE)
        .fillColor(INK)
        .text(text ?? '', x, y, { width: w, height: h, ellipsis: true, align: opts.align ?? 'left', lineGap: 0.5 });
    };
    /** One line that shrinks to its width rather than losing characters. */
    const fitted = (text: string, x: number, y: number, w: number, size: number, bold = false): void => {
      let s = size;
      doc.font(bold ? FONT_BOLD : FONT).fontSize(s);
      while (s > 5 && doc.widthOfString(text) > w) {
        s -= 0.25;
        doc.fontSize(s);
      }
      doc.fillColor(INK).text(text, x, y, { width: w, lineBreak: false });
    };
    /** A boxed field: the label in its top-left corner, the entry under it. */
    const cell = (
      name: string,
      value: string | null,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      opts: { bold?: boolean } = {},
    ): void => {
      box(x1, y1, x2, y2);
      label(name, x1 + 3, y1 + 3, x2 - x1 - 6);
      entry(value, x1 + 3, y1 + 12, x2 - x1 - 6, y2 - y1 - 12, opts);
    };

    /** Across the page at an angle, faint, and drawn last so nothing covers it. */
    const watermark = (text: string, color: string): void => {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .font(FONT_BOLD)
        .fontSize(96)
        .fillColor(color)
        .opacity(0.1)
        .text(text, 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
      doc.opacity(1).restore();
    };

    /** "TEMU1006375/20' Standard/M2604875, 23.73 CBM, 5981.50 KGS" — one container. */
    const containerLine = (c: BlDraftPdfInput['containers'][number]): string =>
      [
        [c.containerNo, c.containerSize, c.sealNo].filter((v) => !blank(v)).join('/'),
        blank(c.measurementCbm) ? '' : `${c.measurementCbm} CBM`,
        blank(c.grossWeightKg) ? '' : `${c.grossWeightKg} KGS`,
      ]
        .filter((v) => v !== '')
        .join(', ');

    // The client's rule (2026-10-05): the bill is dated with the day it went on
    // board, issued at the port of loading.
    const onBoard = blank(input.ladenOnBoardDate) ? null : dmy(input.ladenOnBoardDate ?? '');

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
      let size = 14;
      doc.font(FONT_BOLD).fontSize(size);
      while (size > 8 && doc.widthOfString(name) > qrX - nameX - 8) {
        size -= 0.5;
        doc.fontSize(size);
      }
      doc.fillColor(INK).text(name, nameX, 40, { lineBreak: false });
      doc.font(FONT).fontSize(12).fillColor(INK).text(`SL.NO. ${input.serialNo}`, nameX, 62, { lineBreak: false });

      doc.image(qr, qrX, 28, { width: 64 });

      doc.font(FONT_BOLD).fontSize(15).fillColor(INK).text('BILL OF LADING', qrX + 70, 50, {
        width: right - qrX - 70,
        align: 'right',
        lineBreak: false,
      });
      if (copy !== null) {
        // §13: what makes a printed bill an original or a copy, under its title.
        doc.font(FONT_BOLD).fontSize(11).fillColor(INK).text(copy.mark, qrX + 70, 70, {
          width: right - qrX - 70,
          align: 'right',
          lineBreak: false,
        });
        doc.font(FONT).fontSize(8).fillColor(INK).text(copy.note, qrX + 70, 83, {
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
      cell('Bill of Lading Number', input.blNo, half, top, right, 120, { bold: true });
      cell('Export References', input.exportReferences, mid, 120, right, 152);

      cell('Consignee(Not Negotiable Unless Consigned "to order")', input.consigneeText, left, 152, mid, 208);
      // Point and Country of origin sits under the agent's references, so the
      // also-notify block gets the full height beside the notify party.
      cell('Forwarding Agent-References', input.forwardingAgentReferences, mid, 152, right, 184);
      cell('Point and Country of origin', input.pointCountryOfOrigin, mid, 184, right, 208);

      cell('Notify Party(Complete name/Street Address)', input.notifyText, left, 208, mid, 264);
      cell('Also Notify, Routing and instructions', input.alsoNotifyText, mid, 208, right, 264);

      // ------------------------------------------------------------ routing
      // Both vessel rows have room for two lines: a vessel and its voyage rarely fit in one.
      const split = left + 140;
      cell('Pre-Carriage By(mode)*', input.preCarriageVesselVoyage, left, 264, split, 296);
      cell('Place of Receipt*', input.placeOfReceipt, split, 264, mid, 296);
      cell('Ocean Vessel/Voyage', input.oceanVesselVoyage, left, 296, split, 328);
      cell('Port of Loading', input.polName, split, 296, mid, 328);
      cell('Port of Discharge', input.podName, left, 328, split, 354);
      cell('Place of Delivery', input.placeOfDelivery, split, 328, mid, 354);
      cell('For Delivery of Goods Please Apply to:', input.deliveryAgentText, mid, 264, right, 354);

      // ---------------------------------------------- particulars of cargo
      box(left, 354, right, 366);
      label('Particulars Declared By the Merchant', left, 357, right - left, 'center');

      // The PO / item column is gone (2026-10-05); its width went to Marks and Numbers.
      const cols = [left, left + 149, left + 414, left + 476, right];
      const headTop = 366;
      const bodyTop = 392;
      const bodyBottom = 560;
      box(left, headTop, right, bodyBottom);
      rule(left, bodyTop, right, bodyTop);
      for (const x of cols.slice(1, -1)) rule(x, headTop, x, bodyBottom);
      const heads = [
        'Marks and Numbers Container and Seal Numbers',
        'Numbers and Description of Packages and Goods',
        'Gross Weight (KG)',
        'Measurement (cubic meters)',
      ];
      heads.forEach((h, i) => label(h, cols[i]! + 3, headTop + 4, cols[i + 1]! - cols[i]! - 6, 'center'));

      const textTop = bodyTop + 6;
      const textBottom = bodyBottom - 4;
      entry(input.marksAndNumbers, cols[0]! + 3, textTop, cols[1]! - cols[0]! - 6, textBottom - textTop);
      entry(input.grossWeightKg, cols[2]! + 3, textTop, cols[3]! - cols[2]! - 6, 20, { bold: true, align: 'center' });
      entry(input.measurementCbm, cols[3]! + 3, textTop, cols[4]! - cols[3]! - 6, 20, { bold: true, align: 'center' });

      /*
       * The description, then the containers under it as plain lines — one per
       * container, since a bill often carries several (2026-10-05). The
       * description gives up room so a heading and the first three containers
       * always show; past what fits, the rest are counted.
       */
      const descX = cols[1]! + 3;
      const descW = cols[2]! - cols[1]! - 6;
      const rowH = 10;
      const reserve = input.containers.length === 0 ? 0 : 8 + rowH * (1 + Math.min(input.containers.length, 3));
      doc.font(FONT).fontSize(ENTRY_SIZE);
      const descNeed = blank(input.packagesDescription)
        ? 0
        : doc.heightOfString(input.packagesDescription ?? '', { width: descW, lineGap: 0.5 });
      const descH = Math.max(0, Math.min(descNeed, textBottom - textTop - reserve));
      entry(input.packagesDescription, descX, textTop, descW, descH);

      if (input.containers.length > 0) {
        let y = descNeed === 0 ? textTop : textTop + descH + 8;
        const fits = Math.max(Math.floor((textBottom - y) / rowH) - 1, 1);
        const shown =
          input.containers.length > fits ? input.containers.slice(0, fits - 1) : input.containers;
        const more = input.containers.length - shown.length;
        fitted('CONTAINER/SIZE/SEAL NO, CBM, GROSS WT', descX, y, descW, 7.5, true);
        for (const c of shown) {
          y += rowH;
          fitted(containerLine(c), descX, y, descW, 7.5);
        }
        if (more > 0) {
          fitted(`+ ${more} more container${more === 1 ? '' : 's'}`, descX, y + rowH, descW, 7.5);
        }
      }

      // --------------------------------------------------------------- foot
      const c1 = left + 100;
      const c2 = left + 149;
      const c3 = left + 202;
      box(left, bodyBottom, c2, 612);
      label('FREIGHT/CHARGES. ITEM NO.', left + 3, bodyBottom + 3, c2 - left - 6);
      label('RATE/RATE BASIS', left + 3, bodyBottom + 11, c2 - left - 6);
      // §13.10 Q8: the booking's Incoterms mark one column (FreightTerms).
      cell('Prepaid', input.freightTerms === 'PREPAID' ? 'PREPAID' : null, c2, bodyBottom, c3, 636, { bold: true });
      cell('Collect', input.freightTerms === 'COLLECT' ? 'COLLECT' : null, c3, bodyBottom, mid, 636, { bold: true });
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
      cell(
        'Place and date of issue',
        onBoard === null ? null : `${input.polName.toUpperCase()}, ${onBoard}`,
        c2,
        636,
        mid,
        660,
      );
      cell('Laden on Board Date', onBoard, left, 660, mid, 684);
      box(left, 684, mid, bottom);
      doc.font(FONT).fontSize(6.5).fillColor(INK).text(WITNESS_CLAUSE, left + 3, 688, { width: mid - left - 6 });

      box(mid, bodyBottom, right, bottom);
      label('Excess Value Declaration', mid + 3, bodyBottom + 3, right - mid - 6);
      doc.font(FONT).fontSize(7).fillColor(INK).text(EXCESS_VALUE, mid + 3, bodyBottom + 11, {
        width: right - mid - 6,
        lineBreak: false,
      });
      rule(mid, bodyBottom + 22, right, bodyBottom + 22);

      /*
       * The clause fills its box (client, 2026-10-05): the largest size whose
       * text still ends above the signature rule. Measured each time, because
       * the number of originals changes the wording.
       */
      const signTop = 730;
      const clause = receivedClause(input.originalBlCount);
      const clauseTop = bodyBottom + 28;
      const clauseOpts = { width: right - mid - 8, align: 'justify' as const, lineGap: 1 };
      let clauseSize = 10;
      doc.font(FONT).fontSize(clauseSize);
      while (clauseSize > 6.5 && doc.heightOfString(clause, clauseOpts) > signTop - 6 - clauseTop) {
        clauseSize -= 0.1;
        doc.fontSize(clauseSize);
      }
      doc.fillColor(INK).text(clause, mid + 4, clauseTop, clauseOpts);

      rule(mid, signTop, right, signTop);
      label('Signed as Agent For the Carrier', mid + 3, signTop + 3, right - mid - 6);
      if (copy !== null) {
        rule(mid + 40, bottom - 22, right - 40, bottom - 22);
        doc
          .font(FONT)
          .fontSize(7)
          .fillColor(INK)
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
        watermark(copy.watermark, COPY_GREY);
      }
    };

    pages.forEach((copy, i) => {
      if (i > 0) doc.addPage();
      drawPage(copy, qrs[i]!);
    });

    doc.end();
  });
}
