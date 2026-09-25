import { Prisma } from '../generated/prisma/client';
import { assertCustomisable, recordReplacement, repointReferences } from './customise';
import { HttpError } from './http-error';
import { assertDeletable, assertRowDeletable } from './references';
import type { TenantDb } from './tenant-client';

/**
 * Shared machinery for system-capable lookups (CLAUDE.md §7A rule 7).
 *
 * Port, Currency and Carrier each grew their own copy of this: a raw-SQL list
 * that joins tenant_master_override so a shared row's effective status reflects
 * the workspace's own switch, and a toggle that writes the override rather than
 * the row. The §3.1 lookups are five more of exactly the same shape, so it lives
 * here once instead of seven times.
 *
 * Raw SQL is unavoidable rather than preferred: the effective status is
 * `is_active AND COALESCE(override.is_active, true)`, which cannot be a Prisma
 * `where` without breaking the count and therefore the pager. It runs inside
 * withTenant, so RLS constrains the rows regardless of what is written here.
 */

/** Table names are never taken from caller input — only from this map. */
const LOOKUP_TABLES = {
  goodsType: 'goods_type',
  containerSize: 'container_size',
  rateTier: 'rate_tier',
  tos: 'tos',
  mode: 'mode',
  inquirySource: 'inquiry_source',
} as const;

export type LookupTable = keyof typeof LOOKUP_TABLES;

/** The database table name, which is what tenant_master_override records. */
export function lookupTableName(table: LookupTable): string {
  return LOOKUP_TABLES[table];
}

export interface LookupListOptions {
  search?: string | undefined;
  isActive?: boolean | undefined;
  page: number;
  limit: number;
  /** Whitelisted ORDER BY fragment, e.g. `l.sort_order ASC, l.code ASC`. */
  orderBy: string;
  /** Extra selected columns, e.g. `l.teu_factor, l.sort_order`. */
  extraColumns?: string;
  /** Extra joins, already parameterised by the caller. */
  extraJoin?: Prisma.Sql;
  /** Extra filters, already parameterised by the caller. */
  extraConditions?: Prisma.Sql[];
  /** Columns the search box covers, beyond code and the display column. */
  searchColumns?: string[];
  /**
   * The display column. rate_tier calls it `label` rather than `name`, so this
   * cannot be assumed — selecting a column that does not exist fails at runtime,
   * not at compile time.
   */
  nameColumn?: string;
}

export interface LookupRow {
  id: bigint;
  code: string;
  name: string;
  effective_is_active: boolean;
  is_system: boolean;
  [key: string]: unknown;
}

export async function listSystemLookup(
  db: TenantDb,
  tenantId: bigint,
  table: LookupTable,
  options: LookupListOptions,
): Promise<{ rows: LookupRow[]; total: number }> {
  const tableName = LOOKUP_TABLES[table];

  const conditions: Prisma.Sql[] = [
    Prisma.sql`l.deleted_at IS NULL`,
    Prisma.sql`(l.tenant_id IS NULL OR l.tenant_id = ${tenantId})`,
    // A shared row this workspace has replaced with its own copy, or deleted
    // for itself, is gone from its list. Merely deactivated stays, so it can
    // be switched back on.
    Prisma.sql`o.replaced_by IS NULL`,
    Prisma.sql`o.removed_at IS NULL`,
    ...(options.extraConditions ?? []),
  ];

  if (options.search !== undefined) {
    const needle = `%${options.search}%`;
    const columns = ['l.code', options.nameColumn ?? 'l.name', ...(options.searchColumns ?? [])];
    conditions.push(
      Prisma.join(
        columns.map((c) => Prisma.sql`${Prisma.raw(c)} ILIKE ${needle}`),
        ' OR ',
        '(',
        ')',
      ),
    );
  }
  if (options.isActive !== undefined) {
    conditions.push(
      Prisma.sql`(l.is_active AND COALESCE(o.is_active, true)) = ${options.isActive}`,
    );
  }

  const where = Prisma.join(conditions, ' AND ');
  const joins = Prisma.sql`
    LEFT JOIN tenant_master_override o
      ON o.table_name = ${tableName} AND o.record_id = l.id AND o.tenant_id = ${tenantId}
    ${options.extraJoin ?? Prisma.empty}
  `;

  const totalRows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM ${Prisma.raw(`"${tableName}"`)} l ${joins}
    WHERE ${where}
  `;
  const total = Number(totalRows[0]?.count ?? 0n);

  const extra = options.extraColumns === undefined ? Prisma.empty : Prisma.raw(`, ${options.extraColumns}`);

  const nameSelect = Prisma.raw(`${options.nameColumn ?? 'l.name'} AS name`);

  const rows = await db.$queryRaw<LookupRow[]>`
    SELECT l.id, l.code, ${nameSelect},
           (l.is_active AND COALESCE(o.is_active, true)) AS effective_is_active,
           (l.tenant_id IS NULL) AS is_system
           ${extra}
    FROM ${Prisma.raw(`"${tableName}"`)} l ${joins}
    WHERE ${where}
    ORDER BY ${Prisma.raw(options.orderBy)}, l.id ASC
    LIMIT ${options.limit} OFFSET ${(options.page - 1) * options.limit}
  `;

  return { rows, total };
}

/** Every system-capable lookup model exposes the same subset Prisma-side. */
interface ToggleableModel {
  findFirst: (args: {
    where: { id: bigint; deletedAt: null };
    select: { id: true; tenantId: true; isActive: true };
  }) => Promise<{ id: bigint; tenantId: bigint | null; isActive: boolean } | null>;
  update: (args: {
    where: { id: bigint };
    data: { isActive: boolean; updatedBy: bigint };
    select: { isActive: true };
  }) => Promise<{ isActive: boolean }>;
}

/**
 * Own row → flip is_active. Shared row → write tenant_master_override, leaving
 * the shared row untouched for every other workspace (§7A rule 7).
 */
export async function toggleSystemLookup(
  db: TenantDb,
  tenantId: bigint,
  userId: bigint,
  table: LookupTable,
  model: ToggleableModel,
  id: bigint,
  notFoundMessage: string,
): Promise<boolean> {
  const existing = await model.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, tenantId: true, isActive: true },
  });
  if (existing === null) throw HttpError.notFound(notFoundMessage);

  if (existing.tenantId !== null) {
    const updated = await model.update({
      where: { id },
      data: { isActive: !existing.isActive, updatedBy: userId },
      select: { isActive: true },
    });
    return updated.isActive;
  }

  const tableName = LOOKUP_TABLES[table];
  const override = await db.tenantMasterOverride.findFirst({
    where: { tableName, recordId: id },
    select: { id: true, isActive: true },
  });

  if (override === null) {
    await db.tenantMasterOverride.create({
      data: {
        tenantId,
        tableName,
        recordId: id,
        isActive: false,
        createdBy: userId,
        updatedBy: userId,
      },
    });
    return false;
  }

  const updated = await db.tenantMasterOverride.update({
    where: { id: override.id },
    data: { isActive: !override.isActive, updatedBy: userId },
    select: { isActive: true },
  });
  return updated.isActive && existing.isActive;
}

/**
 * The subset of a Prisma delegate the simple lookups need.
 *
 * TOS and Inquiry Source are identical in shape, but a union of two Prisma
 * delegates is not callable — their overloads do not unify. Narrowing to the
 * three calls actually used lets one implementation serve both.
 */
export interface SimpleLookupModel {
  findFirst: (args: {
    where: { id?: bigint; code?: string; deletedAt: null; NOT?: { id: bigint } };
    select: { id: true; tenantId?: true; code?: true; isActive?: true };
  }) => Promise<{ id: bigint; tenantId: bigint | null; code: string; isActive: boolean } | null>;
  create: (args: {
    data: {
      tenantId: bigint;
      code: string;
      name: string;
      /** Only TOS has one; a customised copy keeps the shared row's place. */
      sortOrder?: number;
      isActive?: boolean;
      createdBy: bigint;
      updatedBy: bigint;
    };
    select: { id: true; code: true; name: true; isActive: true };
  }) => Promise<{ id: bigint; code: string; name: string; isActive: boolean }>;
  update: (args: {
    where: { id: bigint };
    data: { code: string; name: string; updatedBy: bigint };
    select: { id: true; code: true; name: true; isActive: true };
  }) => Promise<{ id: bigint; code: string; name: string; isActive: boolean }>;
}

/**
 * PATCH never touches a shared row — the same refusal on every screen.
 *
 * The screens send a shared row's edit to `/customise` instead, which leaves
 * the shared row alone and gives the workspace its own copy. This stays as the
 * guard for anything that calls PATCH directly.
 */
export function assertEditable(tenantId: bigint | null, noun: string): void {
  if (tenantId === null) {
    throw HttpError.forbidden(
      `This is a shared ${noun}. Saving changes to it makes your workspace's own copy — ` +
        'use Edit on the list rather than changing the shared row.',
    );
  }
}

// ===========================================================================
// Edit and Delete on a shared row — asked for by the client on 2026-09-25
// ===========================================================================

interface OverrideState {
  id: bigint;
  isActive: boolean;
  replacedBy: bigint | null;
  removedAt: Date | null;
}

async function overrideFor(db: TenantDb, tableName: string, id: bigint): Promise<OverrideState | null> {
  return db.tenantMasterOverride.findFirst({
    where: { tableName, recordId: id },
    select: { id: true, isActive: true, replacedBy: true, removedAt: true },
  });
}

/**
 * A shared row this workspace has already deleted is gone from its list, so
 * reaching it again is a stale screen or a hand-made request. Either way it
 * reads as not found rather than as a second copy or a second removal.
 */
function assertNotRemoved(override: OverrideState | null, notFoundMessage: string): void {
  if (override?.removedAt != null) throw HttpError.notFound(notFoundMessage);
}

/**
 * Edit on a shared row: the workspace's own copy, with the changes.
 *
 * §7A rule 7 stands — the shared row is never written. This is CR-003's
 * customise in one step rather than two: the copy is created with the values
 * the operator just typed, this workspace's records move onto it, and the
 * shared row is hidden here alone. Every other workspace sees the original.
 *
 * The copy keeps the row's status for this workspace. Editing a row somebody
 * had deactivated is not a request to switch it back on.
 *
 * `createCopy` does the table-specific insert and returns the new id;
 * `afterRepoint` is for the one table whose shared children must follow it
 * (container size → rate tier).
 */
export async function replaceSharedLookup(args: {
  db: TenantDb;
  tenantId: bigint;
  userId: bigint;
  table: LookupTable;
  id: bigint;
  shared: { tenantId: bigint | null; code: string; isActive: boolean } | null;
  notFoundMessage: string;
  createCopy: (isActive: boolean) => Promise<bigint>;
  afterRepoint?: (copyId: bigint) => Promise<void>;
}): Promise<bigint> {
  const { db, tenantId, userId, table, id, shared, notFoundMessage } = args;
  const tableName = LOOKUP_TABLES[table];

  await assertCustomisable(
    db,
    tableName,
    id,
    shared === null ? null : { tenantId: shared.tenantId, name: shared.code },
    notFoundMessage,
  );
  if (shared === null) throw HttpError.notFound(notFoundMessage);

  const override = await overrideFor(db, tableName, id);
  assertNotRemoved(override, notFoundMessage);

  const copyId = await args.createCopy(shared.isActive && (override?.isActive ?? true));
  await repointReferences(db, tableName, id, copyId);
  await args.afterRepoint?.(copyId);
  await recordReplacement(db, tenantId, tableName, id, copyId, userId);
  return copyId;
}

/** The subset of a Prisma delegate a delete needs. */
export interface DeletableLookupModel {
  findFirst: (args: {
    where: { id: bigint; deletedAt: null };
    select: { id: true; tenantId: true; code: true };
  }) => Promise<{ id: bigint; tenantId: bigint | null; code: string } | null>;
  update: (args: {
    where: { id: bigint };
    data: { deletedAt: Date; isActive: boolean; code: string; updatedBy: bigint };
    select: { id: true };
  }) => Promise<{ id: bigint }>;
}

/**
 * The code a deleted row gives up.
 *
 * These codes are typed by people — FOB, CY/CY, 20STD — and the unique key on
 * (tenant_id, code) counts soft-deleted rows too. Left alone, deleting a typo'd
 * "FOB" would make FOB impossible to add again, ever. The delete is refused
 * while anything references the row, so nothing can be reading the old code;
 * and `~` is outside what the code field accepts, so no typed code can collide.
 * The audit log keeps what it was.
 */
function retiredCode(code: string, id: bigint): string {
  const suffix = `~${id.toString()}`;
  return `${code.slice(0, 32 - suffix.length)}${suffix}`;
}

/**
 * Delete, for either kind of row.
 *
 * The workspace's own row: CR-002's soft delete, refused while anything uses it.
 *
 * A shared row: removed from THIS workspace only (§7A rule 7 — it is never
 * deleted for anyone else). Refused while this workspace's own records use it,
 * for the same reason an own row's delete is: they would be left naming a row
 * the workspace can no longer see. Shared rows that point at it do not count —
 * every workspace has those, and they say nothing about this one.
 *
 * `onSharedRemoval` runs after the checks and before the removal is written,
 * inside the same transaction, for the container size → rate tier cascade.
 */
export async function deleteLookupRow(args: {
  db: TenantDb;
  tenantId: bigint;
  userId: bigint;
  table: LookupTable;
  model: DeletableLookupModel;
  id: bigint;
  notFoundMessage: string;
  onSharedRemoval?: () => Promise<void>;
}): Promise<void> {
  const { db, tenantId, userId, table, model, id, notFoundMessage } = args;
  const tableName = LOOKUP_TABLES[table];

  const row = await model.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, tenantId: true, code: true },
  });
  if (row === null) throw HttpError.notFound(notFoundMessage);

  if (row.tenantId !== null) {
    await assertRowDeletable(db, tableName, id, { tenantId: row.tenantId, name: row.code }, notFoundMessage);
    await model.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
        code: retiredCode(row.code, id),
        updatedBy: userId,
      },
      select: { id: true },
    });
    return;
  }

  const override = await overrideFor(db, tableName, id);
  assertNotRemoved(override, notFoundMessage);
  if (override?.replacedBy != null) throw HttpError.notFound(notFoundMessage);

  await assertDeletable(db, tableName, id, row.code, { ownRowsOnly: true });
  await args.onSharedRemoval?.();
  await removeSharedRow(db, tenantId, tableName, id, userId, override);
}

/**
 * Takes a shared row off this workspace's list for good.
 *
 * Upserts, because the workspace may have deactivated it earlier — that
 * override already exists and now gains a removal date.
 */
export async function removeSharedRow(
  db: TenantDb,
  tenantId: bigint,
  tableName: string,
  id: bigint,
  userId: bigint,
  override?: OverrideState | null,
): Promise<void> {
  const existing = override === undefined ? await overrideFor(db, tableName, id) : override;
  if (existing === null) {
    await db.tenantMasterOverride.create({
      data: {
        tenantId,
        tableName,
        recordId: id,
        isActive: false,
        removedAt: new Date(),
        createdBy: userId,
        updatedBy: userId,
      },
    });
    return;
  }
  await db.tenantMasterOverride.update({
    where: { id: existing.id },
    data: { isActive: false, removedAt: new Date(), updatedBy: userId },
  });
}

/** For the container size cascade: the override state of one shared row. */
export async function sharedRowOverride(
  db: TenantDb,
  table: LookupTable,
  id: bigint,
): Promise<OverrideState | null> {
  return overrideFor(db, LOOKUP_TABLES[table], id);
}
