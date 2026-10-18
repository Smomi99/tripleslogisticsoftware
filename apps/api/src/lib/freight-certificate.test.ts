import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client';
import { convertToDollars } from './freight-certificate';
import { renderFreightCertificatePdf } from './freight-certificate-pdf';

const D = (v: string) => new Prisma.Decimal(v);

describe('the certificate’s dollar figure', () => {
  it('states a taka invoice in dollars at the dollar rate, to the cent', () => {
    const figure = convertToDollars(D('100000.0000'), 7n, D('120'));
    expect(figure.currencyId).toBe(7n);
    expect(figure.amount.toFixed(2)).toBe('833.33');
    expect(figure.rate.toString()).toBe('120');
  });
});

describe('the certificate PDF', () => {
  it('prints an air certificate with no conversion line when there is nothing to convert', async () => {
    const pdf = await renderFreightCertificatePdf({
      companyName: 'Triple S Logistics',
      refNo: 'FC-2026-000001',
      certificateDate: '2026-10-18',
      isAir: true,
      shipperText: 'Shafidi Exports Ltd.',
      packages: null,
      commodity: null,
      commercialInvoiceNo: null,
      commercialInvoiceDate: null,
      expNo: null,
      expDate: null,
      blNo: null,
      lcNo: null,
      portOfLoading: 'Dhaka',
      portOfDelivery: 'Frankfurt',
      amount: '120.0000',
      amountInWords: 'US Dollars One hundred and twenty only',
      conversionRate: null,
      baseCurrencyCode: 'USD',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
