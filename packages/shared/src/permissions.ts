/**
 * The permission registry (CLAUDE.md §7).
 *
 * This constant is the single source of truth. The `permission` table is seeded
 * from it, the API guards routes with keys from it, and the superadmin matrix
 * renders its rows and columns from it. Nothing else defines a permission.
 *
 *   module      SETTING, CRM, PURCHASE, ...
 *   feature     "<MODULE>.<SCREEN>"   one per screen, e.g. CRM.CUSTOMER
 *   permission  "<FEATURE>.<ACTION>"  e.g. CRM.CUSTOMER.EDIT
 */

export const ACTIONS = [
  'VIEW',
  'CREATE',
  'EDIT',
  'TOGGLE_STATUS',
  'DELETE',
  'EXPORT',
  'APPROVE',
  // Column-level, not screen-level (MODULE_PURCHASE_SALES §4 rules 5 and 6).
  // A user may hold PURCHASE.SEA_FREIGHT_FCL.VIEW and still not be allowed to
  // see what the company paid, or to move the margin.
  'VIEW_BUY_PRICE',
  'MANAGE_PROFIT',
  // Row-scope and workflow actions on an inquiry
  // (MODULE_PURCHASE_SALES §4 rule 10, §5.5, §9 Q10).
  'VIEW_ALL',
  'FOLLOWUP',
  'ATTACH_PRICE',
  'CONVERT_QUOTE',
  'SET_OUTCOME',
] as const;

export type Action = (typeof ACTIONS)[number];

export const MODULES = [
  'PURCHASE',
  'SALES',
  'CUSTOMER_SERVICE',
  'OPERATION',
  'DOCUMENTATION',
  'ACCOUNTS',
  'SETTING',
  'CRM',
  'ADMIN',
  'REPORT',
] as const;

export type Module = (typeof MODULES)[number];

/**
 * The standard master-data set. §8 fixes the Action column at Edit plus an
 * Active/Inactive toggle, so TOGGLE_STATUS stands in for removal.
 *
 * DELETE is defined in ACTIONS because §7 lists it, but it is deliberately
 * assigned to no feature: §4 rule 3 forbids hard deletes, and the ff_app role
 * holds no DELETE privilege on any table. Granting it would promise something
 * the database refuses to do.
 */
const MASTER: readonly Action[] = ['VIEW', 'CREATE', 'EDIT', 'TOGGLE_STATUS', 'EXPORT'];
const MASTER_APPROVE: readonly Action[] = [...MASTER, 'APPROVE'];
/** Statements and reports: nothing to create or toggle. */
const READ_ONLY: readonly Action[] = ['VIEW', 'EXPORT'];
/** The permission matrix itself — you look at it or you change it. */
const MATRIX: readonly Action[] = ['VIEW', 'EDIT'];
/**
 * The two column-level gates on a freight rate. Deliberately not paired with
 * VIEW: seeing the Price List and seeing the margin on it are separate grants,
 * which is the whole point of §4 rule 5.
 */
const RATE_COLUMNS: readonly Action[] = ['VIEW_BUY_PRICE', 'MANAGE_PROFIT'];
/**
 * The Inquiry List's five row actions (§5.5) plus the two rules that sit on
 * top of them.
 *
 * VIEW_ALL is §4 rule 10's row scope: a salesman sees their own inquiries by
 * default, and this widens it to the team. SET_OUTCOME is §9 Q10, answered —
 * WON and LOST are the numbers the business is measured on, so declaring one
 * is a separate grant from being able to work the inquiry.
 */
const INQUIRY: readonly Action[] = [
  'VIEW',
  'CREATE',
  'EDIT',
  'EXPORT',
  'VIEW_ALL',
  'FOLLOWUP',
  'ATTACH_PRICE',
  'CONVERT_QUOTE',
  'SET_OUTCOME',
];

export interface FeatureDefinition {
  module: Module;
  /** "<MODULE>.<SCREEN>" */
  feature: string;
  /** Label for the sidebar and the permission matrix. */
  label: string;
  actions: readonly Action[];
  /**
   * A gate on data inside other screens rather than a screen of its own.
   *
   * Every screen feature carries VIEW because the sidebar keys off it. A
   * column-level feature has no screen to navigate to, so it carries no VIEW
   * and is never rendered as a nav item — it still appears in the permission
   * matrix, which is the whole point of granting it separately.
   */
  columnLevel?: true;
}

/** Screen features — the ones the sidebar is built from. */
export function isScreenFeature(feature: FeatureDefinition): boolean {
  return feature.columnLevel !== true;
}

export const FEATURES: readonly FeatureDefinition[] = [
  // -- 1. Purchase -----------------------------------------------------------
  { module: 'PURCHASE', feature: 'PURCHASE.SEA_FREIGHT_FCL', label: 'Sea Freight (FCL)', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.SEA_FREIGHT_LCL', label: 'Sea Freight (LCL)', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.PRICE_ADDON_FCL_SEA', label: 'Price Add-on (FCL-Sea)', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.PRICE_ADDON_LCL_SEA', label: 'Price Add-on (LCL-Sea)', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.AIR_FREIGHT_PURCHASE', label: 'Air Freight Purchase', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.PRICE_ADDON_AIR', label: 'Price Add-on (Air)', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.PRICE_LIST_SEA_FCL', label: 'Price List — Sea FCL', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.PRICE_LIST_SEA_LCL', label: 'Price List — Sea LCL', actions: MASTER },
  { module: 'PURCHASE', feature: 'PURCHASE.PRICE_LIST_AIR', label: 'Price List — Air', actions: MASTER },
  // Not a screen — a pair of column-level gates that cut across all nine
  // purchase screens (MODULE_PURCHASE_SALES §6). It has no route, so the
  // sidebar skips it; the permission matrix still renders it as its own row.
  {
    module: 'PURCHASE',
    feature: 'PURCHASE.RATE',
    label: 'Rate — buy price & margin',
    actions: RATE_COLUMNS,
    columnLevel: true,
  },

  // -- 2. Sales & Marketing --------------------------------------------------
  // New Inquiry and Inquiry List are two views of one record, so they share
  // one feature — §6 writes it as a single SALES.INQUIRY. Capturing an inquiry
  // and working it are the same permission; what differs is the action.
  { module: 'SALES', feature: 'SALES.INQUIRY', label: 'Inquiry', actions: INQUIRY },
  // Still no wireframe for either lead screen (CLAUDE.md §3, §11). The
  // permissions exist so the sales_lead skeleton can be gated the day a field
  // list arrives; the screens themselves are unbuilt.
  { module: 'SALES', feature: 'SALES.NEW_SALES_LEAD', label: 'New Sales Lead', actions: MASTER },
  { module: 'SALES', feature: 'SALES.SALES_LEAD_FOLLOWUP', label: 'Sales Lead Follow-up', actions: MASTER },

  // -- 3. Customer Service ---------------------------------------------------
  { module: 'CUSTOMER_SERVICE', feature: 'CUSTOMER_SERVICE.QUOTATION', label: 'Quotation', actions: MASTER },
  { module: 'CUSTOMER_SERVICE', feature: 'CUSTOMER_SERVICE.QUOTATION_LIST', label: 'Quotation List', actions: MASTER },
  { module: 'CUSTOMER_SERVICE', feature: 'CUSTOMER_SERVICE.CARGO_BOOKING', label: 'Cargo Booking', actions: MASTER },
  { module: 'CUSTOMER_SERVICE', feature: 'CUSTOMER_SERVICE.SHIPMENT_APPROVAL', label: 'Shipment Approval', actions: MASTER_APPROVE },
  { module: 'CUSTOMER_SERVICE', feature: 'CUSTOMER_SERVICE.SHIPPING_ORDER', label: 'Shipping Order', actions: MASTER },

  // -- 4. Operation ----------------------------------------------------------
  { module: 'OPERATION', feature: 'OPERATION.CARGO_RECEIPT', label: 'Cargo Receipt', actions: MASTER },
  { module: 'OPERATION', feature: 'OPERATION.CONTAINER_LOAD_PLAN', label: 'Container Load Plan', actions: MASTER },
  { module: 'OPERATION', feature: 'OPERATION.STUFFING', label: 'Stuffing', actions: MASTER },
  { module: 'OPERATION', feature: 'OPERATION.IGM_SUBMISSION', label: 'IGM Submission', actions: MASTER },
  { module: 'OPERATION', feature: 'OPERATION.DO_ISSUE', label: 'DO Issue', actions: MASTER },

  // -- 5. Documentation ------------------------------------------------------
  { module: 'DOCUMENTATION', feature: 'DOCUMENTATION.SHIPMENT_ADVISE', label: 'Shipment Advise', actions: MASTER },
  { module: 'DOCUMENTATION', feature: 'DOCUMENTATION.BL_DRAFT', label: 'BL Draft', actions: MASTER_APPROVE },
  { module: 'DOCUMENTATION', feature: 'DOCUMENTATION.BL_PRINT', label: 'BL Print', actions: READ_ONLY },
  { module: 'DOCUMENTATION', feature: 'DOCUMENTATION.COPY_DOC_UPLOAD', label: 'Copy Doc Upload', actions: MASTER },

  // -- 6. Accounts -----------------------------------------------------------
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.AWAITING_FREIGHT_INV', label: 'Awaiting Freight Inv', actions: MASTER_APPROVE },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.NEW_INVOICE_OTHER', label: 'New Invoice (Other)', actions: MASTER },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.AMOUNT_RECEIVABLE', label: 'Amount Receivable', actions: MASTER },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.NEW_CREDIT_INVOICE', label: 'New Credit Invoice', actions: MASTER_APPROVE },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.AMOUNT_PAYABLE', label: 'Amount Payable', actions: MASTER },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.INCOME_STATEMENT', label: 'Income Statement', actions: READ_ONLY },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.BALANCE_SHEET', label: 'Balance Sheet', actions: READ_ONLY },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.CASH_FLOW_STATEMENT', label: 'Cash Flow Statement', actions: READ_ONLY },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.TA_DA', label: 'TA/DA', actions: MASTER_APPROVE },

  // -- 7. Setting ------------------------------------------------------------
  // Workstation and Warehouse are on the §3 menu but have no wireframe (§11).
  // No permission is defined for a screen that cannot be built — an unusable
  // checkbox in the superadmin matrix is worse than an absent one.
  { module: 'SETTING', feature: 'SETTING.SEA_AIR_PORT', label: 'Sea-Air Port', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.COST_HEAD', label: 'Cost Head', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.CURRENCY', label: 'Currency', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.CARRIER', label: 'Carrier', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.VESSEL', label: 'Vessel', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.VENDOR', label: 'Vendor', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.COMMODITY_CATEGORY', label: 'Commodity Category', actions: MASTER },

  // Purchase & Sales lookups (docs/MODULE_PURCHASE_SALES.md §3.1, §6).
  // SETTING.INQUIRY_SOURCE is not in the spec's §6 list, but inquiry_source is
  // a §3.1 lookup with a Settings screen — without a permission its screen
  // could not be gated at all, so it is added on the same shape as the rest.
  { module: 'SETTING', feature: 'SETTING.GOODS_TYPE', label: 'Goods Type', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.CONTAINER_TYPE', label: 'Container Type', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.RATE_TIER', label: 'Rate Tier', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.TOS', label: 'Terms of Shipment', actions: MASTER },
  { module: 'SETTING', feature: 'SETTING.INQUIRY_SOURCE', label: 'Inquiry Source', actions: MASTER },

  // -- 8. CRM ----------------------------------------------------------------
  { module: 'CRM', feature: 'CRM.CUSTOMER', label: 'Customer', actions: MASTER },
  { module: 'CRM', feature: 'CRM.AGENT', label: 'Agent', actions: MASTER },
  { module: 'CRM', feature: 'CRM.EMPLOYEE', label: 'Employee', actions: MASTER },
  { module: 'CRM', feature: 'CRM.USER', label: 'User', actions: MASTER },

  // -- Admin (§7 superadmin screens; not a §3 menu module) --------------------
  { module: 'ADMIN', feature: 'ADMIN.ROLE', label: 'Roles', actions: MASTER },
  { module: 'ADMIN', feature: 'ADMIN.USER_PERMISSION', label: 'User Permissions', actions: MATRIX },

  // -- 9. Report -------------------------------------------------------------
  { module: 'REPORT', feature: 'REPORT.LIFTING_REPORT', label: 'Lifting Report', actions: READ_ONLY },
  { module: 'REPORT', feature: 'REPORT.CUSTOMER_WISE_SHIPMENT', label: 'Customer-wise Shipment', actions: READ_ONLY },
  { module: 'REPORT', feature: 'REPORT.COUNTRY_WISE_SHIPMENT', label: 'Country-wise Shipment', actions: READ_ONLY },
];

export interface PermissionDefinition {
  module: Module;
  feature: string;
  action: Action;
  key: string;
}

/** Every permission the system knows about, flattened from FEATURES. */
export const PERMISSIONS: readonly PermissionDefinition[] = FEATURES.flatMap((f) =>
  f.actions.map((action) => ({
    module: f.module,
    feature: f.feature,
    action,
    key: `${f.feature}.${action}`,
  })),
);

const permissionKeySet: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

export function isPermissionKey(key: string): boolean {
  return permissionKeySet.has(key);
}

export function permissionKey(feature: string, action: Action): string {
  return `${feature}.${action}`;
}

/** Features grouped by module, in menu order — drives the sidebar and matrix. */
export function featuresByModule(): { module: Module; features: FeatureDefinition[] }[] {
  return MODULES.map((module) => ({
    module,
    features: FEATURES.filter((f) => f.module === module),
  })).filter((group) => group.features.length > 0);
}
