import type { FreightTerms } from '@ff/shared';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import { type BlPrintMark, nameOf, twoDecimals } from './bl-draft-pdf';

/**
 * The House Air Waybill — docs/MODULE_DOCUMENTATION.md §14.
 *
 * An air booking's bill. Drawn on the client's own HAWB (2026-10-15): the
 * master and house numbers across the top with a QR between them; shipper,
 * consignee, notify party, the airport of departure and the routing boxes
 * down the left; the issuer's name, address and licence numbers, the
 * conditions, and the currency and declared-value boxes down the right; the
 * destination and flights across; the goods grid; and the charges, the
 * shipper's certification and the execution boxes at the foot, which names
 * whose original the page is.
 *
 * Solid black Helvetica, for the reason the bill of lading gives (see INK in
 * bl-draft-pdf.ts). DRAFT across it until approved, COPY across a copy.
 *
 * The clause wording is the client's sample with its typos corrected, as the
 * bill of lading's was (§13.10 Q11).
 */

export interface AwbPdfInput {
  companyName: string;
  /** Address and licence lines under the name — Settings → Notifications. */
  issuerDetails: string | null;
  logo: Buffer | null;

  hawbNo: string;
  mawbNo: string | null;
  /** Every booking the waybill covers (CR-005), for the QR. */
  bookingNo: string;
  /** Watermarked unless the draft has been approved or sent. */
  isDraft: boolean;

  shipperText: string;
  consigneeText: string;
  notifyText: string;

  /** "Dhaka Airport, Bangladesh". */
  departureAirport: string;
  destinationAirport: string;
  /** "DAC-SHJ-VIE": the airport codes the cargo flies through, in order. */
  routing: string;
  /** One per flight, in order. */
  legs: {
    toCode: string;
    toName: string;
    /** The airline's designator, or its name. */
    carrier: string | null;
    flightNo: string | null;
    /** YYYY-MM-DD in the workspace's calendar. */
    departure: string | null;
  }[];

  currency: string | null;
  /** Prepaid or collect, from the booking's TOS; null marks neither. */
  freightTerms: FreightTerms | null;

  packageCount: number | null;
  grossWeightKg: string | null;
  chargeableWeightKg: string | null;
  measurementCbm: string | null;
  goodsDescription: string | null;
  /** The destination agent the consignee collects from — under the goods. */
  deliveryAgentText: string | null;

  /** YYYY-MM-DD: Executed on (Date). */
  executedOn: string | null;
  /** At (Place) — where the freight is payable. */
  executedAt: string | null;
  /** "TSL/DAC": the issuing office's prefix and its airport. */
  issuingOffice: string;

  /** One page per entry; absent on a draft, which is a single unmarked page. */
  copies?: BlPrintMark[];
  /** The day it was issued (YYYY-MM-DD), for the QR. */
  issuedOn?: string | null;
}

const INK = '#000000';
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const RULE_WIDTH = 0.75;
const COPY_GREY = '#6B7A88';

const ORIGINALS_HEADING = 'COPIES 1, 2 AND 3 OF THIS AIR WAYBILL ARE ORIGINALS AND HAVE THE SAME VALIDITY';

const CONDITIONS =
  'It is agreed that the goods described herein are accepted in apparent good order and condition ' +
  '(except as noted) for carriage SUBJECT TO THE CONDITIONS OF CONTRACT ON THE REVERSE HEREOF. ALL ' +
  'GOODS MAY BE CARRIED BY ANY OTHER MEANS INCLUDING ROAD OR ANY OTHER CARRIER UNLESS SPECIFIC ' +
  'CONTRARY INSTRUCTIONS ARE GIVEN HEREON BY THE SHIPPER, AND SHIPPER AGREES THAT THE SHIPMENT MAY ' +
  'BE CARRIED VIA INTERMEDIATE STOPPING PLACES WHICH THE CARRIER DEEMS APPROPRIATE. THE SHIPPER\'S ' +
  "ATTENTION IS DRAWN TO THE NOTICE CONCERNING CARRIER'S LIMITATION OF LIABILITY. Shipper may " +
  'increase such limitation of liability by declaring a higher value for carriage and paying a ' +
  'supplemental charge if required. SEE CONDITIONS ON REVERSE HEREOF.';

const INSURANCE =
  'INSURANCE:- If carrier offers insurance, and such insurance is requested in accordance with the ' +
  'conditions thereof, indicate amount to be insured in figures in box marked "Amount of Insurance".';

const CERTIFICATION =
  'Shipper certifies that the particulars on the face hereof are correct and that INSOFAR AS ANY ' +
  'PART OF THE CONSIGNMENT CONTAINS DANGEROUS GOODS, SUCH PART IS PROPERLY DESCRIBED BY NAME AND IS ' +
  'IN PROPER CONDITION FOR CARRIAGE BY AIR ACCORDING TO THE APPLICABLE DANGEROUS GOODS REGULATIONS.';

/** The client's sample: the weight charge is not disclosed on the house bill. */
const AS_ARRANGED = 'AS ARRANGED';

/** The charge lines down the left of the foot, as the client's sample lists them. */
const CHARGE_LINES = [
  'Cartage',
  'HC/DC',
  'CHARGES ADVANCED',
  'VALUATION CHARGES',
  'TC/T.H.C.ADC',
  'C.F.S',
  'OTHER CHARGES',
];

const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === '';

/** 2026-07-09 → 09/07/2026, as the sample writes the execution date. */
const dmy = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-07-12 → 12-Jul-26, as the sample writes a flight date. */
export const flightDay = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${MONTHS[Number(m) - 1] ?? m}-${(y ?? '').slice(2)}`;
};

/** "G9 507/10-Jul-26": a Flight/Date box. */
export function flightDate(leg: AwbPdfInput['legs'][number] | undefined): string | null {
  if (leg === undefined) return null;
  const parts = [leg.flightNo, leg.departure === null ? null : flightDay(leg.departure)].filter(
    (v): v is string => !blank(v),
  );
  return parts.length === 0 ? null : parts.join('/');
}

const withTwoDecimals = (awb: AwbPdfInput): AwbPdfInput => ({
  ...awb,
  grossWeightKg: twoDecimals(awb.grossWeightKg),
  chargeableWeightKg: twoDecimals(awb.chargeableWeightKg),
  measurementCbm: twoDecimals(awb.measurementCbm),
});

/** What the goods box says: the description, the volume, then the delivery agent. */
export function goodsText(awb: AwbPdfInput): string {
  const parts: string[] = [];
  if (!blank(awb.goodsDescription)) parts.push((awb.goodsDescription ?? '').trim());
  if (!blank(awb.measurementCbm)) parts.push(`VOLUME: ${awb.measurementCbm} CBM`);
  if (!blank(awb.deliveryAgentText)) parts.push(`Delivery Agent :\n${(awb.deliveryAgentText ?? '').trim()}`);
  return parts.join('\n\n');
}

/**
 * What the QR says when a phone scans it — the waybill's particulars as plain
 * lines, including whether this page is a draft, an original or a copy. The
 * bill of lading's QR, in the air waybill's terms.
 */
export function awbQrText(awb: AwbPdfInput, copy: BlPrintMark | null): string {
  const input = withTwoDecimals(awb);
  const document = input.isDraft
    ? 'DRAFT - not valid'
    : copy === null
      ? 'Approved draft'
      : `${copy.mark} ${copy.note}`;
  const fields: [string, string | null][] = [
    ['HAWB No', input.hawbNo],
    ['MAWB No', input.mawbNo],
    ['Document', document],
    ['Issued by', input.companyName],
    ['Booking', input.bookingNo],
    ['Shipper', nameOf(input.shipperText)],
    ['Consignee', nameOf(input.consigneeText)],
    ['Routing', input.routing],
    ['Flight', flightDate(input.legs[0])],
    ['Pieces', input.packageCount === null ? null : String(input.packageCount)],
    ['Gross Wt', blank(input.grossWeightKg) ? null : `${input.grossWeightKg} KG`],
    ['Chargeable Wt', blank(input.chargeableWeightKg) ? null : `${input.chargeableWeightKg} KG`],
    ['Executed', blank(input.executedOn) ? null : dmy(input.executedOn ?? '')],
    ['Issued', blank(input.issuedOn) ? null : dmy(input.issuedOn ?? '')],
  ];
  return [
    'HOUSE AIR WAYBILL',
    ...fields.filter(([, v]) => !blank(v)).map(([k, v]) => `${k}: ${v ?? ''}`),
  ].join('\n');
}

export async function renderAwbPdf(awb: AwbPdfInput): Promise<Buffer> {
  const input = withTwoDecimals(awb);
  const pages: (BlPrintMark | null)[] =
    input.copies === undefined || input.copies.length === 0 ? [null] : input.copies;
  // Generated before the document opens, for the reason renderBlDraftPdf gives.
  const qrs = await Promise.all(
    pages.map((copy) =>
      QRCode.toBuffer(awbQrText(input, copy), { errorCorrectionLevel: 'L', margin: 0, width: 400 }),
    ),
  );

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 20 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    /** Where the left column ends and the right begins. */
    const MID = L + 276;

    const rule = (x1: number, y1: number, x2: number, y2: number): void => {
      doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(INK).lineWidth(RULE_WIDTH).stroke();
    };
    const box = (x1: number, y1: number, x2: number, y2: number): void => {
      doc.rect(x1, y1, x2 - x1, y2 - y1).strokeColor(INK).lineWidth(RULE_WIDTH).stroke();
    };
    const label = (
      text: string,
      x: number,
      y: number,
      w: number,
      align: 'left' | 'center' = 'left',
      size = 6.5,
    ): void => {
      doc.font(FONT_BOLD).fontSize(size).fillColor(INK).text(text, x, y, { width: w, align, lineGap: 0 });
    };
    /** One line that shrinks to its width rather than losing characters. */
    const fitted = (
      text: string | null,
      x: number,
      y: number,
      w: number,
      size: number,
      opts: { bold?: boolean; align?: 'left' | 'center' | 'right' } = {},
    ): void => {
      if (blank(text)) return;
      const value = text ?? '';
      let s = size;
      doc.font(opts.bold === true ? FONT_BOLD : FONT).fontSize(s);
      while (s > 4.5 && doc.widthOfString(value) > w) {
        s -= 0.25;
        doc.fontSize(s);
      }
      doc.fillColor(INK).text(value, x, y, { width: w, align: opts.align ?? 'left', lineBreak: false });
    };
    /**
     * A block of text that shrinks until it fits its box — party blocks, the
     * clauses, the goods. Shrinking beats an ellipsis on a document whose every
     * word was typed for a reason.
     */
    const block = (
      text: string | null,
      x: number,
      y: number,
      w: number,
      h: number,
      opts: { bold?: boolean; size?: number; min?: number; align?: 'left' | 'center' | 'justify' } = {},
    ): void => {
      if (blank(text)) return;
      const value = text ?? '';
      const options = { width: w, align: opts.align ?? 'left', lineGap: 0.5 } as const;
      let s = opts.size ?? 8;
      const min = opts.min ?? 5;
      doc.font(opts.bold === true ? FONT_BOLD : FONT).fontSize(s);
      while (s > min && doc.heightOfString(value, options) > h) {
        s -= 0.25;
        doc.fontSize(s);
      }
      doc.fillColor(INK).text(value, x, y, { ...options, height: h, ellipsis: true });
    };
    /** A boxed field: the label in its top-left corner, the entry under it. */
    const cell = (
      name: string,
      value: string | null,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      opts: { bold?: boolean; size?: number } = {},
    ): void => {
      box(x1, y1, x2, y2);
      label(name, x1 + 3, y1 + 3, x2 - x1 - 6);
      block(value, x1 + 3, y1 + 12, x2 - x1 - 6, y2 - y1 - 14, { bold: opts.bold, size: opts.size ?? 8 });
    };
    /** A boxed field with its label centred on top and one value centred under it. */
    const column = (
      name: string,
      value: string | null,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      split: number,
    ): void => {
      box(x1, y1, x2, y2);
      label(name, x1 + 2, y1 + 3, x2 - x1 - 4, 'center', 6);
      fitted(value, x1 + 2, split + 4, x2 - x1 - 4, 8, { bold: true, align: 'center' });
    };

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

    const collect = input.freightTerms === 'COLLECT';
    const prepaid = input.freightTerms === 'PREPAID';
    const goods = goodsText(input);

    const drawPage = (copy: BlPrintMark | null, qr: Buffer): void => {
      // ------------------------------------------------------------- header
      label('MASTER AIR WAY BILL NO', L, 24, 220, 'left', 9);
      fitted(input.mawbNo, L, 38, 220, 13, { bold: true });

      const qrSize = 54;
      doc.image(qr, (L + R - qrSize) / 2, 16, { width: qrSize });

      doc.font(FONT_BOLD).fontSize(9).fillColor(INK).text('HOUSE AIR WAY BILL NUMBER', R - 220, 24, {
        width: 220,
        align: 'right',
        lineBreak: false,
      });
      fitted(input.hawbNo, R - 220, 38, 220, 16, { bold: true, align: 'right' });

      // ------------------------------------------------- parties, left side
      const top = 76;
      cell("SHIPPER'S NAME AND ADDRESS", input.shipperText, L, top, MID, 148);
      cell("CONSIGNEE'S NAME AND ADDRESS", input.consigneeText, L, 148, MID, 204);
      cell('NOTIFY PARTY', input.notifyText, L, 204, MID, 254);
      cell(
        'AIRPORT OF DEPARTURE',
        [input.departureAirport, input.routing].filter((v) => !blank(v)).join(' . '),
        L,
        254,
        MID,
        280,
        { bold: true },
      );

      // The routing boxes: where each flight goes, and on whose aircraft.
      const legs = input.legs;
      const route = [L, L + 34, L + 104, L + 196, L + 226, L + 250, MID];
      const routeHeads = ['to', 'By First Carrier', 'to', 'by', 'to', 'by'];
      const routeValues = [
        legs[0]?.toCode ?? null,
        legs[0]?.carrier ?? null,
        // The sample spells the second stop out — it has the room.
        legs[1]?.toName ?? null,
        legs[1]?.carrier ?? null,
        legs[2]?.toCode ?? null,
        legs[2]?.carrier ?? null,
      ];
      for (let i = 0; i < routeHeads.length; i += 1) {
        const x1 = route[i]!;
        const x2 = route[i + 1]!;
        box(x1, 280, x2, 314);
        label(routeHeads[i]!, x1 + 2, 283, x2 - x1 - 4, 'center', 6);
        fitted(routeValues[i] ?? null, x1 + 2, 297, x2 - x1 - 4, 8, { bold: true, align: 'center' });
      }

      // ----------------------------------------------- issuer, right side
      box(MID, top, R, 174);
      let nameX = MID + 6;
      if (input.logo !== null) {
        try {
          doc.image(input.logo, MID + 6, top + 6, { fit: [40, 40] });
          nameX = MID + 52;
        } catch {
          // An unreadable image costs the logo, never the waybill.
        }
      }
      fitted(input.companyName.toUpperCase(), nameX, top + 8, R - nameX - 6, 15, { bold: true });
      block(input.issuerDetails, nameX, top + 28, R - nameX - 6, 174 - top - 32, {
        bold: true,
        size: 7.5,
        min: 5,
      });

      box(MID, 174, R, 246);
      label(ORIGINALS_HEADING, MID + 3, 177, R - MID - 6, 'center', 5.6);
      block(CONDITIONS, MID + 3, 186, R - MID - 6, 246 - 186 - 3, { size: 6, min: 4.2, align: 'justify' });

      box(MID, 246, R, 262);
      const terms = collect ? 'FREIGHT COLLECT' : prepaid ? 'FREIGHT PREPAID' : null;
      fitted(terms, MID + 3, 250, R - MID - 6, 9, { bold: true, align: 'center' });

      // Currency, charges code, prepaid/collect marks and the declared values.
      const c = [MID, MID + 40, MID + 72, MID + 116, MID + 160, MID + 218, R];
      const headBottom = 290;
      column('CURRENCY', input.currency, c[0]!, 262, c[1]!, 314, headBottom);
      column('CHGS CODE', collect ? 'CC' : prepaid ? 'PP' : null, c[1]!, 262, c[2]!, 314, headBottom);
      for (const [name, x1, x2] of [
        ['WT/VAL', c[2]!, c[3]!],
        ['OTHER', c[3]!, c[4]!],
      ] as const) {
        box(x1, 262, x2, 314);
        label(name, x1 + 2, 265, x2 - x1 - 4, 'center', 6);
        const half = (x1 + x2) / 2;
        rule(x1, 276, x2, 276);
        rule(half, 276, half, 314);
        label('PPD', x1 + 1, 279, half - x1 - 2, 'center', 6);
        label('COLL', half + 1, 279, x2 - half - 2, 'center', 6);
        fitted(prepaid ? 'PP' : null, x1 + 1, headBottom + 4, half - x1 - 2, 8, { bold: true, align: 'center' });
        fitted(collect ? 'CC' : null, half + 1, headBottom + 4, x2 - half - 2, 8, { bold: true, align: 'center' });
      }
      column('DECLARED VALUE FOR CARRIAGE', 'N.V.D', c[4]!, 262, c[5]!, 314, headBottom);
      column('DECLARED VALUE FOR CUSTOMS', 'As Per Invoice', c[5]!, 262, c[6]!, 314, headBottom);
      // The headings above the line, the values under it, across all six.
      rule(MID, headBottom, R, headBottom);

      // ------------------------------------- destination, flights, insurance
      const f = [L, L + 190, L + 242, MID, MID + 52, MID + 114, R];
      cell('AIRPORT OF DESTINATION', input.destinationAirport, f[0]!, 314, f[1]!, 350, { bold: true });
      column('Flight/Date', flightDate(legs[0]), f[1]!, 314, f[2]!, 350, 328);
      column('Booked', null, f[2]!, 314, f[3]!, 350, 328);
      column('Flight/Date', flightDate(legs[1]), f[3]!, 314, f[4]!, 350, 328);
      column('Amount of Insurance', null, f[4]!, 314, f[5]!, 350, 328);
      box(f[5]!, 314, f[6]!, 350);
      block(INSURANCE, f[5]! + 3, 317, f[6]! - f[5]! - 6, 350 - 317 - 3, { size: 6, min: 4.5 });

      // -------------------------------------------------------- the goods
      const g = [L, L + 40, L + 90, L + 108, L + 148, L + 198, L + 236, L + 292, R];
      const gTop = 350;
      const gHead = 378;
      const gTotals = 578;
      const gBottom = 600;
      box(L, gTop, R, gBottom);
      rule(L, gHead, R, gHead);
      for (const x of g.slice(1, -1)) rule(x, gTop, x, gBottom);
      // The totals line runs under the figures, not under the description.
      rule(L, gTotals, g[7]!, gTotals);
      const heads = [
        'No. of Pieces',
        'Gross Weight',
        'Kg/Lb',
        'Rate Class Commodity Item No.',
        'Chargeable Weight',
        'Rate/ Charge',
        'Total',
        'Nature and Quantity of Goods (incl. Dimensions or Volume)',
      ];
      heads.forEach((h, i) => label(h, g[i]! + 2, gTop + 4, g[i + 1]! - g[i]! - 4, 'center', 6));

      const row = gHead + 8;
      const at = (i: number, text: string | null, size = 8.5): void =>
        fitted(text, g[i]! + 2, row, g[i + 1]! - g[i]! - 4, size, { bold: true, align: 'center' });
      at(0, input.packageCount === null ? null : String(input.packageCount));
      at(1, input.grossWeightKg);
      at(2, blank(input.grossWeightKg) ? null : 'K');
      at(4, input.chargeableWeightKg);
      // The rate column is too narrow for both words: one over the other,
      // never broken inside "ARRANGED".
      const [as, arranged] = AS_ARRANGED.split(' ');
      fitted(as ?? null, g[5]! + 2, row, g[6]! - g[5]! - 4, 7.5, { bold: true, align: 'center' });
      fitted(arranged ?? null, g[5]! + 2, row + 9, g[6]! - g[5]! - 4, 7.5, { bold: true, align: 'center' });
      fitted(AS_ARRANGED, g[6]! + 2, row, g[7]! - g[6]! - 4, 7.5, { bold: true, align: 'center' });
      block(goods, g[7]! + 4, row, R - g[7]! - 8, gBottom - row - 6, { bold: true, size: 7.5, min: 4.5 });
      fitted(AS_ARRANGED, g[6]! + 2, gTotals + 7, g[7]! - g[6]! - 4, 7.5, { bold: true, align: 'center' });

      // ----------------------------------------------------- charges, left
      const p = [L, L + 95, L + 176, MID];
      const pTop = gBottom;
      const pMid = pTop + 12;
      const pBottom = pTop + 28;
      box(L, pTop, MID, pBottom);
      rule(p[1]!, pTop, p[1]!, pBottom);
      rule(p[2]!, pTop, p[2]!, pBottom);
      label('Prepaid', p[0]! + 2, pTop + 3, p[1]! - p[0]! - 4, 'center');
      label('Air Freight', p[1]! + 2, pTop + 3, p[2]! - p[1]! - 4, 'center');
      label('Collect', p[2]! + 2, pTop + 3, p[3]! - p[2]! - 4, 'center');
      // The column the booking's TOS names; both when it names neither, as the sample does.
      if (!collect) fitted(AS_ARRANGED, p[0]! + 2, pMid + 2, p[1]! - p[0]! - 4, 8, { bold: true, align: 'center' });
      if (!prepaid) fitted(AS_ARRANGED, p[2]! + 2, pMid + 2, p[3]! - p[2]! - 4, 8, { bold: true, align: 'center' });

      const lineH = 22;
      CHARGE_LINES.forEach((name, i) => {
        const y1 = pBottom + i * lineH;
        box(L, y1, MID, y1 + lineH);
        label(name, L + 2, y1 + (lineH - 7) / 2, MID - L - 4, 'center', 7);
      });
      const footTop = pBottom + CHARGE_LINES.length * lineH;

      // ---------------------------------------------- certification, right
      box(MID, pTop, R, pTop + 50);
      label('Other Charges', MID + 3, pTop + 3, R - MID - 6);
      box(MID, pTop + 50, R, pTop + 100);
      block(CERTIFICATION, MID + 4, pTop + 54, R - MID - 8, 42, { size: 7.5, min: 5, align: 'justify' });
      box(MID, pTop + 100, R, pTop + 128);
      label('Signature of Shipper or his Agent', MID + 3, pTop + 117, R - MID - 6, 'center', 7);

      const e = [MID, MID + 80, MID + 160, R];
      const eTop = pTop + 128;
      const eLabel = footTop - 12;
      for (let i = 0; i < 3; i += 1) box(e[i]!, eTop, e[i + 1]!, footTop);
      rule(MID, eLabel - 3, R, eLabel - 3);
      fitted(blank(input.executedOn) ? null : dmy(input.executedOn ?? ''), e[0]! + 2, eTop + 10, e[1]! - e[0]! - 4, 9, { bold: true, align: 'center' });
      fitted(input.executedAt, e[1]! + 2, eTop + 10, e[2]! - e[1]! - 4, 9, { bold: true, align: 'center' });
      fitted(input.issuingOffice, e[2]! + 2, eTop + 10, e[3]! - e[2]! - 4, 9, { bold: true, align: 'center' });
      fitted('Executed on (Date)', e[0]! + 2, eLabel, e[1]! - e[0]! - 4, 6, { bold: true, align: 'center' });
      fitted('At (Place)', e[1]! + 2, eLabel, e[2]! - e[1]! - 4, 6, { bold: true, align: 'center' });
      fitted('SIGNATURE OF ISSUING AGENT OFFICE', e[2]! + 2, eLabel, e[3]! - e[2]! - 4, 6, {
        bold: true,
        align: 'center',
      });

      // ------------------------------------------------------------- foot
      // Whose original this is — "1-ISSUING CARRIER" — or that it is a copy.
      const foot =
        copy === null ? null : copy.mark === 'ORIGINAL' ? copy.note : `${copy.mark} — ${copy.note}`;
      fitted(foot, L, footTop + 10, R - L, 16, { bold: true, align: 'center' });

      if (input.isDraft) watermark('DRAFT', '#B3403A');
      else if (copy?.watermark != null) watermark(copy.watermark, COPY_GREY);
    };

    pages.forEach((copy, i) => {
      if (i > 0) doc.addPage();
      drawPage(copy, qrs[i]!);
    });

    doc.end();
  });
}
