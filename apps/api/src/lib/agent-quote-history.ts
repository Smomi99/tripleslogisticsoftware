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
        kind: before === null ? 'SUBMITTED' : 'AMENDED',
        changes,
      },
    ]);
  }

  return byQuote;
}
