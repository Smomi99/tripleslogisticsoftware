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
  // Everything an agent account can reach. A staff user holds no AGENT
  // permission, so the group never renders for them — the same §7 layer-3 rule
  // that hides Accounts from a warehouse clerk.
  AGENT: 'Agent',
};

/**
 * Routes that exist today. Filled in as each phase lands.
 *
 * Typed as `Route` so next.config's typedRoutes still checks them — a path
 * added here that does not resolve to a real page fails the build rather than
 * 404ing for an operator.
 */
/**
 * One feature can own more than one menu item.
 *
 * §3 of the booking module splits Shipment Booking into "- Sea" and "- Air"
 * while §7 keeps them one permission, because they are one screen with
 * mode-conditional fields. A second entry carries its own label and its own
 * path; everything else about it is the feature's.
 */
type RouteEntry = Route | readonly { readonly label: string; readonly href: Route }[];

const ROUTES: Record<string, RouteEntry> = {
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
  'CUSTOMER_SERVICE.QUOTATION': '/cs/quotation',
  'AGENT.INQUIRY': '/agent/inquiry',
  'SALES.NEW_SALES_LEAD': '/sales/sales-lead',
  'SETTING.SEA_AIR_PORT': '/setting/port',
  'SETTING.COST_HEAD': '/setting/cost-head',
  'SETTING.CURRENCY': '/setting/currency',
  'SETTING.VESSEL': '/setting/vessel',
  'SETTING.CARRIER': '/setting/carrier',
  'SETTING.COMMODITY_CATEGORY': '/setting/commodity',
  'SETTING.GOODS_TYPE': '/setting/goods-type',
  'SETTING.CONTAINER_SIZE': '/setting/container-size',
  'SETTING.RATE_TIER': '/setting/rate-tier',
  'SETTING.TOS': '/setting/tos',
  'SETTING.MODE': '/setting/mode',
  'SETTING.NOTIFICATION': '/setting/notification',
  'SETTING.INQUIRY_SOURCE': '/setting/inquiry-source',
  'CRM.CUSTOMER': '/crm/customer',
  'CRM.VENDOR': '/crm/vendor',
  'CRM.AGENT': '/crm/agent',
  'CRM.EMPLOYEE': '/crm/employee',
  'CRM.USER': '/crm/user',
  'ADMIN.ROLE': '/admin/role',
  // §3: two menu items, one screen, one permission.
  'CUSTOMER_SERVICE.CARGO_BOOKING': [
    { label: 'Shipment Booking - Sea', href: '/cs/shipment-booking-sea' },
    { label: 'Shipment Booking - Air', href: '/cs/shipment-booking-air' },
  ],
  /*
   * The direct list screens — client decision, 2026-09-03.
   *
   * These three stages were reachable only as tabs on a booking, which meant
   * an operator had to already know which booking they wanted before the
   * product would tell them anything. Each now has a menu item onto a queue of
   * the bookings waiting on it. Sea and air share one screen with a mode
   * filter, the way the Booking List does.
   */
  'CUSTOMER_SERVICE.SHIPMENT_APPROVAL': '/cs/shipment-approval',
  'CUSTOMER_SERVICE.SHIPPING_ORDER': '/cs/shipping-order',
  'OPERATION.CARGO_RECEIPT': '/operation/cargo-receipt',
};

/**
 * Paths a permission guards but the sidebar does not link to.
 *
 * The booking form is the live case: it opens from the Booking action on a
 * quotation and always needs one, so there is nothing for a menu item to point
 * at until the Booking List lands. Without this, §7 layer 4 would have a hole
 * exactly where the URL is easiest to guess — the API still refuses, but the
 * screen would render its shell first and look broken rather than forbidden.
 */
const UNLISTED_ROUTES: Record<string, string> = {
  'CUSTOMER_SERVICE.CARGO_BOOKING': '/cs/shipment-booking',
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
    items: FEATURES.filter((f) => f.module === module && isNavFeature(f)).flatMap((f) => {
      const route = ROUTES[f.feature];
      if (Array.isArray(route)) {
        return route.map((entry) => ({
          feature: f.feature,
          label: entry.label,
          href: entry.href,
          viewPermission: `${f.feature}.VIEW`,
        }));
      }
      return [
        {
          feature: f.feature,
          label: f.label,
          href: (route as Route | undefined) ?? null,
          viewPermission: `${f.feature}.VIEW`,
        },
      ];
    }),
  })).filter((group) => group.items.length > 0);
}

/**
 * The VIEW permission a path needs, or null when it needs none.
 *
 * The same map the sidebar is built from, read backwards. Hiding a menu item is
 * §7 layer 3; this is the other half of layer 4 — typing the URL of a screen
 * you cannot open should say so, not render an empty table that looks broken.
 *
 * Longest prefix wins, so a child screen (/crm/agent/1/pic) inherits the
 * permission of its parent (/crm/agent) without being listed separately.
 */
export function viewPermissionForPath(pathname: string): string | null {
  let best: { route: string; feature: string } | null = null;
  const all: [string, string][] = [];
  for (const [feature, route] of Object.entries(ROUTES)) {
    if (Array.isArray(route)) for (const entry of route) all.push([feature, entry.href]);
    else all.push([feature, route as string]);
  }
  all.push(...Object.entries(UNLISTED_ROUTES));

  for (const [feature, route] of all) {
    if (pathname !== route && !pathname.startsWith(`${route}/`)) continue;
    if (best === null || route.length > best.route.length) best = { route, feature };
  }
  return best === null ? null : `${best.feature}.VIEW`;
}
