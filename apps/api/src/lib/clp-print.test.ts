import { describe, expect, it } from 'vitest';

import { buildClpPdf, type ClpPrintDoc, clpPdfFilename } from './clp-print';

/**
 * The CLP document — MODULE_CLP.md §5.3, and §4.3's DRAFT watermark.
 *
 * Reading text back out of a PDF needs care. pdfkit compresses its content
 * streams, so the words are not sitting in the bytes as plain ASCII — a test
 * that greps the raw buffer for "DRAFT" passes for the wrong reason (it finds
 * the string in an uncompressed font or metadata blob) or fails for the wrong
 * one. `extractText` below inflates the streams first.
 */

const zlib = await import('node:zlib');

/**
 * Pull the readable text out of a pdfkit buffer.
 *
 * Two things make this less obvious than it sounds. The content streams are
 * Flate-compressed, so the words are not in the file as ASCII. And pdfkit
 * writes text as HEX runs inside a kerned TJ array — "CONTAINER LOAD PLAN"
 * ships as `[<434f4e54> 90 <41494e4552204c4f> 50 <414420504c414e>] TJ`, three
 * runs with kerning numbers between them.
 *
 * So: inflate, then decode each hex run, joining the runs WITHIN one TJ array
 * (that is one word broken by kerning) and separating different TJ operators
 * with a newline (those are different pieces of text, and running them
 * together would manufacture matches that are not on the page).
 */
function extractText(pdf: Buffer): string {
  const pieces: string[] = [];
  let index = 0;

  while (index < pdf.length) {
    const start = pdf.indexOf('stream', index);
    if (start === -1) break;
    let from = start + 'stream'.length;
    if (pdf[from] === 0x0d) from += 1;
    if (pdf[from] === 0x0a) from += 1;
    const end = pdf.indexOf('endstream', from);
    if (end === -1) break;

    let body: string;
    try {
      body = zlib.inflateSync(pdf.subarray(from, end)).toString('latin1');
    } catch {
      body = pdf.subarray(from, end).toString('latin1');
    }

    // Each text-showing operator, with its operand array.
    for (const op of body.matchAll(/\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (op[1] !== undefined) {
        // A kerned array: concatenate its hex and literal runs.
        let run = '';
        for (const part of op[1].matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g)) {
          run += part[1] !== undefined ? fromHex(part[1]) : unescapePdf(part[2] ?? '');
        }
        pieces.push(run);
      } else if (op[2] !== undefined) {
        pieces.push(fromHex(op[2]));
      } else if (op[3] !== undefined) {
        pieces.push(unescapePdf(op[3]));
      }
    }
    index = end + 1;
  }

  return pieces.join(String.fromCharCode(10));
}

/*
  WinAnsi is not Latin-1 in the 0x80-0x9F range: pdfkit writes an em dash as
  the single byte 0x97, which decodes to a control character if you treat the
  bytes as latin1. Without this map the extractor silently loses every piece
  of punctuation the document actually renders correctly.
*/
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  0x80: "\u20ac",
  0x85: "\u2026",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x96: "\u2013",
  0x97: "\u2014",
};

function fromHex(hex: string): string {
  const even = hex.length % 2 === 0 ? hex : `${hex}0`;
  let out = "";
  for (let i = 0; i < even.length; i += 2) {
    const code = Number.parseInt(even.slice(i, i + 2), 16);
    out += WIN_ANSI_HIGH[code] ?? String.fromCharCode(code);
  }
  return out;
}

function unescapePdf(literal: string): string {
  return literal.replace(/\\([()\\])/g, '$1');
}

const LINES = [
  {
    poNo: 'PO-001',
    itemCode: 'SHIRT-A',
    sku: 'WHT-M',
    ctnQty: 120,
    pcsQty: 2400,
    netWeightKg: '2400.000',
    grossWeightKg: '2520.000',
    cartonLengthCm: '60',
    cartonWidthCm: '40',
    cartonHeightCm: '40',
    volumeCbm: '11.5200',
  },
  {
    poNo: 'PO-002',
    itemCode: 'TROUSER-B',
    sku: null,
    ctnQty: 80,
    pcsQty: 1600,
    netWeightKg: '1800.000',
    grossWeightKg: '1880.000',
    cartonLengthCm: '60',
    cartonWidthCm: '40',
    cartonHeightCm: '40',
    volumeCbm: '7.6800',
  },
];

function doc(overrides: Partial<ClpPrintDoc> = {}): ClpPrintDoc {
  return {
    workspaceName: 'Triples Logistics',
    status: 'FINAL',
    code: 'CLP-2026-000001',
    clpSeq: 1,
    bookingCode: 'BKG-2026-000004',
    shippingOrderCode: 'SO-2026-000003',
    carrierName: 'CMA CGM',
    containerSizeCode: '20STD',
    containerNo: 'CSQU3054383',
    sealNo: 'SL-99213',
    loadDatetime: '2026-09-14T08:30:00.000Z',
    loadedBy: null,
    supervisorName: 'Nasir Uddin',
    tallyManName: 'Rafiq Islam',
    polName: 'Hamburg',
    podName: 'Chattogram',
    customerName: 'Sadi Mohammad Omi',
    exporterName: 'AOD international',
    lines: LINES,
    generatedBy: 'superadmin',
    ...overrides,
  };
}

describe('the DRAFT watermark (§4.3)', () => {
  it('stamps a draft', async () => {
    const text = extractText(await buildClpPdf(doc({ status: 'DRAFT' })));
    expect(text).toMatch(/DRAFT/);
  });

  it('does not stamp a final plan', async () => {
    // The whole point of the mark is that it distinguishes the two.
    const text = extractText(await buildClpPdf(doc({ status: 'FINAL' })));
    expect(text).not.toMatch(/DRAFT/);
  });

  it('stamps a cancelled plan too', async () => {
    const text = extractText(await buildClpPdf(doc({ status: 'CANCELLED' })));
    expect(text).toMatch(/CANCELLED/);
  });

  it('leaves the figures readable under the stamp', async () => {
    // A watermark that obscured the carton counts would just be printed
    // again without it. Everything still has to be on the page.
    const text = extractText(await buildClpPdf(doc({ status: 'DRAFT' })));
    expect(text).toMatch(/PO-001/);
    expect(text).toMatch(/120/);
    expect(text).toMatch(/11.5200/);
  });

  it('says which it is in the filename as well', async () => {
    expect(clpPdfFilename({ code: 'CLP-2026-000001', status: 'DRAFT' })).toBe(
      'CLP-2026-000001-draft.pdf',
    );
    expect(clpPdfFilename({ code: 'CLP-2026-000001', status: 'FINAL' })).toBe(
      'CLP-2026-000001.pdf',
    );
  });
});

describe('§5.3 content', () => {
  it('carries the header the client asked for', async () => {
    const text = extractText(await buildClpPdf(doc()));
    for (const wanted of [
      'CONTAINER LOAD PLAN',
      'Triples Logistics',
      'CLP-2026-000001',
      'BKG-2026-000004',
      'SO-2026-000003',
      'CMA CGM',
      'CSQU3054383',
      'SL-99213',
    ]) {
      expect(text, `missing ${wanted}`).toContain(wanted);
    }
  });

  it('carries every line, with its own carton measurements', async () => {
    const text = extractText(await buildClpPdf(doc()));
    expect(text).toContain('PO-001');
    expect(text).toContain('SHIRT-A');
    expect(text).toContain('WHT-M');
    expect(text).toContain('PO-002');
    expect(text).toContain('TROUSER-B');
  });

  it('totals the columns and counts the POs, as the sample does', async () => {
    /*
      The client's own TOTAL row reads "3 PO · 780 · 11,000 · …", so the PO
      count sits in the first cell rather than on a line of its own.
    */
    const text = extractText(await buildClpPdf(doc()));
    expect(text).toContain('2 PO');
    expect(text).toContain('200'); // 120 + 80 cartons
    expect(text).toContain('4,000'); // 2400 + 1600 pieces
    expect(text).toContain('19.2000'); // 11.52 + 7.68 CBM
  });

  it('counts POs, not lines', async () => {
    // Two allocations of one PO is one PO on the sheet.
    const samePo = LINES.map((l) => ({ ...l, poNo: 'PO-001' }));
    const text = extractText(await buildClpPdf(doc({ lines: samePo })));
    expect(text).toContain('1 PO');
  });

  it('draws the three signature blocks', async () => {
    const text = extractText(await buildClpPdf(doc()));
    expect(text).toContain('SUPERVISOR');
    expect(text).toContain('TALLY MAN');
    expect(text).toContain('CARRIER REPRESENTATIVE');
    // And names the two we know.
    expect(text).toContain('Nasir Uddin');
    expect(text).toContain('Rafiq Islam');
  });

  it('shows an empty container number as a blank to fill in, not as nothing', async () => {
    // A draft has no container number yet. The person on the floor needs to
    // see there is a box for it.
    const text = extractText(
      await buildClpPdf(doc({ status: 'DRAFT', containerNo: null, sealNo: null })),
    );
    expect(text).toContain('CONTAINER NO');
    expect(text).toContain('SEAL NO');
  });

  it('prints a plan with no cargo rather than failing', async () => {
    const pdf = await buildClpPdf(doc({ status: 'DRAFT', lines: [] }));
    expect(pdf.length).toBeGreaterThan(500);
    expect(extractText(pdf)).toContain('Nothing loaded');
  });

  it('produces a real PDF', async () => {
    const pdf = await buildClpPdf(doc());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('what the built-in font can draw', () => {
  it('does not put an arrow on the page that the encoding cannot render', () => {
    /*
      A regression test for a bug that reached the rendered page: the POL/POD
      field was drawn as "Hamburg -> Chattogram" using U+2192, which is not in
      WinAnsi, and printed as mojibake. The two ports are separate fields now.
    */
    return buildClpPdf(doc()).then((pdf) => {
      const text = extractText(pdf);
      expect(text).toContain('Hamburg');
      expect(text).toContain('Chattogram');
      expect(text).not.toMatch(/[←-⇿]/);
    });
  });

  it('replaces anything outside the set with a visible question mark', async () => {
    // Ugly on purpose. A question mark gets reported; a silently wrong glyph
    // gets signed for.
    const text = extractText(
      await buildClpPdf(doc({ customerName: 'Aঢাকা Traders' })),
    );
    expect(text).toMatch(/A\?+ Traders/);
  });

  it('keeps the punctuation WinAnsi does have', async () => {
    const text = extractText(await buildClpPdf(doc({ sealNo: 'SL—992' })));
    expect(text).toContain('SL—992');
  });
});
