import { PERMISSIONS } from '@ff/shared';
import { describe, expect, it } from 'vitest';

import { signAccessToken, verifyAccessToken } from './jwt';
import { decodePermissions, encodePermissions } from './permission-token';

/**
 * The permission set inside the access token (permission-token.ts). The case
 * that made it necessary: a role holding every key in the registry.
 */
describe('the permission bitmap', () => {
  const every = PERMISSIONS.map((p) => p.key);

  it('round-trips any set, in registry order, and drops unknown keys', () => {
    const some = [every[5]!, every[0]!, 'NOT.A.REAL.KEY', every[every.length - 1]!];
    expect(decodePermissions(encodePermissions(some))).toEqual([every[0], every[5], every[every.length - 1]]);
    expect(decodePermissions(encodePermissions([]))).toEqual([]);
    expect(decodePermissions(encodePermissions(every))).toEqual(every);
  });

  it('keeps a token holding every permission small enough for any proxy', async () => {
    const token = await signAccessToken({ sub: '1', tenantId: '1', isSuperadmin: false, permissions: every, tokenVersion: 0 });
    // nginx's default refuses a single header line over 8 KB.
    expect(token.length).toBeLessThan(1024);
    expect((await verifyAccessToken(token)).permissions).toEqual(every);
  });
});
