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
  // A customer's own people. Like AGENT, a staff user holds no CUSTOMER
  // permission, so the group never renders for them — and like AGENT, the
  // group is named for who it belongs to, which is also the client's own
  // column header on the Menu sheet. Naming it after its first screen made
  // the breadcrumb read "My Shipments / My Shipments".
  CUSTOMER: 'Customer',
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
  // docs/DESIGN-UPDATE-2026-10-04.md §2, Menu F10: a landing page and six lists under it.
  'CUSTOMER_SERVICE.DEPART_ARRIVE': '/cs/depart-arrive',
  // docs/DESIGN-UPDATE-2026-10-04.md §3, Menu F11.
  'CUSTOMER_SERVICE.PRE_ALERT': '/cs/pre-alert',
  'OPERATION.CARGO_RECEIPT': '/operation/cargo-receipt',
  'OPERATION.CONTAINER_LOAD_PLAN': '/operation/container-load-plan',
  // docs/DESIGN-UPDATE-2026-10-04.md §4, Menu I7–I8: inbound bookings only.
  'OPERATION.IGM_SUBMISSION': '/operation/igm-submission',
  'OPERATION.DO_ISSUE': '/operation/do-issue',
  /*
   * Documentation (docs/MODULE_DOCUMENTATION.md §2). Two menu items on one
   * screen and one permission, the way Shipment Booking does it: the sheets
   * differ by shipment_type, not by anything the user may or may not do.
   */
  'DOCUMENTATION.SHIPMENT_ADVISE': [
    { label: 'Shipment Advise - Sea', href: '/documentation/shipment-advise-sea' },
    { label: 'Shipment Advise - Air', href: '/documentation/shipment-advise-air' },
  ],
  // The client's new `BL Draft List` menu item (Menu K6).
  'DOCUMENTATION.BL_DRAFT': '/documentation/bl-draft',
  // BL Print (Menu K7) — the approved bills, to issue and print (§13).
  'DOCUMENTATION.BL_PRINT': '/documentation/bl-print',
  // Accounts (docs/MODULE_ACCOUNTS.md), Menu M3–M19.
  'ACCOUNTS.AWAITING_FREIGHT_INV': '/accounts/awaiting-freight-inv',
  'ACCOUNTS.DEBIT_INVOICE': '/accounts/debit-invoice',
  'ACCOUNTS.NEW_CREDIT_INVOICE': '/accounts/credit-invoice',
  'ACCOUNTS.RECEIVABLE_PAYABLE': '/accounts/receivable-payable',
  'ACCOUNTS.CHART_OF_ACCOUNTS': '/accounts/chart-of-accounts',
  'ACCOUNTS.JOURNAL': '/accounts/journal',
  'ACCOUNTS.EXPENSE': '/accounts/expense',
  'ACCOUNTS.INCOME': '/accounts/income',
  'ACCOUNTS.INTERNAL_TRANSFER': '/accounts/internal-transfer',
  // docs/DESIGN-UPDATE-2026-10-04.md §8, Menu M14.
  'ACCOUNTS.SHIPMENT_PROFITABILITY': '/accounts/shipment-profitability',
  'ACCOUNTS.BANK_SETUP': '/accounts/bank-setup',
  'ACCOUNTS.ACCOUNT_SETUP': '/accounts/account-setup',
  'CUSTOMER.SHIPMENT': '/portal/shipment',
};

/**
 * A grant a screen needs on top of its own VIEW.
 *
 * Shipment Profitability is nothing but the cost side of the debit invoices,
 * and the API refuses it without VIEW_BUY_PRICE (MODULE_ACCOUNTS §3.9). A menu
 * item that opened onto a refusal would be §7 layer 3 failing, so the sidebar
 * and the route gate ask for both, exactly as the route does.
 */
const ALSO_REQUIRES: Record<string, readonly string[]> = {
  'ACCOUNTS.SHIPMENT_PROFITABILITY': ['ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE'],
};

function viewPermissionsOf(feature: string): string[] {
  return [`${feature}.VIEW`, ...(ALSO_REQUIRES[feature] ?? [])];
}

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
  // §3.5's templates. The client's menu has Make Templet and Use Templet on the
  // BL Draft screen and no third item, so this is reached from there.
  'DOCUMENTATION.BL_TEMPLATE': '/documentation/bl-template',
};

/**
 * A heading inside a module's group, for menu items the client nests.
 *
 * The Accounts column of the Menu sheet puts Journal, Expense, Income and
 * Internal Transfer under "- Transaction" (M8), and Bank and Account Set up
 * under "Setting" (M17). A section only groups what is already there — the
 * items and their order are still the registry's.
 */
const NAV_SECTION: Record<string, string> = {
  'ACCOUNTS.JOURNAL': 'Transaction',
  'ACCOUNTS.EXPENSE': 'Transaction',
  'ACCOUNTS.INCOME': 'Transaction',
  'ACCOUNTS.INTERNAL_TRANSFER': 'Transaction',
  'ACCOUNTS.BANK_SETUP': 'Setting',
  'ACCOUNTS.ACCOUNT_SETUP': 'Setting',
};

export interface NavItem {
  feature: string;
  label: string;
  href: Route | null;
  /** All of these, not any: the feature's VIEW plus whatever ALSO_REQUIRES adds. */
  viewPermissions: readonly string[];
  section?: string;
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
          viewPermissions: viewPermissionsOf(f.feature),
        }));
      }
      const section = NAV_SECTION[f.feature];
      return [
        {
          feature: f.feature,
          label: f.label,
          href: (route as Route | undefined) ?? null,
          viewPermissions: viewPermissionsOf(f.feature),
          ...(section === undefined ? {} : { section }),
        },
      ];
    }),
  })).filter((group) => group.items.length > 0);
}

/**
 * The permissions a path needs — all of them — or none.
 *
 * The same map the sidebar is built from, read backwards. Hiding a menu item is
 * §7 layer 3; this is the other half of layer 4 — typing the URL of a screen
 * you cannot open should say so, not render an empty table that looks broken.
 *
 * Longest prefix wins, so a child screen (/crm/agent/1/pic) inherits the
 * permission of its parent (/crm/agent) without being listed separately.
 */
export function viewPermissionsForPath(pathname: string): string[] {
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
  return best === null ? [] : viewPermissionsOf(best.feature);
}
