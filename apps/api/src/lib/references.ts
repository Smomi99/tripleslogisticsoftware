import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Which rows point at a master record, so the UI can offer Delete on a row
 * that was never used and refuse it on one that was (CR-002).
 *
 * §4 rule 3 forbids hard deletes, and that rule is not in question here: a
 * "delete" in this product sets `deleted_at`, so every foreign key stays
 * intact. What this file answers is the separate question of whether the row
 * is safe to hide — a deactivated carrier still has to render on last year's
 * BLs, but a carrier typed by mistake and never used has nothing to preserve.
 *
 * The dependency list is read from Postgres' own catalogue rather than kept by
 * hand. A hand-maintained list is wrong the day someone adds a table and
 * forgets this file, and the failure mode is silent: a row disappears out from
 * under records that still reference it.
 */

export interface BlockingReference {
  table: string;
  column: string;
  count: number;
}

interface ForeignKeyEdge {
  child_table: string;
  child_column: string;
  has_deleted_at: boolean;
}

/**
 * Plural labels for the tables an operator may be told about.
 *
 * "used by 3 freight_rate" is a database talking to itself. Anything missing
 * falls back to a prettified table name, which is wrong-ish but never wrong
 * enough to mislead.
 */
const TABLE_LABEL: Record<string, string> = {
  agent_expert_area: 'agent expert areas',
  agent_network_member: 'agent network memberships',
  agent_pic: 'agent contacts',
  agent_port_coverage: 'agent port coverages',
  carrier_pic: 'carrier contacts',
  carrier_port_pair: 'carrier port pairs',
  carrier_service_port: 'carrier service ports',
  commodity_item: 'commodity items',
  customer_pic: 'customer contacts',
  employee_cv: 'employee CVs',
  employee_salary: 'salary records',
  freight_rate: 'purchase rates',
  freight_rate_charge: 'rate charges',
  freight_rate_tier: 'rate tiers',
  inquiry: 'inquiries',
  inquiry_followup: 'inquiry follow-ups',
  inquiry_rate: 'inquiry rates',
  inquiry_volume: 'inquiry volumes',
  quotation: 'quotations',
  sales_lead: 'sales leads',
  user: 'users',
  vendor_pic: 'vendor contacts',
  vessel: 'vessels',
};

function labelFor(table: string, count: number): string {
  const plural = TABLE_LABEL[table] ?? table.replace(/_/g, ' ') + 's';
  if (count !== 1) return `${count} ${plural}`;
  // Crude singularisation, good enough for the handful of words above.
  const singular = plural.endsWith('ies')
    ? `${plural.slice(0, -3)}y`
    : plural.endsWith('s')
      ? plural.slice(0, -1)
      : plural;
  return `1 ${singular}`;
}

/** `"a b"` — identifiers come from pg_catalog, but quote them anyway. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Every live row that references `table.id = id`, in one round trip.
 *
 * Runs inside the caller's tenant transaction, so RLS scopes the counts: a row
 * another workspace happens to reference is invisible here, which is correct —
 * it cannot be, since §4 rule 10's triggers forbid a cross-tenant reference in
 * the first place.
 */
export async function findBlockingReferences(
  db: TenantDb,
  table: string,
  id: bigint,
): Promise<BlockingReference[]> {
  const edges = await db.$queryRaw<ForeignKeyEdge[]>`
    SELECT con.conrelid::regclass::text AS child_table,
           att.attname                  AS child_column,
           EXISTS (
             SELECT 1 FROM pg_attribute d
             WHERE d.attrelid = con.conrelid
               AND d.attname = 'deleted_at'
               AND NOT d.attisdropped
           ) AS has_deleted_at
    FROM pg_constraint con
    JOIN pg_class ref      ON ref.oid = con.confrelid
    JOIN pg_namespace rn   ON rn.oid = ref.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY k(attnum, ord) ON TRUE
    JOIN pg_attribute att  ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    WHERE con.contype = 'f'
      AND rn.nspname = 'public'
      AND ref.relname = ${table}
    ORDER BY child_table, child_column
  `;

  if (edges.length === 0) return [];

  const selects = edges.map(
    (edge) =>
      `SELECT ${escapeLiteral(edge.child_table)} AS table_name, ` +
      `${escapeLiteral(edge.child_column)} AS column_name, ` +
      `count(*)::int AS count FROM ${quoteIdent(edge.child_table)} ` +
      `WHERE ${quoteIdent(edge.child_column)} = $1` +
      (edge.has_deleted_at ? ' AND deleted_at IS NULL' : ''),
  );

  const rows = await db.$queryRawUnsafe<
    { table_name: string; column_name: string; count: number }[]
  >(selects.join(' UNION ALL '), id);

  return rows
    .filter((row) => row.count > 0)
    .map((row) => ({ table: row.table_name, column: row.column_name, count: row.count }));
}

/** Postgres string literal, for the constant columns in the UNION above. */
function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Refuses the delete when anything still points at the row, and says what.
 *
 * The message names the obstacle because a disabled button with no explanation
 * is the thing operators file tickets about. Deactivate is always available and
 * is what they actually want in this case.
 */
export async function assertDeletable(
  db: TenantDb,
  table: string,
  id: bigint,
  subject: string,
): Promise<void> {
  const blockers = await findBlockingReferences(db, table, id);
  if (blockers.length === 0) return;

  // Largest first: the most convincing reason leads.
  const described = [...blockers]
    .sort((a, b) => b.count - a.count)
    .map((blocker) => labelFor(blocker.table, blocker.count));

  const list =
    described.length === 1
      ? described[0]
      : `${described.slice(0, -1).join(', ')} and ${described[described.length - 1]}`;

  throw new HttpError(
    409,
    'REFERENCED',
    `${subject} is used by ${list}. Deactivate it instead of deleting it.`,
    { blockedBy: described },
  );
}
