import {
  composePriceEmailBody,
  defaultPriceEmailSubject,
  emailSyntaxProblem,
  type FreightRateDto,
  priceEmailHtml,
  priceEmailRatesHtml,
  priceEmailRatesText,
} from '@ff/shared';
import { describe, expect, it } from 'vitest';

import { checkAddresses } from './email-check';
import type { DomainVerdict } from './email-domain';

/**
 * CRM → Customer → Email prices: the address check, and the text the rates
 * become. Pure functions, so no database — and no DNS: the domain lookup is
 * passed in, because a suite that needs the public internet fails on a train.
 */

describe('the shape of an address', () => {
  it('passes an ordinary address', () => {
    expect(emailSyntaxProblem('rahim.uddin@dhaka-apparels.com.bd')).toBeNull();
    expect(emailSyntaxProblem('  ops+rates@example.com ')).toBeNull();
  });

  it('names the fix for each way it goes wrong', () => {
    expect(emailSyntaxProblem('')).toMatch(/Empty/);
    expect(emailSyntaxProblem('rahim.example.com')).toMatch(/Missing the @/);
    expect(emailSyntaxProblem('rahim@@example.com')).toMatch(/more than one @/);
    expect(emailSyntaxProblem('@example.com')).toMatch(/Nothing before the @/);
    expect(emailSyntaxProblem('rahim@')).toMatch(/Nothing after the @/);
    expect(emailSyntaxProblem('rahim@example')).toMatch(/has no ending/);
    expect(emailSyntaxProblem('ra him@example.com')).toMatch(/space/);
    expect(emailSyntaxProblem('rahim..u@example.com')).toMatch(/before the @/);
    expect(emailSyntaxProblem('rahim@exa_mple.com')).toMatch(/not a valid domain/);
    expect(emailSyntaxProblem('rahim@example.c0m')).toMatch(/real domain ending/);
  });

  it('catches the typos that DNS alone would let through', () => {
    expect(emailSyntaxProblem('rahim@gmial.com')).toBe(
      'Looks like a typo — did you mean rahim@gmail.com?',
    );
    expect(emailSyntaxProblem('rahim@yahoo.con')).toMatch(/yahoo\.com/);
  });
});

describe('checking a batch', () => {
  const verdicts: Record<string, DomainVerdict> = {
    'example.com': 'accepts-mail',
    'gone.example': 'no-such-domain',
    'parked.example': 'no-mail',
    'slow.example': 'unknown',
  };

  it('fails a domain that does not exist or takes no mail, and passes one it could not check', async () => {
    const looked: string[] = [];
    const result = await checkAddresses(
      ['a@example.com', 'b@gone.example', 'c@parked.example', 'd@slow.example', 'broken'],
      async (domain) => {
        looked.push(domain);
        return verdicts[domain] ?? 'accepts-mail';
      },
    );

    expect(result.map((r) => r.valid)).toEqual([true, false, false, true, false]);
    expect(result[1]?.reason).toMatch(/gone\.example does not exist/);
    expect(result[2]?.reason).toMatch(/does not receive email/);
    // A resolver that did not answer is not evidence against the address.
    expect(result[3]?.reason).toBeNull();
    // Malformed addresses never reach DNS.
    expect(looked).not.toContain('broken');
  });

  it('looks each domain up once, and answers in the order asked', async () => {
    const looked: string[] = [];
    const result = await checkAddresses(
      ['x@example.com', 'y@EXAMPLE.com', 'x@example.com'],
      async (domain) => {
        looked.push(domain);
        return 'accepts-mail';
      },
    );
    expect(looked).toEqual(['example.com']);
    expect(result.map((r) => r.address)).toEqual(['x@example.com', 'y@EXAMPLE.com', 'x@example.com']);
  });
});

describe('the rates as the letter prints them', () => {
  const rate = {
    id: '1',
    code: 'FR-1',
    mode: 'SEA_FCL',
    polId: '10',
    polName: 'Chattogram',
    polCode: 'BDCGP',
    podId: '20',
    podName: 'Hamburg',
    podCode: 'DEHAM',
    carrierId: '5',
    carrierName: 'Q Lines',
    goodsTypeId: '7',
    goodsTypeName: 'General',
    currencyCode: 'USD',
    validFrom: '2026-10-01',
    validTo: '2026-10-31',
    route: 'via Colombo',
    transitDays: 28,
    freeDays: 14,
    remarks: 'Bought on the phone from Karim — do not show',
    lines: [
      {
        id: 'l1',
        tierId: 't1',
        tierCode: 'FCL-20STD',
        tierLabel: '20STD',
        sellPrice: '1250.0000',
        minCharge: null,
        buyPrice: '1100.0000',
        profitType: 'FLAT',
        profitValue: '150.0000',
      },
    ],
    localCharges: [
      {
        id: 'c1',
        costHeadId: '3',
        costHeadName: 'Seal Charge',
        side: 'POL',
        amount: '13.0000',
        currencyId: '1',
        currencyCode: 'USD',
        costUnitName: 'Container',
        containerSizeId: null,
        containerSizeCode: '20STD',
        remarks: null,
      },
    ],
  } as unknown as FreightRateDto;

  it('prints the lane, the terms and the selling price', () => {
    const text = priceEmailRatesText([rate], { includeLocalCharges: true });
    expect(text).toBe(
      [
        'Chattogram (BDCGP) to Hamburg (DEHAM) — Sea FCL',
        'Carrier: Q Lines · Goods: General',
        'Valid 01 Oct 2026 to 31 Oct 2026 · Transit 28 days · Free time 14 days · Route: via Colombo',
        '• 20STD: USD 1,250.00 per container',
        'Origin charges: Seal Charge USD 13.00 per Container (20STD)',
      ].join('\n'),
    );
  });

  it('never prints what we paid, the margin, or the buyer notes', () => {
    const text = priceEmailRatesText([rate], { includeLocalCharges: true });
    expect(text).not.toContain('1,100');
    expect(text).not.toContain('1100');
    expect(text).not.toContain('150.00');
    expect(text).not.toContain('Karim');
  });

  it('leaves the local charges out when asked', () => {
    expect(priceEmailRatesText([rate], { includeLocalCharges: false })).not.toContain('Seal');
  });

  it('names LCL and air tiers as quantities, with their minimum', () => {
    const lcl = {
      ...rate,
      mode: 'SEA_LCL',
      lines: [{ ...rate.lines[0]!, tierLabel: '0-5', sellPrice: '45', minCharge: '90' }],
    } as FreightRateDto;
    expect(priceEmailRatesText([lcl], { includeLocalCharges: false })).toContain(
      '• 0-5 CBM: USD 45.00 per CBM (minimum USD 90.00)',
    );
  });

  describe('as a table — the HTML part', () => {
    it('lays the rates out like the Price List: one column per tier', () => {
      const html = priceEmailRatesHtml([rate], { includeLocalCharges: false });
      for (const header of ['Carrier', '20STD', 'Transit days', 'Free days', 'Route', 'Valid until']) {
        expect(html).toContain(`>${header}</th>`);
      }
      expect(html).toContain('>1,250.00</td>');
      expect(html).toContain('31 Oct 2026');
    });

    it('says once in the heading what every row shares, to keep the table narrow', () => {
      const html = priceEmailRatesHtml([rate], { includeLocalCharges: false });
      expect(html).toContain('Sea FCL rates · Chattogram to Hamburg · General');
      expect(html).toContain('prices in USD per container');
      for (const hoisted of ['POL', 'POD', 'Goods']) expect(html).not.toContain(`>${hoisted}</th>`);
    });

    it('keeps a column where the rows differ', () => {
      const rotterdam = {
        ...rate,
        id: '2',
        podId: '21',
        podName: 'Rotterdam',
        goodsTypeId: '8',
        goodsTypeName: 'Garments',
        currencyCode: 'EUR',
        route: null,
      } as FreightRateDto;
      const html = priceEmailRatesHtml([rate, rotterdam], { includeLocalCharges: false });
      expect(html).toContain('Sea FCL rates · from Chattogram');
      expect(html).not.toContain('>POL</th>');
      expect(html).toContain('>POD</th>');
      expect(html).toContain('>Goods</th>');
      // Two currencies: each figure says its own.
      expect(html).toContain('1,250.00 USD');
      expect(html).toContain('1,250.00 EUR');
      expect(html).toContain('prices per container');
    });

    it('drops a column that is empty on every row', () => {
      const bare = { ...rate, route: null, freeDays: null } as FreightRateDto;
      const html = priceEmailRatesHtml([bare], { includeLocalCharges: false });
      expect(html).not.toContain('>Route</th>');
      expect(html).not.toContain('>Free days</th>');
      expect(html).toContain('>Transit days</th>');
    });

    it('never carries the buying side, the buyer notes or our internal rate code', () => {
      const html = priceEmailRatesHtml([rate], { includeLocalCharges: true });
      expect(html).not.toContain('1,100');
      expect(html).not.toContain('150.00');
      expect(html).not.toContain('Karim');
      expect(html).not.toContain('FR-1');
    });

    it('puts the charges in a second table only when asked', () => {
      expect(priceEmailRatesHtml([rate], { includeLocalCharges: false })).not.toContain('Seal Charge');
      const html = priceEmailRatesHtml([rate], { includeLocalCharges: true });
      expect(html).toContain('Origin and destination charges');
      expect(html).toContain('Seal Charge, 20STD');
      expect(html).toContain('13.00 USD');
    });

    it('shows an LCL minimum under the price', () => {
      const lcl = {
        ...rate,
        mode: 'SEA_LCL',
        lines: [{ ...rate.lines[0]!, tierLabel: '0-5', sellPrice: '45', minCharge: '90' }],
      } as FreightRateDto;
      const html = priceEmailRatesHtml([lcl], { includeLocalCharges: false });
      expect(html).toContain('>0-5 CBM</th>');
      expect(html).toContain('prices in USD per CBM');
      expect(html).toContain('45.00<br>');
      expect(html).toContain('min 90.00');
    });

    it('escapes what people typed, and keeps their paragraphs', () => {
      const html = priceEmailHtml({
        customerName: '<b>Acme & Co</b>',
        message: 'Line one\nline two\n\nSecond <paragraph>',
        rates: [rate],
        includeLocalCharges: false,
        signOff: 'Rahim\nPricing',
      });
      expect(html).toContain('Dear &lt;b&gt;Acme &amp; Co&lt;/b&gt;,');
      expect(html).not.toContain('<b>Acme');
      expect(html).toContain('>Line one<br>line two</p>');
      expect(html).toContain('>Second &lt;paragraph&gt;</p>');
      expect(html).toContain('Kind regards,<br>Rahim<br>Pricing');
    });
  });
});

describe('the subject and the letter', () => {
  it('names the lane, or counts the list end', () => {
    expect(defaultPriceEmailSubject('SEA_FCL', ['Chattogram'], ['Hamburg'])).toBe(
      'Sea FCL rates: Chattogram to Hamburg',
    );
    expect(defaultPriceEmailSubject('AIR', ['Dhaka'], ['Frankfurt', 'Paris', 'Milan'])).toBe(
      'Air rates: Dhaka to 3 destinations',
    );
  });

  it('greets the customer by name and signs off under the sender', () => {
    expect(
      composePriceEmailBody({
        customerName: 'Dhaka Apparels',
        message: 'Please find our rates.',
        rates: '• 20STD: USD 1,250.00',
        signOff: 'Rahim Uddin\nPricing Manager',
      }),
    ).toBe(
      'Dear Dhaka Apparels,\n\nPlease find our rates.\n\n• 20STD: USD 1,250.00\n\nKind regards,\nRahim Uddin\nPricing Manager',
    );
  });
});
