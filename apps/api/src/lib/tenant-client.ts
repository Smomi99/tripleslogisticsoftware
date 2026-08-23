import { HttpError } from './http-error';
import { prisma } from './prisma';
import { currentActorId, requireTenantId, runWithTenantContext, tierOf } from './tenancy';

/**
 * The tenant-scoped database client (CLAUDE.md §7A rule 3).
 *
 * Feature code never imports `prisma` directly. It calls `withTenant(...)` and
 * receives a client that has already injected `tenant_id` into every where,
 * create and update, and has set `app.tenant_id` for the RLS policies.
 *
 * Two independent layers, in this order:
 *   1. This extension scopes the query before it is sent.
 *   2. RLS refuses anything that slipped past, because the API connects as
 *      ff_app, which owns no tables (see the RLS migration).
 *
 * Neither layer is trusted to be sufficient on its own.
 *
 * Known ergonomic limit: Prisma extensions can rewrite query arguments but not
 * reshape input *types*, so `create` still asks for `tenantId` at compile time
 * even though this code supplies it. Whatever the caller passes is overwritten
 * with the acting tenant — proven by the "overrides a caller-supplied tenantId"
 * test — so the wrong value is harmless, never trusted.
 */

type UnknownRecord = Record<string, unknown>;

/** Reads may see system rows; writes may not create them. */
function readFilter(model: string, tenantId: bigint): UnknownRecord {
  return tierOf(model) === 'system-capable'
    ? { OR: [{ tenantId: null }, { tenantId }] }
    : { tenantId };
}

function andWhere(existing: unknown, filter: UnknownRecord): UnknownRecord {
  if (existing === undefined || existing === null) return filter;
  return { AND: [existing, filter] };
}

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** `where` is a plain filter here, so an AND wrapper is valid. */
const MANY_WRITE_OPERATIONS = new Set(['updateMany', 'updateManyAndReturn']);

/**
 * `where` must carry a unique field at the top level, so the tenant is merged
 * in beside it rather than wrapped in an AND — Prisma rejects a unique where
 * whose only top-level key is AND.
 */
const UNIQUE_WRITE_OPERATIONS = new Set(['update', 'upsert']);

/** Merges the tenant into a unique where, overriding anything the caller sent. */
function mergeWhere(existing: unknown, tenantId: bigint): UnknownRecord {
  const base = typeof existing === 'object' && existing !== null ? (existing as UnknownRecord) : {};
  return { ...base, tenantId };
}

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** §4 rule 3: never hard-delete. Also revoked at the database privilege level. */
const FORBIDDEN_OPERATIONS = new Set(['delete', 'deleteMany']);

function scopedClient() {
  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const tier = tierOf(model);

          // An unknown model means the schema grew and tenancy.ts was not
          // updated. Refuse rather than guess at its tier.
          if (tier === undefined) {
            throw new HttpError(
              500,
              'TENANCY_TIER_UNKNOWN',
              `Model ${model} has no tenancy tier. Add it to apps/api/src/lib/tenancy.ts.`,
            );
          }

          if (tier === 'platform') {
            return query(args);
          }

          if (FORBIDDEN_OPERATIONS.has(operation)) {
            throw new HttpError(
              400,
              'HARD_DELETE_FORBIDDEN',
              `${operation} on ${model} is not allowed. Set deleted_at instead (CLAUDE.md §4 rule 3).`,
            );
          }

          const tenantId = requireTenantId();
          const next = (args ?? {}) as UnknownRecord;

          if (READ_OPERATIONS.has(operation)) {
            next['where'] = andWhere(next['where'], readFilter(model, tenantId));
            return query(next);
          }

          // findUnique's where accepts only unique fields, so an AND cannot be
          // grafted on. Run it, then discard a row belonging to someone else.
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            const row: unknown = await query(next);
            if (row === null || row === undefined) return row;
            const owner = (row as UnknownRecord)['tenantId'];
            if (owner === null && tier === 'system-capable') return row;
            if (typeof owner === 'bigint' && owner === tenantId) return row;
            if (operation === 'findUniqueOrThrow') {
              throw HttpError.notFound(`${model} not found.`);
            }
            return null;
          }

          if (CREATE_OPERATIONS.has(operation)) {
            const data = next['data'];
            if (Array.isArray(data)) {
              next['data'] = data.map((row) => ({ ...(row as UnknownRecord), tenantId }));
            } else if (data !== undefined && data !== null) {
              next['data'] = { ...(data as UnknownRecord), tenantId };
            }
            return query(next);
          }

          // Writes are always scoped to the tenant's own rows, even on a
          // system-capable table — a tenant must not edit a system row.
          if (MANY_WRITE_OPERATIONS.has(operation)) {
            next['where'] = andWhere(next['where'], { tenantId });
            return query(next);
          }

          if (UNIQUE_WRITE_OPERATIONS.has(operation)) {
            next['where'] = mergeWhere(next['where'], tenantId);
            if (operation === 'upsert') {
              const create = next['create'];
              if (create !== undefined && create !== null) {
                next['create'] = { ...(create as UnknownRecord), tenantId };
              }
            }
            return query(next);
          }

          // Anything unrecognised (a future Prisma operation) is refused rather
          // than passed through unscoped.
          throw new HttpError(
            500,
            'TENANCY_OPERATION_UNKNOWN',
            `Operation ${operation} on ${model} has no tenancy rule.`,
          );
        },
      },
    },
  });
}

const client = scopedClient();

type ScopedClient = typeof client;

/** What feature code receives — a transaction client, already scoped. */
export type TenantDb = Omit<
  ScopedClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * Runs `fn` inside a transaction bound to one tenant.
 *
 * The transaction matters: `set_config(..., true)` is transaction-local, so
 * `app.tenant_id` cannot leak to the next request that borrows this pooled
 * connection.
 */
export async function withTenant<T>(
  tenantId: bigint,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId.toString()}, true)`;
    // The audit triggers read app.user_id to attribute the change. It comes
    // from the authenticated session and from nowhere a client can reach —
    // §7A rule 1 applied to the trail as well as to the tenant. Empty on an
    // unauthenticated path, which the trigger records as SYSTEM.
    const actorId = currentActorId();
    await tx.$executeRaw`SELECT set_config('app.user_id', ${actorId?.toString() ?? ''}, true)`;
    // Cleared, not merely left alone. Every RLS policy written before the agent
    // portal now reads `AND app_current_agent() IS NULL`, so "staff sessions
    // never set it" is the assumption the entire backward-compatibility
    // argument rests on. Setting it explicitly makes that a fact about this
    // function rather than a property of connection pooling.
    await tx.$executeRaw`SELECT set_config('app.agent_id', '', true)`;
    // The await must happen INSIDE the context. A Prisma query is a lazy
    // PrismaPromise: the extension does not run when the call is made, it runs
    // when the promise is first awaited. Returning `fn(tx)` unawaited would let
    // that happen after this frame has exited, with no tenant in scope.
    return runWithTenantContext({ tenantId }, async () => await fn(tx as TenantDb));
  });
}

/**
 * Opens a transaction scoped to one tenant AND one agent.
 *
 * Every policy that existed before the agent portal is now staff-only, so a
 * transaction opened this way starts from deny-everything and can reach only
 * what Phase 3 explicitly opened: the inquiries this agent was selected for,
 * their own record, contacts and quotes, and a short list of reference tables.
 *
 * Used ONLY for portal business queries. Authentication itself still runs
 * through withTenant, because loadAccount reads the user table — which agents
 * cannot see, and should not be able to.
 */
export async function withAgent<T>(
  tenantId: bigint,
  agentId: bigint,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId.toString()}, true)`;
    const actorId = currentActorId();
    await tx.$executeRaw`SELECT set_config('app.user_id', ${actorId?.toString() ?? ''}, true)`;
    // The agent id comes from the session, which read it from the user row —
    // never from a request body or a token claim. §7A rule 1, second boundary.
    await tx.$executeRaw`SELECT set_config('app.agent_id', ${agentId.toString()}, true)`;
    return runWithTenantContext({ tenantId }, async () => await fn(tx as TenantDb));
  });
}

/**
 * Resolves a subdomain slug to a tenant.
 *
 * Goes through the SECURITY DEFINER function rather than a direct read: policy
 * tenant_self hides every tenant row until app.tenant_id is already known, and
 * this is what runs before that is true.
 */
export interface ResolvedTenant {
  id: bigint;
  status: string;
}

export async function resolveTenantBySlug(slug: string): Promise<ResolvedTenant | null> {
  const rows = await prisma.$queryRaw<
    { id: bigint; status: string }[]
  >`SELECT id, status::text AS status FROM app_resolve_tenant(${slug})`;
  return rows[0] ?? null;
}
