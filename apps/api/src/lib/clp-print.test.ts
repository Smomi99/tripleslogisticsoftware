import { describe, expect, it } from 'vitest';

import { buildClpPdf, type ClpPrintDoc, clpPdfFilename } from './clp-print';
import { extractPdfText } from './pdf-text';

/**
 * The CLP document — MODULE_CLP.md §5.3, and §4.3's DRAFT watermark.
 *
 * Reading text back out of a PDF needs care. pdfkit compresses its content
 * streams, so the words are not sitting in the bytes as plain ASCII — a test
 * that greps the raw buffer for "DRAFT" passes for the wrong reason (it finds
 * the string in an uncompressed font or metadata blob) or fails for the wrong
 * one. `extractText` below inflates the streams first.
 */

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
    const text = extractPdfText(await buildClpPdf(doc({ status: 'DRAFT' })));
    expect(text).toMatch(/DRAFT/);
  });

  it('does not stamp a final plan', async () => {
    // The whole point of the mark is that it distinguishes the two.
    const text = extractPdfText(await buildClpPdf(doc({ status: 'FINAL' })));
    expect(text).not.toMatch(/DRAFT/);
  });

  it('stamps a cancelled plan too', async () => {
    const text = extractPdfText(await buildClpPdf(doc({ status: 'CANCELLED' })));
    expect(text).toMatch(/CANCELLED/);
  });

  it('leaves the figures readable under the stamp', async () => {
    // A watermark that obscured the carton counts would just be printed
    // again without it. Everything still has to be on the page.
    const text = extractPdfText(await buildClpPdf(doc({ status: 'DRAFT' })));
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
    const text = extractPdfText(await buildClpPdf(doc()));
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
    const text = extractPdfText(await buildClpPdf(doc()));
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
    const text = extractPdfText(await buildClpPdf(doc()));
    expect(text).toContain('2 PO');
    expect(text).toContain('200'); // 120 + 80 cartons
    expect(text).toContain('4,000'); // 2400 + 1600 pieces
    expect(text).toContain('19.2000'); // 11.52 + 7.68 CBM
  });

  it('counts POs, not lines', async () => {
    // Two allocations of one PO is one PO on the sheet.
    const samePo = LINES.map((l) => ({ ...l, poNo: 'PO-001' }));
    const text = extractPdfText(await buildClpPdf(doc({ lines: samePo })));
    expect(text).toContain('1 PO');
  });

  it('draws the three signature blocks', async () => {
    const text = extractPdfText(await buildClpPdf(doc()));
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
    const text = extractPdfText(
      await buildClpPdf(doc({ status: 'DRAFT', containerNo: null, sealNo: null })),
    );
    expect(text).toContain('CONTAINER NO');
    expect(text).toContain('SEAL NO');
  });

  it('prints a plan with no cargo rather than failing', async () => {
    const pdf = await buildClpPdf(doc({ status: 'DRAFT', lines: [] }));
    expect(pdf.length).toBeGreaterThan(500);
    expect(extractPdfText(pdf)).toContain('Nothing loaded');
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
      const text = extractPdfText(pdf);
      expect(text).toContain('Hamburg');
      expect(text).toContain('Chattogram');
      expect(text).not.toMatch(/[←-⇿]/);
    });
  });

  it('replaces anything outside the set with a visible question mark', async () => {
    // Ugly on purpose. A question mark gets reported; a silently wrong glyph
    // gets signed for.
    const text = extractPdfText(
      await buildClpPdf(doc({ customerName: 'Aঢাকা Traders' })),
    );
    expect(text).toMatch(/A\?+ Traders/);
  });

  it('keeps the punctuation WinAnsi does have', async () => {
    const text = extractPdfText(await buildClpPdf(doc({ sealNo: 'SL—992' })));
    expect(text).toContain('SL—992');
  });
});
