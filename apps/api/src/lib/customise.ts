import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Customising a shared master row (CR-003).
 *
 * §7A rule 7 is not negotiable: ports, currencies and carriers with a NULL
 * tenant_id belong to every workspace on the server, and one company must never
 * be able to edit or delete what another company reads. But that left a real
 * gap — a workspace could not correct a name it disagrees with, and could not
 * set a currency conversion at all, which is a per-company commercial figure
 * the shared row cannot possibly carry.
 *
 * So: copy, don't mutate. The workspace gets its own row, the shared row is
 * hidden for that workspace alone (tenant_master_override), and the original is
 * never touched.
 *
 * The part that stops this producing a second "Chittagong" is `repointReferences`
 * below. Without it the copy would start life used by nothing while every
 * existing inquiry still pointed at the shared row — which is exactly the
 * duplicate problem customising is meant to end.
 */

/** `"a b"` — identifiers come from pg_catalog, but quote them anyway. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface ForeignKeyEdge {
  child_table: string;
  child_column: string;
  has_tenant_id: boolean;
}

/**
 * Moves this workspace's references from the shared row to its own copy.
 *
 * Driven from Postgres' catalogue, for the same reason the delete check is: a
 * hand-kept list is wrong the day a table is added, and here the failure would
 * be a record silently left pointing at a row that has vanished from the UI.
 *
 * RLS scopes every UPDATE to the current workspace, so other companies keep
 * pointing at the shared row — which is the whole point.
 *
 * Except that RLS also lets a workspace SEE shared rows, and a shared row can
 * point at another shared row: the seeded FCL rate tiers name the seeded
 * container sizes. Updating one of those would repoint a tier every workspace
 * reads onto one workspace's private copy — and RLS refuses the write anyway,
 * so customising 20STD died on the first seeded tier. Only the workspace's own
 * rows move; the shared ones are the caller's to deal with.
 *
 * Only the leg of each foreign key that points at `id` is followed, the same
 * pairing references.ts uses. A composite key's tenant_id leg would otherwise
 * become `SET tenant_id = <copy id>`.
 */
export async function repointReferences(
  db: TenantDb,
  table: string,
  fromId: bigint,
  toId: bigint,
): Promise<number> {
  const edges = await db.$queryRaw<ForeignKeyEdge[]>`
    SELECT child.relname                AS child_table,
           att.attname                  AS child_column,
           EXISTS (
             SELECT 1 FROM pg_attribute t
             WHERE t.attrelid = con.conrelid
               AND t.attname = 'tenant_id'
               AND NOT t.attisdropped
           ) AS has_tenant_id
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

  let moved = 0;
  for (const edge of edges) {
    moved += await db.$executeRawUnsafe(
      `UPDATE ${quoteIdent(edge.child_table)} SET ${quoteIdent(edge.child_column)} = $2 ` +
        `WHERE ${quoteIdent(edge.child_column)} = $1` +
        (edge.has_tenant_id ? ' AND tenant_id IS NOT NULL' : ''),
      fromId,
      toId,
    );
  }
  return moved;
}

/**
 * Refuses anything that is not a shared row this workspace can still customise.
 *
 * Customising an already-customised row would make a second copy and orphan the
 * first, so the override is checked before any of it starts.
 */
export async function assertCustomisable(
  db: TenantDb,
  table: string,
  id: bigint,
  row: { tenantId?: bigint | null; name: string } | null,
  notFoundMessage: string,
): Promise<void> {
  if (row === null) throw HttpError.notFound(notFoundMessage);

  if (row.tenantId !== null && row.tenantId !== undefined) {
    throw new HttpError(
      409,
      'ALREADY_OWN',
      `${row.name} already belongs to this workspace — edit it directly.`,
    );
  }

  const existing = await db.tenantMasterOverride.findFirst({
    where: { tableName: table, recordId: id, replacedBy: { not: null } },
    select: { replacedBy: true },
  });
  if (existing !== null) {
    throw new HttpError(
      409,
      'ALREADY_CUSTOMISED',
      `${row.name} has already been customised for this workspace.`,
    );
  }
}

/**
 * Hides the shared row for this workspace and records what replaced it.
 *
 * Upserts, because the workspace may simply have deactivated the row earlier —
 * that override row already exists and now gains a target.
 */
export async function recordReplacement(
  db: TenantDb,
  tenantId: bigint,
  table: string,
  sharedId: bigint,
  copyId: bigint,
  userId: bigint,
): Promise<void> {
  const existing = await db.tenantMasterOverride.findFirst({
    where: { tableName: table, recordId: sharedId },
    select: { id: true },
  });

  if (existing === null) {
    await db.tenantMasterOverride.create({
      data: {
        tenantId,
        tableName: table,
        recordId: sharedId,
        isActive: false,
        replacedBy: copyId,
        createdBy: userId,
        updatedBy: userId,
      },
    });
    return;
  }

  await db.tenantMasterOverride.update({
    where: { id: existing.id },
    data: { isActive: false, replacedBy: copyId, updatedBy: userId },
  });
}
