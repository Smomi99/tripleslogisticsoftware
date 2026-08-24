import { Prisma } from '../generated/prisma/client';
import { HttpError } from './http-error';
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
    select: { id: true; tenantId?: true };
  }) => Promise<{ id: bigint; tenantId: bigint | null } | null>;
  create: (args: {
    data: {
      tenantId: bigint;
      code: string;
      name: string;
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

/** Shared rows are never editable — the same refusal on all five screens. */
export function assertEditable(tenantId: bigint | null, noun: string): void {
  if (tenantId === null) {
    throw HttpError.forbidden(
      `This is a shared ${noun}. You can deactivate it for your workspace, but not edit it.`,
    );
  }
}
