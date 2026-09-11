import { describe, expect, it } from 'vitest';

import {
  businessPortAccepts,
  businessPortShape,
  businessPortSummary,
} from '@ff/shared';

/**
 * The Business Port rule (client, 2026-09-12).
 *
 * A commodity category fans in or it fans out, never both: many loading ports
 * into one discharge port, or one loading port out to many. The whole rule is
 * these three functions — the route and the form both defer to them, so this
 * is where it is worth pinning down.
 */

const pair = (polId: string, podId: string) => ({ polId, podId });

describe('what a set of lanes allows next', () => {
  it('takes anything when nothing is on file', () => {
    expect(businessPortAccepts([], pair('1', '2'))).toBe(true);
  });

  it('lets a second loading port join the same discharge port', () => {
    expect(businessPortAccepts([pair('1', '2')], pair('3', '2'))).toBe(true);
  });

  it('lets a second discharge port join the same loading port', () => {
    expect(businessPortAccepts([pair('1', '2')], pair('1', '3'))).toBe(true);
  });

  it('refuses a new discharge port once several loading ports feed one', () => {
    const fansIn = [pair('1', '9'), pair('2', '9')];
    expect(businessPortAccepts(fansIn, pair('3', '9'))).toBe(true);
    expect(businessPortAccepts(fansIn, pair('1', '8'))).toBe(false);
    expect(businessPortAccepts(fansIn, pair('4', '8'))).toBe(false);
  });

  it('refuses a new loading port once one feeds several discharge ports', () => {
    const fansOut = [pair('9', '1'), pair('9', '2')];
    expect(businessPortAccepts(fansOut, pair('9', '3'))).toBe(true);
    expect(businessPortAccepts(fansOut, pair('8', '1'))).toBe(false);
    expect(businessPortAccepts(fansOut, pair('8', '4'))).toBe(false);
  });

  it('accepts a pair already on file — the duplicate is the index\u2019s job, not the rule\u2019s', () => {
    expect(businessPortAccepts([pair('1', '2')], pair('1', '2'))).toBe(true);
  });
});

describe('which side the screen should fix', () => {
  it('fixes neither while the set is empty', () => {
    expect(businessPortShape([])).toEqual({
      shape: 'EMPTY',
      fixedPolId: null,
      fixedPodId: null,
    });
  });

  it('fixes neither on a single pair, which still fans both ways', () => {
    expect(businessPortShape([pair('1', '2')])).toEqual({
      shape: 'OPEN',
      fixedPolId: '1',
      fixedPodId: '2',
    });
  });

  it('fixes the discharge port once the set fans in', () => {
    expect(businessPortShape([pair('1', '9'), pair('2', '9')])).toEqual({
      shape: 'FANS_IN',
      fixedPolId: null,
      fixedPodId: '9',
    });
  });

  it('fixes the loading port once the set fans out', () => {
    expect(businessPortShape([pair('9', '1'), pair('9', '2')])).toEqual({
      shape: 'FANS_OUT',
      fixedPolId: '9',
      fixedPodId: null,
    });
  });

  it('fixes nothing on a set that predates the rule, rather than picking a side', () => {
    // Unreachable through the API. Reachable by reading a row written before
    // the rule existed, and a screen that locked the wrong side would be worse
    // than one that locked neither.
    expect(businessPortShape([pair('1', '2'), pair('3', '4')]).shape).toBe('EMPTY');
  });
});

describe('how the lane reads on the category list', () => {
  const lane = (polCode: string, polName: string, podCode: string, podName: string) => ({
    polCode,
    polName,
    podCode,
    podName,
  });

  it('says nothing when there is nothing', () => {
    expect(businessPortSummary([])).toBeNull();
  });

  it('names both ports of a single lane', () => {
    expect(businessPortSummary([lane('CGP', 'Chattogram', 'JEA', 'Jebel Ali')])).toBe(
      'CGP → JEA',
    );
  });

  it('collapses the repeated side rather than printing it twice', () => {
    expect(
      businessPortSummary([
        lane('CGP', 'Chattogram', 'JEA', 'Jebel Ali'),
        lane('NGB', 'Ningbo', 'JEA', 'Jebel Ali'),
      ]),
    ).toBe('CGP, NGB → JEA');
  });

  it('falls back to the port name where a port has no code', () => {
    expect(
      businessPortSummary([
        { polCode: null, polName: 'Chattogram', podCode: 'JEA', podName: 'Jebel Ali' },
      ]),
    ).toBe('Chattogram → JEA');
  });
});
