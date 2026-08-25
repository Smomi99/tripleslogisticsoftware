import { AsyncLocalStorage } from 'node:async_hooks';

import { HttpError } from './http-error';

/**
 * Which tenancy tier each Prisma model belongs to.
 *
 * These lists mirror the RLS policies in
 * prisma/migrations/*_tenant_rls_policies/migration.sql. If a model is added to
 * the schema it MUST be added here too — `assertModelTiersAreComplete` fails the
 * test suite otherwise, so a new table cannot quietly default to unscoped.
 */

/** No tenant_id column at all (CLAUDE.md §4 rule 2 exception list). */
export const PLATFORM_MODELS = ['Tenant', 'PlatformUser', 'Permission'] as const;

/**
 * Nullable tenant_id — NULL is a system row visible to every tenant
 * (CLAUDE.md §7A rule 7). Readable by all, writable only as your own.
 */
export const SYSTEM_CAPABLE_MODELS = [
  'Carrier',
  'CarrierType',
  'ContainerSize',
  'ContainerType',
  'EmailTemplate',
  'CostUnit',
  'Currency',
  'ExpertArea',
  'GoodsType',
  'InquirySource',
  'Mode',
  'Network',
  'Port',
  'RateTier',
  'Tos',
  'VendorType',
] as const;

/** tenant_id NOT NULL — visible only to the owning tenant. */
export const TENANT_OWNED_MODELS = [
  'Agent',
  'EmailLog',
  'InquiryCommodity',
  'AgentExpertArea',
  'AgentNetworkMember',
  'AgentPic',
  'AgentPortCoverage',
  // The agent portal (docs/AGENT_PORTAL_DESIGN.md). A quote is one forwarder's
  // buying position and is never shared, the same reasoning as FreightRate.
  'AgentQuote',
  'AgentQuoteOption',
  'AgentQuoteLine',
  'AgentQuoteComment',
  'AuditLog',
  'CarrierPic',
  'CarrierPortPair',
  'CarrierServicePort',
  'CommodityItem',
  'CostHead',
  'CurrencyRateHistory',
  'Customer',
  'CustomerPic',
  'Employee',
  'EmployeeCv',
  'EmployeeSalary',
  // Rate tables are never shared: a bought rate is one forwarder's commercial
  // position, and freight_rate_line.buy_price is the margin on every lane.
  'FreightRate',
  'FreightRateLine',
  'IndustrySector',
  // Sales: an inquiry is one company's pipeline, never shared.
  'Inquiry',
  'InquiryFollowup',
  'MailSignatureLogo',
  'Quotation',
  'QuotationLine',
  'QuotationCommodity',
  'QuotationRecipient',
  'QuotationFollowup',
  'InquiryParty',
  'InquiryPartyContact',
  'InquiryRate',
  'InquiryVolume',
  'NotificationSetting',
  'RateLocalCharge',
  'RateProfitLog',
  'Role',
  'RolePermission',
  'SalesLead',
  'SalesLeadFollowup',
  'TenantMasterOverride',
  'User',
  'UserPermission',
  'Vendor',
  'VendorPic',
  'Vessel',
] as const;

const platformSet: ReadonlySet<string> = new Set(PLATFORM_MODELS);
const systemCapableSet: ReadonlySet<string> = new Set(SYSTEM_CAPABLE_MODELS);
const tenantOwnedSet: ReadonlySet<string> = new Set(TENANT_OWNED_MODELS);

export type TenancyTier = 'platform' | 'system-capable' | 'tenant-owned';

export function tierOf(model: string): TenancyTier | undefined {
  if (platformSet.has(model)) return 'platform';
  if (systemCapableSet.has(model)) return 'system-capable';
  if (tenantOwnedSet.has(model)) return 'tenant-owned';
  return undefined;
}

// ---------------------------------------------------------------------------
// Request-scoped tenant context
// ---------------------------------------------------------------------------

export interface TenantContext {
  tenantId: bigint;
}

/**
 * Who is acting, for the audit trail.
 *
 * Set once by the authenticate middleware and read by withTenant, so no route
 * has to pass the actor down to every write. Absent on unauthenticated paths
 * (a sign-in attempt), where the trail records SYSTEM instead of inventing one.
 */
export interface ActorContext {
  userId: bigint;
}

const actorStorage = new AsyncLocalStorage<ActorContext>();

export function runWithActor<T>(context: ActorContext, fn: () => T): T {
  return actorStorage.run(context, fn);
}

export function currentActorId(): bigint | undefined {
  return actorStorage.getStore()?.userId;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentTenantId(): bigint | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * The default is deny. A model query outside a tenant context throws rather
 * than falling back to an unscoped read — the failure mode CLAUDE.md §4 rule 10
 * calls the worst one available.
 */
export function requireTenantId(): bigint {
  const tenantId = currentTenantId();
  if (tenantId === undefined) {
    throw new HttpError(
      500,
      'TENANT_CONTEXT_MISSING',
      'Query attempted outside a tenant context. Wrap it in withTenant().',
    );
  }
  return tenantId;
}
