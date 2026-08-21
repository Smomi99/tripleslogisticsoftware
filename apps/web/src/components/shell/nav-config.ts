import { FEATURES, isNavFeature, MODULES, type Module } from '@ff/shared';
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
  // All nine purchase screens run on three components (phase F).
  'PURCHASE.SEA_FREIGHT_FCL': '/purchase/sea-freight-fcl',
  'PURCHASE.SEA_FREIGHT_LCL': '/purchase/sea-freight-lcl',
  'PURCHASE.AIR_FREIGHT_PURCHASE': '/purchase/air-freight-purchase',
  'PURCHASE.PRICE_ADDON_FCL_SEA': '/purchase/price-addon-fcl',
  'PURCHASE.PRICE_ADDON_LCL_SEA': '/purchase/price-addon-lcl',
  'PURCHASE.PRICE_ADDON_AIR': '/purchase/price-addon-air',
  'PURCHASE.PRICE_LIST_SEA_FCL': '/purchase/price-list-fcl',
  'PURCHASE.PRICE_LIST_SEA_LCL': '/purchase/price-list-lcl',
  'PURCHASE.PRICE_LIST_AIR': '/purchase/price-list-air',
  // The list, not the capture form: §8 makes the list the screen a feature
  // opens on, with New reached from its Add button.
  'SALES.INQUIRY': '/sales/inquiry',
  'SALES.NEW_SALES_LEAD': '/sales/sales-lead',
  'SETTING.SEA_AIR_PORT': '/setting/port',
  'SETTING.COST_HEAD': '/setting/cost-head',
  'SETTING.CURRENCY': '/setting/currency',
  'SETTING.VESSEL': '/setting/vessel',
  'SETTING.CARRIER': '/setting/carrier',
  'SETTING.COMMODITY_CATEGORY': '/setting/commodity',
  'SETTING.GOODS_TYPE': '/setting/goods-type',
  'SETTING.CONTAINER_TYPE': '/setting/container-type',
  'SETTING.RATE_TIER': '/setting/rate-tier',
  'SETTING.TOS': '/setting/tos',
  'SETTING.MODE': '/setting/mode',
  'SETTING.INQUIRY_SOURCE': '/setting/inquiry-source',
  'CRM.CUSTOMER': '/crm/customer',
  'CRM.VENDOR': '/crm/vendor',
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
    // Column-level features (PURCHASE.RATE) gate data inside other screens, and
    // child screens (SETTING.CARRIER_PORT_PAIR) need a parent id in their route.
    // Neither has anything the sidebar could link to.
    items: FEATURES.filter((f) => f.module === module && isNavFeature(f)).map((f) => ({
      feature: f.feature,
      label: f.label,
      href: ROUTES[f.feature] ?? null,
      viewPermission: `${f.feature}.VIEW`,
    })),
  })).filter((group) => group.items.length > 0);
}
