import { type EmailCheckDto, emailSyntaxProblem } from '@ff/shared';

import { type DomainVerdict, domainVerdict } from './email-domain';

/** Lookups in flight at once. DNS is cheap; a resolver flooded is not. */
const CONCURRENCY = 8;
/** After this, domains not yet looked up are passed as unchecked rather than waited on. */
const BUDGET_MS = 15_000;

/**
 * Checks a batch of addresses: shape first, then whether the domain takes mail.
 *
 * Each domain is looked up once however many addresses share it — a customer
 * list is mostly a handful of company domains and gmail.com.
 */
export async function checkAddresses(
  addresses: string[],
  verdictOf: (domain: string) => Promise<DomainVerdict> = domainVerdict,
): Promise<EmailCheckDto[]> {
  const unique = [...new Set(addresses.map((a) => a.trim()))];
  const syntax = new Map(unique.map((a) => [a, emailSyntaxProblem(a)]));

  const domains = [
    ...new Set(
      unique
        .filter((a) => syntax.get(a) === null)
        .map((a) => a.slice(a.lastIndexOf('@') + 1).toLowerCase()),
    ),
  ];

  const verdicts = new Map<string, DomainVerdict>();
  const deadline = Date.now() + BUDGET_MS;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < domains.length) {
      const domain = domains[next]!;
      next += 1;
      verdicts.set(domain, Date.now() > deadline ? 'unknown' : await verdictOf(domain));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, domains.length) }, worker));

  const byAddress = new Map<string, EmailCheckDto>();
  for (const address of unique) {
    const problem = syntax.get(address) ?? null;
    if (problem !== null) {
      byAddress.set(address, { address, valid: false, reason: problem });
      continue;
    }
    const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
    const verdict = verdicts.get(domain) ?? 'unknown';
    byAddress.set(
      address,
      verdict === 'no-such-domain'
        ? { address, valid: false, reason: `${domain} does not exist — check the spelling after the @.` }
        : verdict === 'no-mail'
          ? { address, valid: false, reason: `${domain} does not receive email.` }
          : { address, valid: true, reason: null },
    );
  }

  // In the order asked, duplicates included, so a caller can zip the two lists.
  return addresses.map((a) => byAddress.get(a.trim())!);
}
