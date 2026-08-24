import type { AgentQuoteChangeDto } from '@ff/shared';

import { isoCurrency } from './currency-label';
import type { TenantDb } from './tenant-client';

/**
 * What an agent changed on a quote, and when.
 *
 * Read from `audit_log` rather than from a bespoke history table. The Phase 0
 * trigger already captures both sides of every write to `agent_quote`, so a
 * second record would be a second thing to keep correct — and the first thing
 * to drift.
 *
 * Only the fields a forwarder would care about are surfaced, and only when they
 * actually moved. A diff that lists `updated_at` and `updated_by` on every row
 * buries the one line that matters: the price went from 1450 to 1399.
 *
 * Since a quotation became a breakdown, that one line comes from a second
 * place. An amendment does not edit the old figures — it retires the whole set
 * of offers and writes a new one, because "option 2 now routes via Colombo and
 * its third charge is gone" has no sensible field-by-field merge. So the
 * price movement is recovered by comparing one generation of offers with the
 * one that replaced it, which is also the more honest answer to "what changed":
 * what they offered then, against what they offer now.
 */

/** Row shape as the trigger writes it: snake_case, straight from to_jsonb. */
type Snapshot = Record<string, unknown> | null;

/** The fields worth showing, and what to call them on screen. */
const TRACKED: { column: string; label: string }[] = [
  { column: 'amount', label: 'Price' },
  { column: 'currency_id', label: 'Currency' },
  { column: 'valid_until', label: 'Valid until' },
  { column: 'transit_days', label: 'Transit days' },
  { column: 'remarks', label: 'Remarks' },
  { column: 'status', label: 'Status' },
];

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    // Dates arrive as full timestamps; the day is what was entered.
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value;
  }
  return String(value);
}

export interface QuoteHistoryOptions {
  /** Renders currency_id as USD rather than as a row id. */
  currencyNames: Map<string, string>;
}

function describe(
  column: string,
  value: unknown,
  options: QuoteHistoryOptions,
): string | null {
  const raw = text(value);
  if (column !== 'currency_id' || raw === null) return raw;
  const name = options.currencyNames.get(raw);
  return name === undefined ? raw : isoCurrency(name);
}

/**
 * The trail for one quote, newest first.
 *
 * Deliberately takes the tenant-scoped client: audit_log carries RLS like every
 * other table, so a quote from another workspace yields an empty history rather
 * than someone else's.
 */
export async function quoteHistory(
  db: TenantDb,
  quoteIds: bigint[],
  options: QuoteHistoryOptions,
): Promise<Map<string, AgentQuoteChangeDto[]>> {
  const byQuote = new Map<string, AgentQuoteChangeDto[]>();
  if (quoteIds.length === 0) return byQuote;

  const generations = await offerGenerations(db, quoteIds, options);

  const rows = await db.auditLog.findMany({
    where: {
      tableName: 'agent_quote',
      recordId: { in: quoteIds },
      action: { in: ['CREATE', 'UPDATE', 'DELETE'] },
    },
    select: { recordId: true, action: true, createdAt: true, oldValues: true, newValues: true },
    orderBy: { id: 'desc' },
  });

  for (const row of rows) {
    if (row.recordId === null) continue;
    const before = row.oldValues as Snapshot;
    const after = row.newValues as Snapshot;

    const changes: AgentQuoteChangeDto['changes'] = [];
    for (const { column, label } of TRACKED) {
      const from = before === null ? null : describe(column, before[column], options);
      const to = after === null ? null : describe(column, after[column], options);
      // On a CREATE there is no before, so every set field is "new" — listing
      // them all would restate the quote rather than describe a change.
      if (before === null) continue;
      if (from === to) continue;
      changes.push({ field: label, from, to });
    }

    // An update that moved nothing tracked — updated_by alone, say — is noise.
    if (before !== null && changes.length === 0) continue;

    const key = row.recordId.toString();
    byQuote.set(key, [
      ...(byQuote.get(key) ?? []),
      {
        at: row.createdAt.toISOString(),
        // Only the status moved, so this is the forwarder answering rather than
        // the agent repricing — an agent cannot set status at all.
        kind:
          before === null
            ? 'SUBMITTED'
            : changes.length === 1 && changes[0]?.field === 'Status'
              ? 'DECIDED'
              : 'AMENDED',
        changes,
      },
    ]);
  }

  // Fold in the reprices, then put the whole trail back in newest-first order —
  // the two sources are each ordered, but not against each other.
  for (const [key, entries] of generations) {
    byQuote.set(key, [...(byQuote.get(key) ?? []), ...entries]);
  }
  for (const [key, entries] of byQuote) {
    byQuote.set(
      key,
      [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
    );
  }

  return byQuote;
}

/** A set of offers that stood together, and the moment it was replaced. */
interface Generation {
  /** null on the set that is still live. */
  retiredAt: Date | null;
  /** Total per currency across every line in the set. */
  totals: Map<string, string>;
  optionCount: number;
}

/**
 * The reprices, recovered by comparing consecutive generations of offers.
 *
 * Generations are identified by `deleted_at`: every option retired in the same
 * amendment carries the same instant, and the live set carries null. Sorting
 * those instants puts the sets in the order they stood.
 */
async function offerGenerations(
  db: TenantDb,
  quoteIds: bigint[],
  opts: QuoteHistoryOptions,
): Promise<Map<string, AgentQuoteChangeDto[]>> {
  const result = new Map<string, AgentQuoteChangeDto[]>();

  const rows = await db.agentQuoteOption.findMany({
    where: { quoteId: { in: quoteIds } },
    select: {
      quoteId: true,
      deletedAt: true,
      lines: { select: { currencyId: true, totalAmount: true, deletedAt: true } },
    },
  });
  if (rows.length === 0) return result;

  // quote -> generation key -> generation
  const byQuote = new Map<string, Map<string, Generation>>();
  for (const row of rows) {
    const quoteKey = row.quoteId.toString();
    const genKey = row.deletedAt === null ? 'live' : row.deletedAt.toISOString();
    const gens = byQuote.get(quoteKey) ?? new Map<string, Generation>();
    const gen = gens.get(genKey) ?? {
      retiredAt: row.deletedAt,
      totals: new Map<string, string>(),
      optionCount: 0,
    };
    gen.optionCount += 1;
    for (const line of row.lines) {
      // A line retired with its option belongs to that generation; one retired
      // on its own does not belong to any set that ever stood.
      const currency = line.currencyId.toString();
      const running = gen.totals.get(currency);
      const amount = line.totalAmount?.toString() ?? '0';
      gen.totals.set(
        currency,
        running === undefined ? amount : (Number(running) + Number(amount)).toString(),
      );
    }
    gens.set(genKey, gen);
    byQuote.set(quoteKey, gens);
  }

  for (const [quoteKey, gens] of byQuote) {
    const ordered = [...gens.values()].sort((a, b) => {
      if (a.retiredAt === null) return 1;
      if (b.retiredAt === null) return -1;
      return a.retiredAt.getTime() - b.retiredAt.getTime();
    });

    const entries: AgentQuoteChangeDto[] = [];
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const previous = ordered[i]!;
      const next = ordered[i + 1]!;
      const changes: AgentQuoteChangeDto['changes'] = [];

      const currencies = new Set([...previous.totals.keys(), ...next.totals.keys()]);
      for (const currency of currencies) {
        const from = previous.totals.get(currency) ?? null;
        const to = next.totals.get(currency) ?? null;
        if (from === to) continue;
        const name = opts.currencyNames.get(currency);
        const label = name === undefined ? 'Total' : `Total (${isoCurrency(name)})`;
        changes.push({ field: label, from, to });
      }
      if (previous.optionCount !== next.optionCount) {
        changes.push({
          field: 'Options offered',
          from: String(previous.optionCount),
          to: String(next.optionCount),
        });
      }
      if (changes.length === 0) {
        changes.push({ field: 'Charges', from: 'reworked', to: 'reworked' });
      }

      entries.push({
        // The moment the older set was retired IS the moment it was replaced.
        at: (previous.retiredAt ?? new Date()).toISOString(),
        kind: 'AMENDED',
        changes,
      });
    }
    if (entries.length > 0) result.set(quoteKey, entries);
  }

  return result;
}
