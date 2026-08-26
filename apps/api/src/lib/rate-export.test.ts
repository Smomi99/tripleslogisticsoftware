import type { FreightRateDto } from '@ff/shared';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { buildRatePdf, buildRateWorkbook } from './rate-export';

/**
 * The price list as a file (§5.3, §4 rule 12).
 *
 * Two things are worth this much care. A local charge total with no breakdown
 * is the figure a carrier queries first, and answering it should not mean
 * opening the app — so both formats have to carry the charges, in the shape
 * each is read in. And §4 rule 5 says a withheld buy price must be absent from
 * a file, not blanked: a spreadsheet gets forwarded.
 */

const charge = (over: Partial<FreightRateDto['localCharges'][number]> = {}) =>
  ({
    id: '1',
    costHeadId: '10',
    costHeadName: 'Seal Charge',
    side: 'POL',
    amount: '13.0000',
    currencyId: '1',
    currencyCode: 'USD',
    costUnitId: null,
    costUnitName: 'Container',
    containerSizeId: null,
    containerSizeCode: '20STD',
    remarks: null,
    ...over,
  }) as FreightRateDto['localCharges'][number];

const rate = (over: Partial<FreightRateDto> = {}): FreightRateDto =>
  ({
    id: '1',
    code: 'RATE-001',
    mode: 'SEA_FCL',
    polId: '1',
    polCode: 'BDCGP',
    polName: 'Chittagong',
    podId: '2',
    podCode: 'DEHAM',
    podName: 'Hamburg',
    carrierId: '1',
    carrierName: 'Maersk',
    goodsTypeId: '1',
    goodsTypeName: 'Textile',
    currencyId: '1',
    currencyCode: 'USD',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    status: 'PUBLISHED',
    transitDays: 24,
    freeDays: 7,
    remarks: null,
    expiringSoon: false,
    purchaseSourceType: 'CARRIER',
    purchaseSourceName: 'Maersk',
    lines: [
      {
        id: '1',
        tierId: '1',
        tierCode: '20STD',
        buyPrice: '1000.0000',
        sellPrice: '1200.0000',
        profitType: 'FLAT',
        profitValue: '200.0000',
        minCharge: null,
      },
    ],
    localCharges: [charge()],
    localChargeCount: 1,
    localChargeTotal: '13.0000',
    ...over,
  }) as unknown as FreightRateDto;

const context = (rates: FreightRateDto[]) => ({
  mode: 'SEA_FCL' as const,
  rates,
  workspaceName: 'Acme Freight',
  generatedBy: 'superadmin',
});

async function readWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

describe('the workbook', () => {
  it('names the ports rather than coding them', async () => {
    // Somebody reading a forwarded spreadsheet knows Chittagong and would have
    // to look up BDCGP.
    const workbook = await readWorkbook(await buildRateWorkbook(context([rate()])));
    const sheet = workbook.worksheets[0]!;
    const row = sheet.getRow(5).values as unknown[];
    expect(row).toContain('Chittagong');
    expect(row).toContain('Hamburg');
  });

  it('carries the local charges on a sheet of their own', async () => {
    /*
     * Not inline on the main sheet: charges vary in number per rate, so
     * putting them there turns every formula and filter on a price list into a
     * special case. A second sheet answers the same question without damaging
     * the first.
     */
    const workbook = await readWorkbook(
      await buildRateWorkbook(
        context([
          rate({
            localCharges: [
              charge(),
              charge({ id: '2', costHeadName: 'ENS Charge', side: 'POD', amount: '30.0000', containerSizeCode: null }),
            ],
            localChargeCount: 2,
            localChargeTotal: '43.0000',
          }),
        ]),
      ),
    );

    const detail = workbook.getWorksheet('Local charges');
    expect(detail).toBeDefined();
    const rows = detail!.getSheetValues();
    const flat = JSON.stringify(rows);
    expect(flat).toContain('Seal Charge');
    expect(flat).toContain('ENS Charge');
    // Keyed by the rate code, so filtering the sheet gives one rate's charges.
    expect(flat).toContain('RATE-001');
    // The client's own wording for a charge that bills whatever the equipment.
    expect(flat).toContain('All');
  });

  it('keeps the total on the main sheet, so it still sums', async () => {
    const workbook = await readWorkbook(await buildRateWorkbook(context([rate()])));
    const values = JSON.stringify(workbook.worksheets[0]!.getSheetValues());
    expect(values).toContain('13');
  });

  it('adds no charges sheet when there are none', async () => {
    const workbook = await readWorkbook(
      await buildRateWorkbook(
        context([rate({ localCharges: [], localChargeCount: 0, localChargeTotal: '0.0000' })]),
      ),
    );
    expect(workbook.getWorksheet('Local charges')).toBeUndefined();
  });

  it('omits the buy price entirely when it was withheld', async () => {
    // §4 rule 5. Absent, not blank — a blank column invites someone to ask why
    // it is empty, and a file gets forwarded.
    const withheld = rate();
    withheld.lines = withheld.lines.map((line) => {
      const copy = { ...line };
      delete (copy as { buyPrice?: string }).buyPrice;
      return copy;
    });
    const workbook = await readWorkbook(await buildRateWorkbook(context([withheld])));
    const header = JSON.stringify(workbook.worksheets[0]!.getRow(4).values);
    expect(header).not.toContain('buy');
    expect(header).toContain('sell');
  });
});

describe('the PDF', () => {
  it('is produced, with the charges under their rate', async () => {
    // pdfkit output is binary, so this asserts it built and is a PDF; the
    // shape of the page is a visual matter checked in the browser.
    const buffer = await buildRatePdf(
      context([rate({ localCharges: [charge(), charge({ id: '2' })], localChargeCount: 2 })]),
    );
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('survives a rate with no charges at all', async () => {
    const buffer = await buildRatePdf(
      context([rate({ localCharges: [], localChargeCount: 0, localChargeTotal: '0.0000' })]),
    );
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('survives an empty price list', async () => {
    const buffer = await buildRatePdf(context([]));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
