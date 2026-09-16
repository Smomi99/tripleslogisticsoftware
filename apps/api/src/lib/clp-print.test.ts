import { describe, expect, it } from 'vitest';

import { buildClpPdf, type ClpPrintDoc, clpPdfFilename } from './clp-print';
import { extractPdfText, placements } from './pdf-text';

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

// ==================== CR-002 §16 — a shared container names everyone in it

/**
 * A consolidated load plan is signed on a warehouse floor by someone who has
 * to know whose cartons are going into the box. Printing only the first
 * booking is how the third customer's cargo gets loaded without anybody
 * noticing it was there.
 *
 * `bookingCodes` is the server's participation list, built from
 * `participantShipmentIds`. The renderer never works out who is in the box
 * for itself, and there is no second definition of participation here — these
 * tests hand it a list and check what comes out on the page.
 */
describe('§16 — every booking in the box', () => {
  const codes = (n: number) =>
    Array.from({ length: n }, (_, i) => `BKG-2026-${String(i + 1).padStart(6, '0')}`);

  const once = (text: string, needle: string) => text.split(needle).length - 1;

  it('a single-booking plan reads exactly as it did', async () => {
    const text = extractPdfText(await buildClpPdf(doc({ status: 'FINAL' })));
    // The ordinary document: one labelled booking field, no consolidation
    // furniture at all.
    expect(text).toContain('BOOKING NO');
    expect(text).toContain('BKG-2026-000004');
    expect(text).not.toMatch(/CONSOLIDATED CONTAINER/);
    expect(text).not.toContain('BOOKINGS IN THIS CONTAINER');
  });

  it('a canonical single-booking plan reads the same way', async () => {
    /*
      A selection of one through /clps/consolidate is still a SINGLE plan, and
      it must not sprout a consolidation block just because it came down the
      newer route.
    */
    const text = extractPdfText(
      await buildClpPdf(doc({ consolidated: false, bookingCodes: ['BKG-2026-000004'] })),
    );
    expect(text).toContain('BOOKING NO');
    expect(text).toContain('BKG-2026-000004');
    expect(text).not.toMatch(/CONSOLIDATED CONTAINER/);
  });

  it('two bookings: both named, and the sheet says it is consolidated', async () => {
    const text = extractPdfText(
      await buildClpPdf(doc({ consolidated: true, bookingCodes: codes(2) })),
    );
    expect(text).toMatch(/CONSOLIDATED CONTAINER\s+·\s+2 BOOKINGS/);
    expect(text).toContain('BOOKINGS IN THIS CONTAINER');
    expect(text).toContain('BKG-2026-000001');
    expect(text).toContain('BKG-2026-000002');
    /*
      And the header field carries the COUNT rather than one of the two. A
      field labelled "BOOKING NO" showing one of several is the thing §16
      exists to prevent.
    */
    expect(text).toContain('BOOKINGS');
    expect(text).not.toContain('BOOKING NO');
  });

  it('five bookings: every one, exactly once', async () => {
    const wanted = codes(5);
    const text = extractPdfText(
      await buildClpPdf(doc({ consolidated: true, bookingCodes: wanted })),
    );
    expect(text).toMatch(/5 BOOKINGS/);
    for (const code of wanted) {
      expect(once(text, code)).toBe(1);
    }
  });

  it('keeps the order the server gave, not a sorted or reversed one', async () => {
    /*
      Participation order is clp_booking.id — the order the consolidation was
      built in. Deliberately fed out of alphabetical sequence so a silent sort
      would show up.
    */
    const given = ['BKG-2026-000019', 'BKG-2026-000004', 'BKG-2026-000011'];
    const text = extractPdfText(
      await buildClpPdf(doc({ consolidated: true, bookingCodes: given })),
    );
    const positions = given.map((code) => text.indexOf(code));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('a long list wraps instead of running over the table', async () => {
    /*
      Fourteen bookings is more than one line at this width. The block is laid
      out through pdfkit's own flow and the table takes its y from `doc.y`
      afterwards, so the table moves DOWN rather than the list writing over
      it. Checked as placements in the content stream rather than as reading
      order, because reading order would look fine either way.
    */
    const wanted = codes(14);
    const pdf = await buildClpPdf(doc({ consolidated: true, bookingCodes: wanted }));
    const text = extractPdfText(pdf);
    for (const code of wanted) expect(once(text, code)).toBe(1);

    const placed = placements(pdf);
    const listYs = placed.filter((r) => r.text.includes('BKG-2026-')).map((r) => r.y);
    const tableY = placed.find((r) => r.text.trim() === 'PO')?.y;
    expect(listYs.length).toBeGreaterThan(1); // it really did wrap
    expect(tableY).toBeDefined();
    // PDF user space grows upward, so every line of the list sits above the
    // table header.
    expect(Math.min(...listYs)).toBeGreaterThan(tableY!);
  });

  it('is still a valid PDF, and still carries its watermark', async () => {
    const pdf = await buildClpPdf(
      doc({ status: 'DRAFT', consolidated: true, bookingCodes: codes(8) }),
    );
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = extractPdfText(pdf);
    expect(text).toContain('DRAFT');
    expect(text).toContain('BOOKINGS IN THIS CONTAINER');
  });
});
