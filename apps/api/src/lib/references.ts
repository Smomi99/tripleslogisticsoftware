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


/**
 * Children that belong to a row and have no meaning without it.
 *
 * These must NOT block a delete, and getting this wrong makes the feature
 * useless: an agent's own expert areas, a carrier's own service port and a
 * customer's own contact are not "usage", they are parts of the record. Before
 * this list existed, almost every real row was undeletable — the very rows a
 * typo produces are the ones you fill in a contact for and then notice the
 * spelling.
 *
 * `join` marks a pure M:N link with no `deleted_at` of its own. Those are hard
 * deleted, which §4 rule 3 already allows for join tables — the link carries no
 * history, and the migration granting ff_app DELETE on them says as much.
 */
interface OwnedChild {
  table: string;
  column: string;
  join: boolean;
}

const OWNED_CHILDREN: Record<string, readonly OwnedChild[]> = {
  carrier: [
    { table: 'carrier_pic', column: 'carrier_id', join: false },
    { table: 'carrier_service_port', column: 'carrier_id', join: false },
    { table: 'carrier_port_pair', column: 'carrier_id', join: false },
  ],
  vendor: [{ table: 'vendor_pic', column: 'vendor_id', join: false }],
  customer: [{ table: 'customer_pic', column: 'customer_id', join: false }],
  agent: [
    { table: 'agent_pic', column: 'agent_id', join: false },
    { table: 'agent_expert_area', column: 'agent_id', join: true },
    { table: 'agent_port_coverage', column: 'agent_id', join: true },
    { table: 'agent_network_member', column: 'agent_id', join: true },
  ],
  employee: [
    { table: 'employee_cv', column: 'employee_id', join: false },
    { table: 'employee_salary', column: 'employee_id', join: false },
  ],
  industry_sector: [{ table: 'commodity_item', column: 'industry_sector_id', join: false }],
};

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

/*
 * §4 rule 10 makes almost every foreign key composite:
 * `(tenant_id, customer_id) REFERENCES customer(tenant_id, id)`. Walking
 * `conkey` alone yields two edges from one constraint, and the tenant_id one
 * is nonsense here — it would count `WHERE tenant_id = <the row's id>`, which
 * silently reports every row in the workspace the day a record's id happens to
 * equal the tenant's. Tenant 1 plus customer 1 is what a fresh install makes,
 * so this was a bogus "in use" refusal waiting for the first delete on a new
 * server. Pairing `conkey` with `confkey` and keeping only the leg that points
 * at `id` leaves exactly the one edge that means anything.
 */

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
  inquiry_party_contact: 'rate requests',
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

/**
 * `"a b"` — identifiers come from pg_catalog, but quote them anyway.
 *
 * Fed from `pg_class.relname`, which is the bare name. `conrelid::regclass`
 * looks equivalent and is not: it quotes a reserved word for you, and `user`
 * is a table here — so it returned `"user"`, this added a second pair, and
 * deleting a customer with a login attached died on a syntax error instead of
 * refusing politely.
 */
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
    SELECT child.relname                 AS child_table,
           att.attname                  AS child_column,
           EXISTS (
             SELECT 1 FROM pg_attribute d
             WHERE d.attrelid = con.conrelid
               AND d.attname = 'deleted_at'
               AND NOT d.attisdropped
           ) AS has_deleted_at
    FROM pg_constraint con
    JOIN pg_class child    ON child.oid = con.conrelid
    JOIN pg_class ref      ON ref.oid = con.confrelid
    JOIN pg_namespace rn   ON rn.oid = ref.relnamespace
    JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY k(attnum, refattnum, ord) ON TRUE
    JOIN pg_attribute att  ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    JOIN pg_attribute refatt ON refatt.attrelid = con.confrelid AND refatt.attnum = k.refattnum
    WHERE con.contype = 'f'
      AND rn.nspname = 'public'
      AND ref.relname = ${table}
      AND refatt.attname = 'id'
    ORDER BY child_table, child_column
  `;

  const owned = OWNED_CHILDREN[table] ?? [];
  const external = edges.filter(
    (edge) =>
      !owned.some((o) => o.table === edge.child_table && o.column === edge.child_column),
  );
  if (external.length === 0) return [];

  const selects = external.map(
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


/**
 * A child that belongs to the row can still be used by something else.
 *
 * commodity_item is the live case: an industry sector owns its items, but an
 * inquiry names one. Deleting the sector would take the item with it and leave
 * the inquiry pointing at nothing, so the grandchild has to be checked too.
 */
async function assertOwnedChildrenUnused(
  db: TenantDb,
  table: string,
  id: bigint,
  subject: string,
): Promise<void> {
  for (const child of OWNED_CHILDREN[table] ?? []) {
    if (child.join) continue; // nothing references a pure link row

    const ids = await db.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT id FROM ${quoteIdent(child.table)} WHERE ${quoteIdent(child.column)} = $1 AND deleted_at IS NULL`,
      id,
    );

    for (const row of ids) {
      const blockers = await findBlockingReferences(db, child.table, row.id);
      if (blockers.length > 0) {
        const described = blockers.map((b) => labelFor(b.table, b.count)).join(', ');
        throw new HttpError(
          409,
          'REFERENCED',
          `${subject} cannot be deleted: one of its ${TABLE_LABEL[child.table] ?? child.table} ` +
            `is used by ${described}. Deactivate it instead.`,
          { blockedBy: [described] },
        );
      }
    }
  }
}

/**
 * Removes the rows that belong to this one, so a deleted parent leaves nothing
 * dangling behind it on the child screens.
 *
 * Soft for anything carrying `deleted_at`; hard for the pure join tables, which
 * have no history to keep — the same reasoning agent.route.ts already applies
 * when it rewrites an agent's expert areas.
 */
export async function deleteOwnedChildren(
  db: TenantDb,
  table: string,
  id: bigint,
  userId: bigint,
): Promise<void> {
  for (const child of OWNED_CHILDREN[table] ?? []) {
    if (child.join) {
      await db.$executeRawUnsafe(
        `DELETE FROM ${quoteIdent(child.table)} WHERE ${quoteIdent(child.column)} = $1`,
        id,
      );
    } else {
      await db.$executeRawUnsafe(
        `UPDATE ${quoteIdent(child.table)} SET deleted_at = now(), is_active = false, updated_by = $2 ` +
          `WHERE ${quoteIdent(child.column)} = $1 AND deleted_at IS NULL`,
        id,
        userId,
      );
    }
  }
}

/**
 * The checks every Delete route makes, in the order they matter.
 *
 * Shared because the alternative is fifteen copies that drift: the day someone
 * adds a screen and forgets the system-row check, a shared port disappears for
 * every workspace on the server.
 *
 * `row` is what the caller's own tenant-scoped query returned, so "not found"
 * already covers another workspace's row — it was never visible.
 */
export async function assertRowDeletable(
  db: TenantDb,
  table: string,
  id: bigint,
  row: { tenantId?: bigint | null; name: string } | null,
  notFoundMessage: string,
): Promise<void> {
  if (row === null) throw HttpError.notFound(notFoundMessage);

  // §7A rule 7: a shared row belongs to every workspace. A tenant may hide it
  // for itself, never remove it for everyone.
  if (row.tenantId === null) {
    throw new HttpError(
      409,
      'SYSTEM_ROW',
      `${row.name} is shared with every workspace, so it is not yours to delete. ` +
        'Deactivate it to hide it here.',
    );
  }

  await assertDeletable(db, table, id, row.name);
  await assertOwnedChildrenUnused(db, table, id, row.name);
}
