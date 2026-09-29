import { Resolver } from 'node:dns/promises';

/**
 * Whether a domain can receive mail — the half of an address check that
 * syntax cannot answer. "name@gmial.com" is perfectly formed and goes nowhere.
 *
 * Its own module so the tests can replace it: a test suite that depends on the
 * public DNS is a test suite that fails on a train.
 */
export type DomainVerdict = 'accepts-mail' | 'no-such-domain' | 'no-mail' | 'unknown';

/** Short: a screen is waiting on this, and a slow answer is treated as no answer. */
const resolver = new Resolver({ timeout: 3000, tries: 1 });

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * MX first, then the A record — RFC 5321 §5.1: a domain with no MX still takes
 * mail at its own address. A null MX (RFC 7505, a single "." exchange) is the
 * domain saying outright that it takes none.
 *
 * Anything that is not a clear answer — a timeout, a refused resolver, a
 * server failure — is `unknown`, never a rejection. An address must not turn
 * red because our network had a bad minute.
 */
export async function domainVerdict(domain: string): Promise<DomainVerdict> {
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length === 1 && (mx[0]!.exchange === '' || mx[0]!.exchange === '.')) return 'no-mail';
    if (mx.length > 0) return 'accepts-mail';
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOTFOUND') return 'no-such-domain';
    if (code !== 'ENODATA') return 'unknown';
  }

  try {
    const hosts = await resolver.resolve4(domain);
    return hosts.length > 0 ? 'accepts-mail' : 'no-mail';
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOTFOUND') return 'no-such-domain';
    if (code === 'ENODATA') return 'no-mail';
    return 'unknown';
  }
}
