/**
 * Attempt limiting for the portal's public endpoints (§2.6).
 *
 * The staff login sits behind the client's own network and has never needed
 * this. A portal is a different exposure: the address is guessable, the
 * usernames are agent names, and nobody is watching the logs at 3am.
 *
 * Two counters, because they stop different attacks. **Per IP** stops one host
 * working through many accounts. **Per account** stops a botnet working through
 * one account from many hosts — the case a per-IP limit alone misses entirely.
 *
 * Deliberately in-process and deliberately not a dependency. It holds for a
 * single API container, which is what the VPS deployment runs; behind more than
 * one, each process would keep its own tally and the effective limit multiplies
 * by the process count. That is a real limitation and the moment to move it
 * into Postgres or Redis is the moment a second API container appears — noted
 * here rather than discovered later.
 */

interface Attempts {
  count: number;
  /** When the window began, or when the lockout ends. */
  until: number;
}

export interface LimitPolicy {
  /** Failures allowed inside the window before the door closes. */
  max: number;
  windowMs: number;
  lockoutMs: number;
}

/** Enough to survive a fat-fingered password, not enough to survive a list. */
export const PORTAL_LOGIN_LIMIT: LimitPolicy = {
  max: 8,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
};

/** Resets are cheap to ask for and expensive to receive — mail costs money. */
export const PORTAL_RESET_LIMIT: LimitPolicy = {
  max: 5,
  windowMs: 60 * 60 * 1000,
  lockoutMs: 60 * 60 * 1000,
};

const buckets = new Map<string, Attempts>();

/** Keeps the map from growing without bound on a long-running process. */
function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [key, value] of buckets) {
    if (value.until <= now) buckets.delete(key);
  }
}

/**
 * True when this key is currently locked out.
 *
 * Checked BEFORE the password is verified, so a locked-out caller costs an
 * argon2 hash of nothing.
 */
export function isLockedOut(key: string): boolean {
  const entry = buckets.get(key);
  if (entry === undefined) return false;
  if (entry.count < 0 && entry.until > Date.now()) return true;
  return false;
}

/** Records a failure, and locks the key once the window's allowance is spent. */
export function recordFailure(key: string, policy: LimitPolicy): void {
  const now = Date.now();
  sweep(now);
  const entry = buckets.get(key);

  if (entry === undefined || entry.until <= now) {
    buckets.set(key, { count: 1, until: now + policy.windowMs });
    return;
  }
  // Already locked; leave the existing expiry alone rather than extending it
  // forever, which would let an attacker keep a real user locked out for good.
  if (entry.count < 0) return;

  entry.count += 1;
  if (entry.count >= policy.max) {
    buckets.set(key, { count: -1, until: now + policy.lockoutMs });
  }
}

/** Clears the tally. Called on a successful sign-in, and nowhere else. */
export function clearFailures(key: string): void {
  buckets.delete(key);
}

/** Test seam. Never called by the application. */
export function resetAllLimits(): void {
  buckets.clear();
}
