import PDFDocument from 'pdfkit';

/**
 * The Container Load Plan document — MODULE_CLP.md §5.3.
 *
 * This is signed on a warehouse floor, so it is built for that: portrait A4,
 * one page per container, and nothing on it that cannot be checked against
 * the cartons in front of the person holding it.
 *
 * §4.3 — "PRINT works in both states; a DRAFT print carries a DRAFT
 * watermark." A load plan gets printed and walked to the CFS before it is
 * finalised, which is exactly when someone might load from a copy that is
 * still changing. The watermark is the only thing standing between that and a
 * container stuffed from a superseded sheet, so it is drawn across the whole
 * page rather than noted in a corner.
 */

/*
  A LIMITATION WORTH KNOWING ABOUT.

  This uses pdfkit's built-in Helvetica, which is encoded WinAnsi — roughly
  Latin-1 plus common typography. Anything outside it (an arrow, a curly
  quote from a pasted name, Bengali script) does not render as itself; it
  comes out as whichever byte the encoder falls back to.

  That matters for a Bangladeshi forwarder whose customer names may not be
  Latin. Fixing it properly means embedding a Unicode TTF, which is a change
  for every PDF this product makes, not just this one. Until then `winAnsi`
  below at least makes the failure visible rather than silent.
*/

/** §12's palette. Hardcoded here because pdfkit has no stylesheet. */
const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';
const PAPER = '#F4F6F5';
const ALERT = '#B3403A';

export interface ClpPrintLine {
  poNo: string;
  itemCode: string;
  sku: string | null;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  cartonLengthCm: string | null;
  cartonWidthCm: string | null;
  cartonHeightCm: string | null;
  volumeCbm: string | null;
}

export interface ClpPrintDoc {
  workspaceName: string;
  status: 'DRAFT' | 'FINAL' | 'CANCELLED';
  code: string;
  clpSeq: number;
  bookingCode: string;
  shippingOrderCode: string | null;
  carrierName: string;
  containerSizeCode: string;
  containerNo: string | null;
  sealNo: string | null;
  loadDatetime: string | null;
  loadedBy: string | null;
  supervisorName: string | null;
  tallyManName: string | null;
  polName: string;
  podName: string;
  customerName: string;
  exporterName: string | null;
  lines: ClpPrintLine[];
  generatedBy: string;
}

/**
 * Keeps text to what the built-in font can actually draw.
 *
 * Common typography is mapped to its plain equivalent - an em dash survives
 * because WinAnsi has one, an arrow does not and becomes "->". Anything else
 * outside the set becomes "?", which is ugly on purpose: a visible question
 * mark gets reported, where a silently wrong glyph gets signed for.
 */
function winAnsi(value: string): string {
  return value
    .replace(/[\u2192\u27a1]/g, '->')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u00ff\u2013\u2014\u00b7]/g, '?');
}

const num = (v: string | number | null, dp: number): string =>
  v === null || v === ''
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const sum = (lines: ClpPrintLine[], pick: (l: ClpPrintLine) => string | number | null): number =>
  lines.reduce((total, line) => total + Number(pick(line) ?? 0), 0);

interface Column {
  key: string;
  label: string;
  width: number;
  align: 'left' | 'right';
  value: (line: ClpPrintLine) => string;
  total?: (lines: ClpPrintLine[]) => string;
}

/*
  §5.3's columns, in the client's own order. The sample they gave —
  "3 PO · 780 · 11,000 · 11,300 · 12,100 · 28" — is the TOTAL row, which is
  why the PO count sits in the first cell of it rather than being a separate
  line underneath.
*/
const COLUMNS: Column[] = [
  { key: 'po', label: 'PO', width: 62, align: 'left', value: (l) => l.poNo },
  { key: 'item', label: 'ITEM', width: 78, align: 'left', value: (l) => l.itemCode },
  { key: 'sku', label: 'SKU', width: 54, align: 'left', value: (l) => l.sku ?? '—' },
  {
    key: 'ctn',
    label: 'CTN QTY',
    width: 48,
    align: 'right',
    value: (l) => l.ctnQty.toLocaleString('en-US'),
    total: (ls) => sum(ls, (l) => l.ctnQty).toLocaleString('en-US'),
  },
  {
    key: 'pcs',
    label: 'PCS QTY',
    width: 48,
    align: 'right',
    value: (l) => (l.pcsQty === null ? '—' : l.pcsQty.toLocaleString('en-US')),
    total: (ls) => sum(ls, (l) => l.pcsQty).toLocaleString('en-US'),
  },
  {
    key: 'nwt',
    label: 'N.WT (KG)',
    width: 62,
    align: 'right',
    value: (l) => num(l.netWeightKg, 3),
    total: (ls) => num(sum(ls, (l) => l.netWeightKg), 3),
  },
  {
    key: 'gwt',
    label: 'G.WT (KG)',
    width: 62,
    align: 'right',
    value: (l) => num(l.grossWeightKg, 3),
    total: (ls) => num(sum(ls, (l) => l.grossWeightKg), 3),
  },
  {
    key: 'l',
    label: 'L',
    width: 34,
    align: 'right',
    value: (l) => num(l.cartonLengthCm, 0),
  },
  {
    key: 'w',
    label: 'W',
    width: 34,
    align: 'right',
    value: (l) => num(l.cartonWidthCm, 0),
  },
  {
    key: 'h',
    label: 'H',
    width: 34,
    align: 'right',
    value: (l) => num(l.cartonHeightCm, 0),
  },
  {
    key: 'cbm',
    label: 'CBM',
    width: 50,
    align: 'right',
    value: (l) => num(l.volumeCbm, 4),
    total: (ls) => num(sum(ls, (l) => l.volumeCbm), 4),
  },
];

/**
 * The DRAFT stamp.
 *
 * Drawn diagonally across the middle of the page in outline, at low opacity —
 * heavy enough that nobody mistakes the sheet for the final one, light enough
 * that every figure underneath it is still readable. A watermark that hides
 * the carton counts would just get printed again without it.
 */
function stampDraft(doc: PDFKit.PDFDocument): void {
  const { width, height } = doc.page;
  doc.save();
  doc.rotate(-32, { origin: [width / 2, height / 2] });
  doc
    .fontSize(96)
    .font('Helvetica-Bold')
    .fillColor(ALERT)
    .opacity(0.13)
    .text('DRAFT', 0, height / 2 - 60, { width, align: 'center' });
  doc.opacity(1);
  doc.restore();
}

/** The same treatment for a plan that has been cancelled. */
function stampCancelled(doc: PDFKit.PDFDocument): void {
  const { width, height } = doc.page;
  doc.save();
  doc.rotate(-32, { origin: [width / 2, height / 2] });
  doc
    .fontSize(72)
    .font('Helvetica-Bold')
    .fillColor(ALERT)
    .opacity(0.15)
    .text('CANCELLED', 0, height / 2 - 45, { width, align: 'center' });
  doc.opacity(1);
  doc.restore();
}

export function buildClpPdf(clp: ClpPrintDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Portrait: §5.3 says one page per container, signed at A4.
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullWidth = right - left;

    // ------------------------------------------------------------- header
    doc.font('Helvetica-Bold').fontSize(13).fillColor(HULL).text(winAnsi(clp.workspaceName), left, left);
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor(HULL)
      .text('CONTAINER LOAD PLAN', left, doc.y + 2);
    doc.moveDown(0.4);

    const headerY = doc.y;
    /*
      §5.3's header fields. Container No and Seal No are blank on a draft
      because they are not known yet — printed as an em dash rather than
      omitted, so the person on the floor can see there is a box to fill in.
    */
    const fields: [string, string][] = [
      ['CLP NO', `${clp.code}  ·  ${clp.clpSeq}`],
      ['BOOKING NO', clp.bookingCode],
      ['S/O NO', clp.shippingOrderCode ?? '—'],
      ['CARRIER', clp.carrierName],
      ['CONTAINER NO', clp.containerNo ?? '—'],
      ['SEAL NO', clp.sealNo ?? '—'],
      ['CONTAINER SIZE', clp.containerSizeCode],
      [
        'LOAD DATE & TIME',
        clp.loadDatetime === null ? '—' : new Date(clp.loadDatetime).toISOString().slice(0, 16).replace('T', ' '),
      ],
      ['LOAD BY', clp.loadedBy ?? clp.supervisorName ?? '—'],
      ['CUSTOMER', clp.customerName],
      ['EXPORTER', clp.exporterName ?? '—'],
      /*
        Two fields rather than "Hamburg -> Chattogram". The arrow was drawn
        with U+2192, which is not in WinAnsi — the encoding pdfkit uses for the
        built-in Helvetica — so it came out of the printer as mojibake. Any
        character outside that set does; see the note on the font below.
      */
      ['POL / AOL', clp.polName],
      ['POD / AOD', clp.podName],
    ];

    const colW = fullWidth / 3;
    fields.forEach(([label, value], index) => {
      const x = left + (index % 3) * colW;
      const y = headerY + Math.floor(index / 3) * 30;
      doc.font('Helvetica').fontSize(6.5).fillColor(STEEL).text(label, x, y, { width: colW - 8 });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(HULL)
        .text(winAnsi(value), x, y + 9, { width: colW - 8, ellipsis: true, height: 12 });
    });

    let y = headerY + Math.ceil(fields.length / 3) * 30 + 8;

    // -------------------------------------------------------------- table
    const tableWidth = COLUMNS.reduce((total, c) => total + c.width, 0);
    const scale = tableWidth > fullWidth ? fullWidth / tableWidth : 1;
    const widths = COLUMNS.map((c) => c.width * scale);

    const row = (
      cells: string[],
      options: { bold?: boolean; fill?: string; size?: number },
    ): void => {
      const height = 15;
      if (options.fill !== undefined) {
        doc.rect(left, y, fullWidth, height).fill(options.fill);
      }
      let x = left;
      cells.forEach((cell, index) => {
        doc
          .font(options.bold === true ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(options.size ?? 7.5)
          .fillColor(HULL)
          .text(winAnsi(cell), x + 3, y + 4, {
            width: widths[index]! - 6,
            align: COLUMNS[index]!.align,
            ellipsis: true,
            height: 10,
          });
        x += widths[index]!;
      });
      doc
        .moveTo(left, y + height)
        .lineTo(right, y + height)
        .lineWidth(0.5)
        .strokeColor(LINE)
        .stroke();
      y += height;
    };

    row(COLUMNS.map((c) => c.label), { bold: true, fill: PAPER, size: 6.5 });
    for (const line of clp.lines) {
      row(COLUMNS.map((c) => c.value(line)), {});
    }

    /*
      The TOTAL row, matching the client's sample. The first cell carries the
      PO count — "3 PO" — because that is how they wrote it, and a planner
      reading the sheet wants to know how many orders are in the box before
      they want any of the sums.
    */
    const poCount = new Set(clp.lines.map((l) => l.poNo)).size;
    row(
      COLUMNS.map((c, index) => {
        if (index === 0) return `${poCount} PO`;
        return c.total === undefined ? '' : c.total(clp.lines);
      }),
      { bold: true, fill: PAPER },
    );

    if (clp.lines.length === 0) {
      doc.font('Helvetica').fontSize(8).fillColor(STEEL).text('Nothing loaded.', left, y + 6);
      y += 20;
    }

    // --------------------------------------------------------- signatures
    /*
      §5.3 — three blocks, signed on the floor. Placed against the bottom
      margin rather than after the table so they land in the same place on
      every copy; somebody countersigning a stack of them should not have to
      hunt for the line.
    */
    const signY = Math.max(y + 40, doc.page.height - doc.page.margins.bottom - 72);
    const blocks: [string, string | null][] = [
      ['SUPERVISOR', clp.supervisorName],
      ['TALLY MAN', clp.tallyManName],
      ['CARRIER REPRESENTATIVE', null],
    ];
    const blockW = fullWidth / 3;
    blocks.forEach(([label, name], index) => {
      const x = left + index * blockW;
      doc
        .moveTo(x, signY + 28)
        .lineTo(x + blockW - 24, signY + 28)
        .lineWidth(0.5)
        .strokeColor(STEEL)
        .stroke();
      doc.font('Helvetica').fontSize(6.5).fillColor(STEEL).text(label, x, signY + 32);
      if (name !== null && name !== '') {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(HULL).text(winAnsi(name), x, signY + 42);
      }
    });

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(STEEL)
      .text(
        `Printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by ${clp.generatedBy}`,
        left,
        doc.page.height - doc.page.margins.bottom - 10,
        { width: fullWidth },
      );

    /*
      The stamp goes on LAST so it sits over the content rather than under it.
      Drawn under the table, a light watermark on a white page is invisible
      wherever a filled header cell covers it.
    */
    if (clp.status === 'DRAFT') stampDraft(doc);
    if (clp.status === 'CANCELLED') stampCancelled(doc);

    doc.end();
  });
}

/** `CLP-2026-000001-draft.pdf` — the state is in the filename too. */
export function clpPdfFilename(clp: Pick<ClpPrintDoc, 'code' | 'status'>): string {
  const suffix = clp.status === 'FINAL' ? '' : `-${clp.status.toLowerCase()}`;
  return `${clp.code}${suffix}.pdf`;
}
