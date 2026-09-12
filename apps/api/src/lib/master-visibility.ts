import type { TenantDb } from './tenant-client';

/**
 * Which shared master rows this workspace has switched off.
 *
 * §7A rule 7 gives ports, currencies, carriers and the lookup tables a nullable
 * tenant_id: NULL means the row is shared with every workspace on the server.
 * A workspace may not edit such a row, so deactivating one cannot write to
 * `is_active` — it writes a `tenant_master_override` instead.
 *
 * The consequence caught a real bug. Every dropdown filtered on `is_active`
 * alone, so a workspace that deactivated eleven shared seaports still saw all
 * eleven offered as POL and POD on the Sea Freight screen. Their own ports
 * disappeared correctly; the shared ones did not, because nothing had changed
 * on the row itself.
 *
 * This is deliberately NOT applied inside the tenant client extension, tempting
 * as that is. The Settings list screens have to keep showing a deactivated row —
 * otherwise there is no way to switch it back on. "Hidden from pickers" and
 * "hidden from everything" are different things, and only the first is wanted.
 *
 * A replaced row (CR-003) is covered by the same query: customising writes
 * is_active = false alongside replaced_by.
 */

export type InactiveMasters = ReadonlyMap<string, bigint[]>;

interface OverrideRow {
  table_name: string;
  record_id: bigint;
}

/**
 * One query, covering every master table at once.
 *
 * The override table holds one row per shared record a workspace has touched,
 * so this is a handful of rows in practice — cheaper than asking per dropdown,
 * and it keeps the callers synchronous.
 */
export async function inactiveMasters(db: TenantDb): Promise<InactiveMasters> {
  const rows = await db.$queryRaw<OverrideRow[]>`
    SELECT table_name, record_id
    FROM tenant_master_override
    WHERE is_active = false
  `;

  const byTable = new Map<string, bigint[]>();
  for (const row of rows) {
    const list = byTable.get(row.table_name);
    if (list === undefined) byTable.set(row.table_name, [row.record_id]);
    else list.push(row.record_id);
  }
  return byTable;
}

/**
 * A Prisma `where` fragment excluding the rows this workspace switched off.
 *
 * Spread it next to `isActive: true`, which it completes rather than replaces:
 * `is_active` still governs tenant-owned rows, and this governs shared ones.
 *
 * Returns an empty object when nothing is hidden, so the common case adds
 * nothing to the query at all.
 */
export function excludeInactive(
  inactive: InactiveMasters,
  table: string,
): { id?: { notIn: bigint[] } } {
  const ids = inactive.get(table);
  if (ids === undefined || ids.length === 0) return {};
  return { id: { notIn: ids } };
}

/**
 * A candidate row competing for a code.
 *
 * Identity and ownership only. Callers that have a display name select it too
 * and use it in their message — RateTier calls its label something else, and
 * requiring a `name` here broke on it.
 */
export interface CodeHolder {
  id: bigint;
  tenantId: bigint | null;
}

/**
 * Which row, if any, stops this workspace taking a code.
 *
 * Both kinds of clash look identical in a plain query, and they are not the
 * same thing:
 *
 *   Its own row always blocks. The partial unique index says so, and letting
 *   the insert through would trade a clear message for a database error.
 *
 *   A shared row blocks only while the workspace still uses it. Once it has
 *   been switched off — or replaced by a customised copy — it is gone from
 *   every picker, and holding its code hostage is indefensible: the product
 *   refuses to let you delete a shared port, tells you to deactivate it
 *   instead, and then refuses the replacement you deactivated it for.
 *
 * Returns the blocking row so the caller can say which it was, because
 * "already in use" on a row you cannot see is not an answer.
 */
export function codeHeldBy<T extends CodeHolder>(
  rows: T[],
  inactive: InactiveMasters,
  table: string,
): { row: T; shared: boolean } | null {
  const own = rows.find((r) => r.tenantId !== null);
  if (own !== undefined) return { row: own, shared: false };

  const hidden = new Set((inactive.get(table) ?? []).map((id) => id.toString()));
  const stillInUse = rows.find((r) => !hidden.has(r.id.toString()));
  return stillInUse === undefined ? null : { row: stillInUse, shared: true };
}
