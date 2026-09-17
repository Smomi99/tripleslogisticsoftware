import { clpDetailsSchema, clpFinaliseSchema } from '@ff/shared';
import { describe, expect, it } from 'vitest';

/**
 * CLP Phase G — what the finalisation panel will and will not accept
 * (MODULE_CLP.md §4.3, §5.2).
 *
 * The schema is the boundary. §4.3 gives FINAL no edit path, so a plan that
 * reaches it with a wrong container number is re-keyed from scratch — which
 * makes the validation here worth more than usual.
 */

const valid = {
  containerNo: 'CSQU3054383',
  sealNo: 'SL-99213',
  loadDatetime: '2026-09-14T08:30:00.000Z',
  supervisorEmployeeId: null,
  tallyManName: 'Rafiq',
};

describe('finalising', () => {
  it('accepts a complete panel', () => {
    const parsed = clpFinaliseSchema.parse(valid);
    expect(parsed.containerNo).toBe('CSQU3054383');
    expect(parsed.sealNo).toBe('SL-99213');
  });

  it('tidies the container number, so one box has one spelling', () => {
    // What gets typed off a bill of lading, and what gets stored.
    const parsed = clpFinaliseSchema.parse({ ...valid, containerNo: 'csqu 305438-3' });
    expect(parsed.containerNo).toBe('CSQU3054383');
  });

  it('refuses a bad check digit, naming the digit it wanted', () => {
    const result = clpFinaliseSchema.safeParse({ ...valid, containerNo: 'CSQU3054387' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/Check digit should be 3, not 7/);
  });

  it('will not finalise without a container number', () => {
    const result = clpFinaliseSchema.safeParse({ ...valid, containerNo: '' });
    expect(result.success).toBe(false);
  });

  it('will not finalise without a seal number', () => {
    // §4.3 lists it. An unsealed container is not a loaded one.
    const result = clpFinaliseSchema.safeParse({ ...valid, sealNo: '   ' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/Enter the seal number/);
  });

  it('will not finalise without a load date and time', () => {
    const result = clpFinaliseSchema.safeParse({ ...valid, loadDatetime: '' });
    expect(result.success).toBe(false);
  });

  it('refuses a load time that is not a time', () => {
    const result = clpFinaliseSchema.safeParse({ ...valid, loadDatetime: 'yesterday' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/date and time picker/);
  });

  it('treats the supervisor and tally man as optional', () => {
    // §5.2: tally man is free text and supervisor is a lookup. Neither is
    // listed among §4.3's preconditions, so neither blocks finalising.
    const parsed = clpFinaliseSchema.parse({
      containerNo: valid.containerNo,
      sealNo: valid.sealNo,
      loadDatetime: valid.loadDatetime,
    });
    expect(parsed.tallyManName ?? null).toBeNull();
  });
});

describe('saving a draft', () => {
  it('accepts an empty panel, because the details arrive at different times', () => {
    // The container number is known at the gate and the seal only once the
    // box is closed. Requiring them to be saved together would mean keeping
    // them on paper until the end.
    const result = clpDetailsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('still checks a container number that IS given', () => {
    // Saving a wrong number quietly would leave it to be discovered at the
    // confirm step, after the planner has stopped looking at the box.
    const result = clpDetailsSchema.safeParse({ containerNo: 'CSQU3054387' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/Check digit should be 3/);
  });

  it('accepts a partly filled panel', () => {
    const parsed = clpDetailsSchema.parse({ sealNo: 'SL-1', tallyManName: 'Rafiq' });
    expect(parsed.sealNo).toBe('SL-1');
    expect(parsed.containerNo ?? null).toBeNull();
  });
});
