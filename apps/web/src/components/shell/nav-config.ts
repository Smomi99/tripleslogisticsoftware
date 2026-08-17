import { FEATURES, isScreenFeature, MODULES, type Module } from '@ff/shared';
import type { Route } from 'next';

/**
 * The sidebar is generated from the §7 permission registry, not hand-written.
 * A feature that exists in the registry but has no route yet simply has no
 * href, so the menu can never drift from the permission model.
 */

export const MODULE_LABEL: Record<Module, string> = {
  PURCHASE: 'Purchase',
  SALES: 'Sales & Marketing',
  CUSTOMER_SERVICE: 'Customer Service',
  OPERATION: 'Operation',
  DOCUMENTATION: 'Documentation',
  ACCOUNTS: 'Accounts',
  SETTING: 'Setting',
  CRM: 'CRM',
  ADMIN: 'Admin',
  REPORT: 'Report',
};

/**
 * Routes that exist today. Filled in as each phase lands.
 *
 * Typed as `Route` so next.config's typedRoutes still checks them — a path
 * added here that does not resolve to a real page fails the build rather than
 * 404ing for an operator.
 */
const ROUTES: Record<string, Route> = {
  'PURCHASE.SEA_FREIGHT_FCL': '/purchase/sea-freight-fcl',
  'PURCHASE.PRICE_ADDON_FCL_SEA': '/purchase/price-addon-fcl',
  'SETTING.SEA_AIR_PORT': '/setting/port',
  'SETTING.COST_HEAD': '/setting/cost-head',
  'SETTING.CURRENCY': '/setting/currency',
  'SETTING.VESSEL': '/setting/vessel',
  'SETTING.CARRIER': '/setting/carrier',
  'SETTING.VENDOR': '/setting/vendor',
  'SETTING.COMMODITY_CATEGORY': '/setting/commodity',
  'SETTING.GOODS_TYPE': '/setting/goods-type',
  'SETTING.CONTAINER_TYPE': '/setting/container-type',
  'SETTING.RATE_TIER': '/setting/rate-tier',
  'SETTING.TOS': '/setting/tos',
  'SETTING.INQUIRY_SOURCE': '/setting/inquiry-source',
  'CRM.CUSTOMER': '/crm/customer',
  'CRM.AGENT': '/crm/agent',
  'CRM.EMPLOYEE': '/crm/employee',
  'CRM.USER': '/crm/user',
  'ADMIN.ROLE': '/admin/role',
};

export interface NavItem {
  feature: string;
  label: string;
  href: Route | null;
  viewPermission: string;
}

export interface NavGroup {
  module: Module;
  label: string;
  items: NavItem[];
}

/** Menu order follows §3, which MODULES already encodes. */
export function buildNav(): NavGroup[] {
  return MODULES.map((module) => ({
    module,
    label: MODULE_LABEL[module],
    // Column-level features (PURCHASE.RATE) gate data inside other screens and
    // have nothing to navigate to, so they never become nav items.
    items: FEATURES.filter((f) => f.module === module && isScreenFeature(f)).map((f) => ({
      feature: f.feature,
      label: f.label,
      href: ROUTES[f.feature] ?? null,
      viewPermission: `${f.feature}.VIEW`,
    })),
  })).filter((group) => group.items.length > 0);
}
