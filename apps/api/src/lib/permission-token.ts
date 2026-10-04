import { createHash } from 'node:crypto';

import { PERMISSIONS } from '@ff/shared';

/**
 * The permission set as the access token carries it: one bit per registry
 * key, in registry order, base64url-encoded.
 *
 * The token used to carry the keys themselves. With several hundred keys a
 * role granted everything produced an Authorization header past Node's 16 KB
 * limit — every request refused with 431 — and far past the 8 KB a default
 * nginx accepts for one header line. As bits the whole registry is about
 * sixty characters, however large it grows.
 *
 * A bitmap means nothing without the order it was written in, so the token
 * also carries a fingerprint of that order. A token minted under another
 * registry (a deploy that added a permission) is refused as expired; the web
 * app refreshes on 401, and the refresh resolves the permissions afresh. The
 * cost is one extra round trip per signed-in user per deploy.
 */

const KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);
const INDEX = new Map(KEYS.map((key, i) => [key, i]));

/** Short, and enough: it only has to tell two registries apart. */
export const PERMISSION_REGISTRY_FINGERPRINT = createHash('sha256').update(KEYS.join(',')).digest('base64url').slice(0, 16);

/**
 * Keys not in the registry are dropped. A grant can outlive its key — the
 * seed prunes no permission rows — and no route can require a key that is not
 * registered (requirePermission refuses one at startup), so there is nothing
 * such a key could open.
 */
export function encodePermissions(keys: Iterable<string>): string {
  const bits = new Uint8Array(Math.ceil(KEYS.length / 8));
  for (const key of keys) {
    const i = INDEX.get(key);
    if (i === undefined) continue;
    bits[i >> 3]! |= 1 << (i & 7);
  }
  return Buffer.from(bits).toString('base64url');
}

export function decodePermissions(encoded: string): string[] {
  const bits = Buffer.from(encoded, 'base64url');
  const keys: string[] = [];
  for (let i = 0; i < KEYS.length; i += 1) {
    if (((bits[i >> 3] ?? 0) & (1 << (i & 7))) !== 0) keys.push(KEYS[i]!);
  }
  return keys;
}
