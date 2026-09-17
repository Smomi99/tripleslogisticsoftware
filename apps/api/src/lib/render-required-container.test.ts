import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client';
import { renderRequiredContainer, renderVolumes } from './render-volumes';

/**
 * "Required Container" downstream of a quotation.
 *
 * Reported 2026-09-14: quotation QTN-2026-000011 priced 1x20STD + 1x40STD,
 * and every screen after it — quotation list, booking, cargo receipt, load
 * plan — showed "20std". The inquiry behind it held a single LCL row with the
 * free-text note "20std" and no quantity, and that was what was being read.
 * The second container was invisible all the way to the CFS.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** The inquiry as it actually was: LCL, 1 CBM, a note, no size and no count. */
const VAGUE_INQUIRY = [
  {
    quantity: null,
    cbm: D('1.000'),
    weightKg: D('1000.000'),
    containerSizeNote: '20std',
    containerSize: null,
  },
];

describe('once a quotation exists, its containers are the requirement', () => {
  it('shows both containers that were quoted', () => {
    // The reported case.
    const lines = [
      { containerSizeName: "20' Standard", quantity: D('1.000') },
      { containerSizeName: "40' Standard", quantity: D('1.000') },
    ];
    expect(renderRequiredContainer(lines, VAGUE_INQUIRY)).toBe(
      "20' Standard(1) + 40' Standard(1)",
    );
  });

  it('does not fall back to the inquiry once there is something to show', () => {
    const lines = [{ containerSizeName: "40' High Cube", quantity: D('2.000') }];
    const out = renderRequiredContainer(lines, VAGUE_INQUIRY);
    expect(out).toBe("40' High Cube(2)");
    expect(out).not.toMatch(/20std/);
  });

  it('counts a size once however many charges are levied on it', () => {
    /*
      Charges are per container. A 20STD carrying ocean freight, THC and a
      seal fee is three lines and one box; adding the quantities would report
      three containers to the CFS.
    */
    const lines = [
      { containerSizeName: "20' Standard", quantity: D('1.000') },
      { containerSizeName: "20' Standard", quantity: D('1.000') },
      { containerSizeName: "20' Standard", quantity: D('1.000') },
    ];
    expect(renderRequiredContainer(lines, [])).toBe("20' Standard(1)");
  });

  it('takes the largest quantity when charges cover different numbers', () => {
    // Two boxes of ocean freight, one of them needing a special seal.
    const lines = [
      { containerSizeName: "20' Standard", quantity: D('2.000') },
      { containerSizeName: "20' Standard", quantity: D('1.000') },
    ];
    expect(renderRequiredContainer(lines, [])).toBe("20' Standard(2)");
  });

  it('keeps the order the quotation was built in', () => {
    const lines = [
      { containerSizeName: "40' High Cube", quantity: D('1.000') },
      { containerSizeName: "20' Standard", quantity: D('3.000') },
    ];
    expect(renderRequiredContainer(lines, [])).toBe("40' High Cube(1) + 20' Standard(3)");
  });

  it('ignores charges that are not against a container', () => {
    // Documentation fees and the like carry no container size.
    const lines = [
      { containerSizeName: null, quantity: D('1.000') },
      { containerSizeName: '', quantity: D('1.000') },
      { containerSizeName: "20' Standard", quantity: D('1.000') },
    ];
    expect(renderRequiredContainer(lines, [])).toBe("20' Standard(1)");
  });

  it('reads a missing quantity as one container, not as none', () => {
    const lines = [{ containerSizeName: "20' Standard", quantity: null }];
    expect(renderRequiredContainer(lines, [])).toBe("20' Standard(1)");
  });

  it('rounds a fractional quantity rather than printing 1.5 boxes', () => {
    const lines = [{ containerSizeName: "20' Standard", quantity: D('1.6') }];
    expect(renderRequiredContainer(lines, [])).toBe("20' Standard(2)");
  });
});

describe('with nothing quoted yet', () => {
  it('falls back to what the customer asked for', () => {
    // The Live Inquiry list, and any quotation with no container charges.
    expect(renderRequiredContainer([], VAGUE_INQUIRY)).toBe('20std');
    expect(renderRequiredContainer([], VAGUE_INQUIRY)).toBe(renderVolumes(VAGUE_INQUIRY));
  });

  it('falls back for an air quotation, which has no containers at all', () => {
    const lines = [{ containerSizeName: null, quantity: D('2.000') }];
    const volumes = [
      {
        quantity: null,
        cbm: null,
        weightKg: D('200.000'),
        containerSizeNote: null,
        containerSize: null,
      },
    ];
    expect(renderRequiredContainer(lines, volumes)).toBe('200 Kg');
  });

  it('says so plainly when there is nothing on either side', () => {
    expect(renderRequiredContainer([], [])).toBe('—');
  });

  it('does not count a container charged as zero', () => {
    const lines = [{ containerSizeName: "20' Standard", quantity: D('0') }];
    expect(renderRequiredContainer(lines, VAGUE_INQUIRY)).toBe('20std');
  });
});

describe('numbers on a volume line', () => {
  const kg = (v: string) =>
    renderVolumes([
      { quantity: null, cbm: null, weightKg: D(v), containerSizeNote: null, containerSize: null },
    ]);

  it('does not eat the zeros of a round number', () => {
    /*
      The original stripped trailing zeros without checking for a decimal
      point, so "200.000" became "2" and "1000.000" became "1". An inquiry for
      a tonne of cargo read as 1 Kg on the list screens.
    */
    expect(kg('200.000')).toBe('200 Kg');
    expect(kg('1000.000')).toBe('1000 Kg');
    expect(kg('10.000')).toBe('10 Kg');
  });

  it('still drops the zeros that are only padding', () => {
    expect(kg('1.500')).toBe('1.5 Kg');
    expect(kg('0.750')).toBe('0.75 Kg');
    expect(kg('1.000')).toBe('1 Kg');
  });
});
