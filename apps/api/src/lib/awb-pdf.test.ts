import { describe, expect, it } from 'vitest';

import { type AwbPdfInput, awbQrText, flightDate, flightDay, goodsText, renderAwbPdf } from './awb-pdf';
import { airlineDesignator } from './bl-draft-view';
import { extractPdfText } from './pdf-text';

/**
 * The House Air Waybill (MODULE_DOCUMENTATION §14), drawn on the client's own
 * sample of 2026-10-15 — their booking to Vienna via Sharjah on Air Arabia.
 */

const awb: AwbPdfInput = {
  companyName: 'Triple S Logistics',
  issuerDetails: 'UNIT C-4, HOUSE-85, ROAD-4, BLOCK-B, BANANI\nAIN NO-301190465\nFF LICENSE NO- 0465/19',
  logo: null,
  hawbNo: 'TSL2607001',
  mawbNo: '514-12345675',
  bookingNo: 'BKG-2026-000305',
  isDraft: false,
  shipperText: 'DARKESH TEX WEAR LTD.\nPLOT # A-169/170, BSCIC INDUSTRIAL AREA',
  consigneeText: 'PETER MLAKAR\nM-2000 D.O.OPRI BAJERJU 25A',
  notifyText: 'PETER MLAKAR',
  departureAirport: 'Dhaka Airport, Bangladesh',
  destinationAirport: 'Vienna International Airport',
  routing: 'DAC-SHJ-VIE',
  legs: [
    { toCode: 'SHJ', toName: 'Sharjah', carrier: 'G9', flightNo: 'G9 507', departure: '2026-07-10' },
    { toCode: 'VIE', toName: 'Vienna International Airport', carrier: 'G9', flightNo: 'G9 129', departure: '2026-07-12' },
  ],
  currency: 'USD',
  freightTerms: 'COLLECT',
  packageCount: 176,
  grossWeightKg: '3880',
  chargeableWeightKg: '3880.000',
  measurementCbm: '21.4',
  goodsDescription: 'ORDER NO : 488, STYLE NO : HERO SHORT SLEEVE CREW-NECK T-SHIRT\nHS CODE: 61091000',
  deliveryAgentText: 'TPG EXPRESS GMBH\nFRIHUSWEG 2, PREMSTATTEN, AUSTRIA',
  executedOn: '2026-07-09',
  executedAt: 'DESTINATION',
  issuingOffice: 'TSL/DAC',
  issuedOn: '2026-07-09',
};

describe('the airline in a flight number', () => {
  it('is the two-character designator', () => {
    expect(airlineDesignator('G9 507')).toBe('G9');
    expect(airlineDesignator('BG388')).toBe('BG');
    expect(airlineDesignator('ek-585')).toBe('EK');
    expect(airlineDesignator('3K 512A')).toBe('3K');
  });

  it('is nothing when the number does not carry one, so the name prints instead', () => {
    expect(airlineDesignator(null)).toBeNull();
    expect(airlineDesignator('1234')).toBeNull();
    expect(airlineDesignator('UAE585')).toBeNull();
    expect(airlineDesignator('to be advised')).toBeNull();
  });
});

describe('the waybill boxes', () => {
  it('writes a flight as the sample does', () => {
    expect(flightDay('2026-07-12')).toBe('12-Jul-26');
    expect(flightDate(awb.legs[0])).toBe('G9 507/10-Jul-26');
    expect(flightDate({ ...awb.legs[0]!, departure: null })).toBe('G9 507');
    expect(flightDate(undefined)).toBeNull();
  });

  it('puts the volume and the delivery agent under the goods', () => {
    expect(goodsText(awb).split('\n\n')).toEqual([
      awb.goodsDescription,
      'VOLUME: 21.4 CBM',
      'Delivery Agent :\nTPG EXPRESS GMBH\nFRIHUSWEG 2, PREMSTATTEN, AUSTRIA',
    ]);
    expect(goodsText({ ...awb, measurementCbm: null, deliveryAgentText: null })).toBe(awb.goodsDescription);
  });
});

describe('the waybill QR', () => {
  it('carries the particulars, and says which original the page is', () => {
    const text = awbQrText(awb, { mark: 'ORIGINAL', note: '2-CONSIGNEE', watermark: null });
    expect(text.split('\n')).toEqual([
      'HOUSE AIR WAYBILL',
      'HAWB No: TSL2607001',
      'MAWB No: 514-12345675',
      'Document: ORIGINAL 2-CONSIGNEE',
      'Issued by: Triple S Logistics',
      'Booking: BKG-2026-000305',
      'Shipper: DARKESH TEX WEAR LTD.',
      'Consignee: PETER MLAKAR',
      'Routing: DAC-SHJ-VIE',
      'Flight: G9 507/10-Jul-26',
      'Pieces: 176',
      'Gross Wt: 3880.00 KG',
      'Chargeable Wt: 3880.00 KG',
      'Executed: 09/07/2026',
      'Issued: 09/07/2026',
    ]);
  });

  it('says a draft is not valid', () => {
    expect(awbQrText({ ...awb, isDraft: true }, null)).toContain('Document: DRAFT - not valid');
  });
});

describe('the printed waybill', () => {
  it('draws the client sample: numbers, parties, routing, charges and whose original it is', async () => {
    const pdf = await renderAwbPdf({
      ...awb,
      copies: [{ mark: 'ORIGINAL', note: '1-ISSUING CARRIER', watermark: null }],
    });
    const text = extractPdfText(pdf);
    for (const expected of [
      'MASTER AIR WAY BILL NO',
      '514-12345675',
      'HOUSE AIR WAY BILL NUMBER',
      'TSL2607001',
      'TRIPLE S LOGISTICS',
      'AIN NO-301190465',
      'DARKESH TEX WEAR LTD.',
      'PETER MLAKAR',
      'Dhaka Airport, Bangladesh . DAC-SHJ-VIE',
      'SHJ',
      'G9',
      'Vienna International Airport',
      'FREIGHT COLLECT',
      'USD',
      'CC',
      'N.V.D',
      'As Per Invoice',
      'G9 507/10-Jul-26',
      'G9 129/12-Jul-26',
      '176',
      '3880.00',
      'AS ARRANGED',
      'VOLUME: 21.40 CBM',
      'TPG EXPRESS GMBH',
      '09/07/2026',
      'DESTINATION',
      'TSL/DAC',
      '1-ISSUING CARRIER',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).not.toContain('FREIGHT PREPAID');
    expect(text).not.toContain('DRAFT');
  });

  it('marks a prepaid waybill PP, and a copy as not negotiable', async () => {
    const pdf = await renderAwbPdf({
      ...awb,
      freightTerms: 'PREPAID',
      copies: [{ mark: 'COPY', note: 'NOT NEGOTIABLE', watermark: 'COPY' }],
    });
    const text = extractPdfText(pdf);
    expect(text).toContain('FREIGHT PREPAID');
    expect(text).toContain('PP');
    expect(text).toContain('COPY — NOT NEGOTIABLE');
    expect(text).not.toContain('FREIGHT COLLECT');
  });

  it('says DRAFT across a draft', async () => {
    const text = extractPdfText(await renderAwbPdf({ ...awb, isDraft: true }));
    expect(text).toContain('DRAFT');
  });
});
