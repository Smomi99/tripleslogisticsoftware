import { freightTermsOf } from '@ff/shared';
import { describe, expect, it } from 'vitest';

import { blQrText, type BlDraftPdfInput, renderBlDraftPdf } from './bl-draft-pdf';
import { extractPdfText } from './pdf-text';

/**
 * The QR on the bill (§13.4). Whoever holds the paper scans it to check the
 * bill against what it claims, so it has to carry the particulars — and say
 * plainly whether the page is a draft, an original or a copy.
 */

const container = (n: number) => ({
  containerNo: `TEMU10063${String(n).padStart(2, '0')}`,
  containerSize: "20' Standard",
  sealNo: `M26048${String(n).padStart(2, '0')}`,
  ctnQty: 250,
  grossWeightKg: '5981.50',
  measurementCbm: '23.73',
});

const bill: BlDraftPdfInput = {
  companyName: 'Triple S Logistics',
  logo: null,
  serialNo: 'BLD-2026-000246',
  blNo: 'TSLHBL2609170310',
  manifestNo: null,
  bookingNo: 'BKG-2026-000310',
  isDraft: false,
  shipperText: 'DARKESH TEX WEAR LTD.\nPLOT # A-169/170, BSCIC INDUSTRIAL AREA',
  consigneeText: 'TO THE ORDER OF\nAGRANI BANK PLC.\nCOURT ROAD BRANCH, NARAYANGANJ',
  notifyText: 'PETER MLAKAR',
  alsoNotifyText: null,
  exportReferences: null,
  forwardingAgentReferences: null,
  pointCountryOfOrigin: 'Bangladesh',
  preCarriageVesselVoyage: 'CMA CGM SAO PAULO V-0BEORW1MA',
  placeOfReceipt: 'CHATTOGRAM',
  deliveryAgentText: null,
  oceanVesselVoyage: 'CMA CGM SAO PAULO V-0BEORW1MA',
  polName: 'Chattogram',
  podName: 'KOPER',
  placeOfDelivery: 'KOPER',
  packagesDescription: null,
  marksAndNumbers: null,
  grossWeightKg: '5981.50',
  measurementCbm: '23.73',
  containers: [container(75)],
  freightPayableAt: 'DESTINATION',
  freightTerms: 'COLLECT',
  originalBlCount: 3,
  ladenOnBoardDate: '2026-09-22',
  issuedOn: '2026-09-23',
};

describe('the bill of lading QR', () => {
  it('carries the particulars of the bill', () => {
    const text = blQrText(bill, { mark: 'ORIGINAL', note: '1 of 3', watermark: null });
    expect(text.split('\n')).toEqual([
      'BILL OF LADING',
      'B/L No: TSLHBL2609170310',
      'Document: ORIGINAL 1 of 3',
      'Issued by: Triple S Logistics',
      'Booking: BKG-2026-000310',
      'Shipper: DARKESH TEX WEAR LTD.',
      'Consignee: TO THE ORDER OF AGRANI BANK PLC.',
      'Vessel/Voyage: CMA CGM SAO PAULO V-0BEORW1MA',
      'POL: Chattogram',
      'POD: KOPER',
      'Delivery: KOPER',
      "Container: TEMU1006375 / 20' Standard / M2604875",
      'Packages: 250 CTNS',
      'Gross Wt: 5981.50 KG',
      'Measurement: 23.73 CBM',
      'On Board: 22/09/2026',
      'Issued: 23/09/2026',
      'Originals: 3',
    ]);
  });

  it('says what each page is', () => {
    expect(blQrText({ ...bill, isDraft: true }, null)).toContain('Document: DRAFT - not valid');
    expect(blQrText(bill, null)).toContain('Document: Approved draft');
    expect(blQrText(bill, { mark: 'COPY', note: 'NON-NEGOTIABLE', watermark: 'COPY' })).toContain(
      'Document: COPY NON-NEGOTIABLE',
    );
  });

  it('lists the first three containers and counts the rest, so it stays scannable', () => {
    const text = blQrText({ ...bill, containers: [1, 2, 3, 4, 5].map(container) }, null);
    expect(text).toContain('TEMU1006303');
    expect(text).not.toContain('TEMU1006304');
    expect(text).toContain('+ 2 more');
    expect(text).toContain('Packages: 1250 CTNS');
  });

  it('leaves out what the bill does not have yet', () => {
    const text = blQrText(
      { ...bill, issuedOn: null, ladenOnBoardDate: null, placeOfDelivery: null, containers: [] },
      null,
    );
    expect(text).not.toMatch(/^(Issued|On Board|Delivery|Container|Packages):/m);
  });
});

describe('who pays the freight (§13.10 Q8)', () => {
  it('collects under the E and F terms, where the buyer books the carriage', () => {
    for (const tos of ['EXW', 'FCA', 'FAS', 'FOB']) expect(freightTermsOf(tos)).toBe('COLLECT');
  });

  it('prepays under every C and D term, where the seller pays it at origin', () => {
    for (const tos of ['CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']) expect(freightTermsOf(tos)).toBe('PREPAID');
  });

  it('reads the code however it was typed, and says neither when there is none', () => {
    expect(freightTermsOf(' fob ')).toBe('COLLECT');
    expect(freightTermsOf(null)).toBeNull();
  });
});

/** pdfkit writes each page object uncompressed; "/Type /Pages" is the tree. */
const pageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;
const containers = (n: number) => Array.from({ length: n }, (_, i) => container(i + 1));

describe('the containers on the printed bill (client, 2026-10-06)', () => {
  it('lists them under Marks and Numbers when they fit, two lines each', async () => {
    const pdf = await renderBlDraftPdf({ ...bill, containers: containers(2) });
    expect(pageCount(pdf)).toBe(1);
    const text = extractPdfText(pdf);
    expect(text).toContain("TEMU1006301/20' Standard/M2604801");
    expect(text).toContain('23.73 CBM, 5981.50 KGS');
    expect(text).not.toContain('ATTACHED SHEET');
  });

  it('lists every one on an attached sheet when they do not, after each printed page', async () => {
    const pdf = await renderBlDraftPdf({
      ...bill,
      containers: containers(12),
      copies: [
        { mark: 'ORIGINAL', note: '1 of 2', watermark: null },
        { mark: 'ORIGINAL', note: '2 of 2', watermark: null },
      ],
    });
    expect(pageCount(pdf)).toBe(4);
    const text = extractPdfText(pdf);
    expect(text).toContain('12 CONTAINERS');
    expect(text).toContain('AS PER ATTACHED SHEET');
    for (const c of containers(12)) expect(text).toContain(c.containerNo);
    expect(text).toContain('TOTAL 12 CONTAINERS');
  });

  it('runs a long list onto further sheets', async () => {
    const pdf = await renderBlDraftPdf({ ...bill, containers: containers(60) });
    expect(pageCount(pdf)).toBe(3);
    expect(extractPdfText(pdf)).toContain('Container list, sheet 2 of 2');
  });
});
