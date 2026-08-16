import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (CLAUDE.md §2).
 *
 * argon2id via a prebuilt Rust binding — no node-gyp toolchain, which matters
 * because the team develops on Windows.
 *
 * Parameters follow the OWASP argon2id recommendation: 19 MiB of memory, two
 * iterations, one lane.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, OPTIONS);
  } catch {
    // A malformed hash must read as "wrong password", never as an error the
    // caller might mistake for success.
    return false;
  }
}
