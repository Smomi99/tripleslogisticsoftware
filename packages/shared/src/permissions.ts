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
  /*
   * §7 gives these two their own actions, and they earn it.
   *
   * PRICE_CHECK opens what the company paid for the lane. VIEW_BUY_PRICE
   * already guards that column on the purchase screens; a salesman who may
   * read an inquiry does not automatically get to read the buying side of it.
   *
   * CARRIER_POSITION opens the lane ranking — which carrier is cheapest and
   * which serves it best. That is the forwarder's own commercial judgement,
   * built up over years, and worth being able to withhold from a new starter.
   */
  'PRICE_CHECK',
  'CARRIER_POSITION',
  /*
   * Declaring the workspace's base currency, and it is not EDIT.
   *
   * Setting a rate changes one number. Changing the base re-expresses every
   * rate the workspace holds and changes what every figure on every screen
   * means — the sort of thing that belongs with whoever owns the books rather
   * than with anyone who may correct a dollar rate. The client's own words,
   * 2026-09-08: "base rate is for admin".
   */
  'SET_BASE',
  /*
   * §7's quotation actions.
   *
   * SEND is separate from EDIT because building a quotation and putting it in
   * front of a customer are different acts — a junior may draft one all day
   * and still not be the person who commits the company to a price.
   *
   * MANUAL_PRICE is the one the spec calls out: "typing a price by hand is
   * privileged". An auto-pulled line carries whatever the price table holds; a
   * typed one is a number somebody invented, and §6.5 marks it on screen for
   * exactly that reason.
   */
  'SEND',
  'EXPORT_PDF',
  'ADD_ADDITIONAL',
  'MANUAL_PRICE',
  // The agent side of an inquiry: sending a price back, and changing it while
  // the inquiry is still open. Separate from CREATE/EDIT because it is not the
  // inquiry being written — it is an answer to one.
  'QUOTE',
  /*
   * The booking's two workflow actions (MODULE_BOOKING_CARGO.md §7).
   *
   * SUBMIT is separate from CREATE for the reason §5.2 rule 4 implies: a
   * booking is assembled over several sittings and then handed to operations,
   * and the hand-off is the act that starts a shipment file moving.
   *
   * CANCEL is §5.1's `any -> CANCELLED`, which the spec marks privileged and
   * requires a reason for. It is the retirement path a booking has INSTEAD of
   * DELETE — see the note on CARGO_BOOKING below.
   */
  'SUBMIT',
  'CANCEL',
  /*
   * §7's CS.APPROVAL. REJECT is its own action rather than half of APPROVE
   * because turning a sailing down is the decision with consequences — §5.3
   * makes the comment mandatory and the C/S team has to act on it, while an
   * approval simply lets the shipment carry on.
   */
  'REJECT',
  /*
   * §7's CS.SHIPPING_ORDER. ISSUE is separate from CREATE because §5.4 rule 2
   * makes it one-way: the number is allocated, the warehouse works to the page,
   * and a mistake costs a cancellation rather than an edit. SKIP is separate
   * again — deciding a shipment needs no document at all is not the same act as
   * producing one.
   */
  'ISSUE',
  'SKIP',
  /*
   * §7's OPS.CARGO_RECEIPT. SHORT_CLOSE and OVERRIDE_QTY are separate on the
   * spec's own instruction: "they write off cargo the customer paid to move,
   * and should sit with a supervisor, not the warehouse clerk."
   */
  'CONFIRM',
  'DECLINE_LINE',
  'SHORT_CLOSE',
  'OVERRIDE_QTY',
  /*
   * MODULE_CLP.md §6. Splitting a PO across two containers is a different act
   * from adding one whole, FINALISE is irreversible — there is no edit path
   * back from a finalised load plan — and OVERRIDE_CAPACITY decides who may
   * load a 29 CBM plan into a 28 CBM box. All three sit with a supervisor.
   */
  'SPLIT',
  'FINALISE',
  'OVERRIDE_CAPACITY',
  /*
   * MODULE_DOCUMENTATION §6. Re-pulling the advise's PO grid from the CLP is
   * not EDIT: it discards whatever was typed over the pulled figures and
   * replaces the whole grid. Someone may be trusted to correct a line
   * without being trusted to throw the corrections away.
   */
  'BUILD',
  /*
   * CR-002 §9. Changing a container's cost split by hand moves money between
   * customers' invoices, so it is its own right rather than something anyone
   * who can edit a load plan may do.
   */
  'OVERRIDE_COST',
  /*
   * MODULE_ACCOUNTS §6. Recording money in against a debit invoice is not
   * editing it: it is a claim that cash arrived, and it closes a receivable.
   * The person who raises an invoice is often not the person who may say it
   * has been paid.
   */
  'RECEIVE',
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
  /**
   * Screens for people who are not staff.
   *
   * An agent is a user of this workspace like any other — created on Add User,
   * given a role, holding permissions — but everything they may reach lives
   * here, so what an outside company can see is one line of this file rather
   * than an audit of forty routers.
   */
  'AGENT',
  /**
   * Screens for a customer's own people, on the same reasoning as AGENT: an
   * outside company's whole reach is one block of this file rather than an
   * audit of forty routers.
   *
   * CR-004 is what makes this safe to grant. Until the session declared its
   * kind, a customer login was indistinguishable from staff at the database,
   * and a role with CRM.CUSTOMER.VIEW ticked onto it would have opened the
   * whole workspace.
   */
  'CUSTOMER',
] as const;

export type Module = (typeof MODULES)[number];

/**
 * The standard set. §8 fixes the Action column at Edit plus an Active/Inactive
 * toggle, so TOGGLE_STATUS stands in for removal on everything transactional:
 * a quotation, a booking or an invoice is business history and is retired by
 * its own status, never removed.
 */
const MASTER: readonly Action[] = ['VIEW', 'CREATE', 'EDIT', 'TOGGLE_STATUS', 'EXPORT'];

/**
 * Master data proper — Settings and CRM — which additionally carries DELETE.
 *
 * §4 rule 3 forbids hard deletes and that is not in question: DELETE here sets
 * `deleted_at`, so every foreign key survives and the ff_app role needs only
 * the UPDATE privilege it already has. What it buys is the one case
 * TOGGLE_STATUS cannot express — a row that was never real. A carrier typed
 * twice, a port called "omi". Deactivating those leaves them in the Inactive
 * filter forever and still competing for attention in a picker.
 *
 * The API refuses regardless of this permission when anything references the
 * row (lib/references.ts), so holding DELETE is necessary and not sufficient.
 * See docs/CR-002-delete-action.md — this deviates from §8 and is with the
 * client for confirmation.
 */
const MASTER_DELETABLE: readonly Action[] = [...MASTER, 'DELETE'];
const MASTER_APPROVE: readonly Action[] = [...MASTER, 'APPROVE'];
/** Statements and reports: nothing to create or toggle. */
/**
 * MODULE_CLP.md §6. EXPORT is the print document — the spec calls it PRINT,
 * but every other printable record in this registry exports, and one name for
 * one act is worth more than matching a heading.
 *
 * No DELETE: a load plan is retired by CANCELLED, which releases its cartons
 * back to the pool and keeps the record. TOGGLE_STATUS comes with MASTER and
 * is deliberately not wired to anything — a CLP's lifecycle is its status,
 * and a second switch beside it would be a way to hide a finalised plan
 * without cancelling it.
 */
const CLP: readonly Action[] = [
  ...MASTER,
  'SPLIT',
  'FINALISE',
  'CANCEL',
  'OVERRIDE_CAPACITY',
  'OVERRIDE_COST',
];

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
  'PRICE_CHECK',
  'CARRIER_POSITION',
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
  /**
   * A screen reached from a parent row, not from the sidebar (CR-001 §6).
   *
   * It is a real screen and carries VIEW, so the §7 rules about hiding what a
   * user cannot see apply in full — but its route needs a parent id, so there
   * is no sidebar entry to render. Without this the menu would show a
   * permanently greyed "Not built yet" item for a screen that is built.
   */
  childScreen?: true;
}

/** Real screens, as opposed to gates on data inside other screens. */
export function isScreenFeature(feature: FeatureDefinition): boolean {
  return feature.columnLevel !== true;
}

/** The subset the sidebar is built from: screens with a route of their own. */
export function isNavFeature(feature: FeatureDefinition): boolean {
  return isScreenFeature(feature) && feature.childScreen !== true;
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
  // The spec renames the menu item: "Inquiry List -> Renamed Live Inquiry".
  // This label is the screen's name everywhere -- sidebar, breadcrumb and the
  // permission matrix -- so it changes in one place.
  { module: 'SALES', feature: 'SALES.INQUIRY', label: 'Live Inquiry', actions: INQUIRY },
  // The only feature an agent account is ever granted. VIEW shows the
  // inquiries they were selected for; QUOTE lets them answer one, so a
  // forwarder can give read-only access to a junior at the agent.
  { module: 'AGENT', feature: 'AGENT.INQUIRY', label: 'Agent Inquiry', actions: ['VIEW', 'QUOTE'] },
  /*
   * docs/MODULE_DOCUMENTATION.md §2.4 — the customer's copy of the BL draft.
   *
   * A child screen: the Menu sheet's Customer column does not list BL Draft
   * (§12 Q6), so it opens from the customer's own shipment row and has
   * nothing for a sidebar to point at.
   *
   * SUBMIT rather than SEND, because the customer hands the draft to the
   * forwarder and never sends anything outward themselves — that is the
   * whole difference between the two sheets.
   */
  {
    module: 'CUSTOMER',
    feature: 'CUSTOMER.BL_DRAFT',
    label: 'My BL Drafts',
    actions: ['VIEW', 'CREATE', 'EDIT', 'SUBMIT', 'EXPORT_PDF'],
    childScreen: true,
  },
  /*
   * The customer's own shipment list — what the BL draft is reached from,
   * and the first of the Menu sheet's Customer column (§2.5) to be built.
   */
  { module: 'CUSTOMER', feature: 'CUSTOMER.SHIPMENT', label: 'My Shipments', actions: ['VIEW', 'EXPORT'] },
  // Still no wireframe for either lead screen (CLAUDE.md §3, §11). The
  // permissions exist so the sales_lead skeleton can be gated the day a field
  // list arrives; the screens themselves are unbuilt.
  { module: 'SALES', feature: 'SALES.NEW_SALES_LEAD', label: 'New Sales Lead', actions: MASTER },
  { module: 'SALES', feature: 'SALES.SALES_LEAD_FOLLOWUP', label: 'Sales Lead Follow-up', actions: MASTER },

  // -- 3. Customer Service ---------------------------------------------------
  /*
   * One feature for both of the client's menu items, the way SALES.INQUIRY
   * covers New Inquiry and Live Inquiry: §8 opens a feature on its list and
   * reaches the form from the Add button. Drafting, sending and following up
   * are the same screen's actions, not separate screens.
   */
  {
    module: 'CUSTOMER_SERVICE',
    feature: 'CUSTOMER_SERVICE.QUOTATION',
    label: 'Quotation',
    /*
     * §7 lists DELETE. CR-002 does not allow it here: DELETE is for master data
     * a user typed twice, and a quotation is business history retired by its own
     * status. A draft raised in error is a real case the rule does not cover —
     * see §11, question 13. Following the stricter rule until the client answers.
     */
    actions: ['VIEW', 'CREATE', 'EDIT', 'SEND', 'FOLLOWUP', 'EXPORT_PDF', 'VIEW_ALL'],
  },
  /*
   * Column-level, like PURCHASE's VIEW_BUY_PRICE. Adding a cost head nobody
   * priced, and typing a selling price the rate table does not hold, are the
   * two ways a quotation can leave the price list behind — so they are the two
   * a forwarder may want to withhold.
   */
  {
    module: 'CUSTOMER_SERVICE',
    feature: 'CUSTOMER_SERVICE.QUOTATION_LINE',
    label: 'Quotation pricing',
    actions: ['ADD_ADDITIONAL', 'MANUAL_PRICE'],
    // Gates on data inside the Quotation screen, not a screen of its own — so
    // no VIEW, and nothing for the sidebar to render.
    columnLevel: true,
  },
  /*
    * The shipment file (docs/MODULE_BOOKING_CARGO.md). CLAUDE.md §3 called this
    * menu item Cargo Booking and §3 of the module spec renames it to Shipment
    * Booking - Sea / - Air; the label follows the rename, the key does not,
    * because the key is what production's role_permission rows point at.
    *
    * One feature for both menu items, as §3 asks: "Build one component driven
    * by shipment_type, and route both menu items to it."
    *
    * §7 of the module spec lists DELETE here and it is deliberately absent.
    * CR-002 drew the boundary first and named this case: master data can be
    * removed, "a quotation, a booking or an invoice never can, because it is
    * business history retired by its own status". §5.1 gives a booking that
    * status — CANCELLED, privileged, reason mandatory — which is CANCEL below.
    * The grid's per-row Edit | Delete (§5.2 rule 3) is composing a draft, and
    * rides on EDIT.
    */
  {
    module: 'CUSTOMER_SERVICE',
    feature: 'CUSTOMER_SERVICE.CARGO_BOOKING',
    label: 'Shipment Booking',
    actions: [...MASTER, 'VIEW_ALL', 'SUBMIT', 'CANCEL'],
  },
  /*
   * MODULE_BOOKING_CARGO.md §7's CS.SCHEDULE — the Vessel / Flight Booking
   * screen (§6.4). A child screen: it is reached from the Action button on a
   * booking and needs that booking's id, so it has a permission but nothing
   * for the sidebar to link to.
   *
   * Separate from CARGO_BOOKING because proposing a sailing is a different job
   * from taking the booking, and §7 gives it its own three actions.
   */
  {
    module: 'CUSTOMER_SERVICE',
    feature: 'CUSTOMER_SERVICE.SCHEDULE',
    label: 'Vessel / Flight Booking',
    actions: ['VIEW', 'CREATE', 'EDIT'],
    childScreen: true,
  },
  /*
    * §6.5's screen. §7 lists CS.APPROVAL as VIEW APPROVE REJECT; the extra
    * MASTER actions are kept because production's permission rows already point
    * at them and the seed prunes nothing — they are simply unused by the routes.
    */
  {
    module: 'CUSTOMER_SERVICE',
    feature: 'CUSTOMER_SERVICE.SHIPMENT_APPROVAL',
    label: 'Shipment Approval',
    actions: [...MASTER_APPROVE, 'REJECT'],
  },
  /*
    * §6.6's document. §7 lists CS.SHIPPING_ORDER as
    * VIEW ISSUE SKIP CANCEL EXPORT_PDF; the MASTER actions stay because
    * production's permission rows point at them and the seed prunes nothing.
    */
  {
    module: 'CUSTOMER_SERVICE',
    feature: 'CUSTOMER_SERVICE.SHIPPING_ORDER',
    label: 'Shipping Order',
    actions: [...MASTER, 'ISSUE', 'SKIP', 'CANCEL', 'EXPORT_PDF'],
  },

  // -- 4. Operation ----------------------------------------------------------
  /*
    * §6.7's screen. §7 lists OPS.CARGO_RECEIPT as VIEW CREATE EDIT CONFIRM
    * DECLINE_LINE SHORT_CLOSE OVERRIDE_QTY; the MASTER actions stay because
    * production's permission rows point at them and the seed prunes nothing.
    */
  {
    module: 'OPERATION',
    feature: 'OPERATION.CARGO_RECEIPT',
    label: 'Cargo Receipt',
    actions: [...MASTER, 'CONFIRM', 'DECLINE_LINE', 'SHORT_CLOSE', 'OVERRIDE_QTY'],
  },
  {
    module: 'OPERATION',
    feature: 'OPERATION.CONTAINER_LOAD_PLAN',
    label: 'Container Load Plan',
    actions: CLP,
  },
  { module: 'OPERATION', feature: 'OPERATION.STUFFING', label: 'Stuffing', actions: MASTER },
  { module: 'OPERATION', feature: 'OPERATION.IGM_SUBMISSION', label: 'IGM Submission', actions: MASTER },
  { module: 'OPERATION', feature: 'OPERATION.DO_ISSUE', label: 'DO Issue', actions: MASTER },

  // -- 5. Documentation ------------------------------------------------------
  /*
   * docs/MODULE_DOCUMENTATION.md §6. The MASTER actions stay because
   * production's permission rows already point at them and the seed prunes
   * nothing; what is added is the four acts this screen actually performs.
   *
   * SEND is separate from EDIT for the reason the quotation's is, with more
   * force: the advise is what the customer plans their receiving week
   * around. CANCEL is the retirement path — a sent advise is immutable
   * (§5 rule 3), so a mistake is cancelled and re-issued.
   */
  {
    module: 'DOCUMENTATION',
    feature: 'DOCUMENTATION.SHIPMENT_ADVISE',
    label: 'Shipment Advise',
    actions: [...MASTER, 'BUILD', 'SEND', 'EXPORT_PDF', 'CANCEL'],
  },
  /*
   * APPROVE is the act §5 gives the forwarder over a draft the customer
   * submitted, and it is what moves the booking to BL_DRAFTED.
   */
  {
    module: 'DOCUMENTATION',
    feature: 'DOCUMENTATION.BL_DRAFT',
    label: 'BL Draft',
    actions: [...MASTER_APPROVE, 'SEND', 'EXPORT_PDF', 'CANCEL'],
  },
  /*
   * The client's Make Templet / Use Templet (§3.5). Its own feature rather
   * than an action on BL_DRAFT: a template outlives the draft it was saved
   * from, and is maintained and retired on its own.
   *
   * TOGGLE_STATUS rather than DELETE, and the distinction is CR-002's: DELETE
   * belongs to Settings and CRM, where a row can be something that was never
   * real. A template lives under a transactional module, so it retires by
   * going inactive — which is also all §8's Action column ever offers.
   */
  {
    module: 'DOCUMENTATION',
    feature: 'DOCUMENTATION.BL_TEMPLATE',
    label: 'BL Template',
    actions: ['VIEW', 'CREATE', 'EDIT', 'TOGGLE_STATUS'],
    childScreen: true,
  },
  { module: 'DOCUMENTATION', feature: 'DOCUMENTATION.BL_PRINT', label: 'BL Print', actions: READ_ONLY },
  { module: 'DOCUMENTATION', feature: 'DOCUMENTATION.COPY_DOC_UPLOAD', label: 'Copy Doc Upload', actions: MASTER },

  // -- 6. Accounts -----------------------------------------------------------
  /*
   * docs/MODULE_ACCOUNTS.md §6, in the order of the redrawn Menu (M3–M16).
   *
   * AWAITING_FREIGHT_INV keeps its actions: VIEW is the queue, CREATE is
   * `Make invoice`. The invoice it makes is a DEBIT_INVOICE from then on.
   */
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.AWAITING_FREIGHT_INV', label: 'Awaiting Freight Inv', actions: MASTER_APPROVE },
  /*
   * Was NEW_INVOICE_OTHER ("New Invoice (Other)"); renamed in place by
   * 20260926100000 so its grants survive. SEND is separate from EDIT for the
   * quotation's reason: composing an invoice and putting it in front of a
   * customer are different acts. VIEW_BUY_PRICE is §3.9 — whether a customer
   * has paid and what the carrier charged are not the same grant.
   */
  {
    module: 'ACCOUNTS',
    feature: 'ACCOUNTS.DEBIT_INVOICE',
    label: 'Debit Invoice',
    actions: [...MASTER, 'SEND', 'EXPORT_PDF', 'CANCEL', 'RECEIVE', 'VIEW_BUY_PRICE'],
  },
  // Not built; the client's menu calls it Credit Invoice now. Key unchanged.
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.NEW_CREDIT_INVOICE', label: 'Credit Invoice', actions: MASTER_APPROVE },
  /*
   * Was AMOUNT_RECEIVABLE and AMOUNT_PAYABLE — the client merged the two
   * screens into one. The receivable keys were renamed in place; grants on
   * the payable ones were copied here before those rows were removed.
   */
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.RECEIVABLE_PAYABLE', label: 'Receivable-Payable list', actions: MASTER },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.INCOME_STATEMENT', label: 'Income Statement', actions: READ_ONLY },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.BALANCE_SHEET', label: 'Balance Sheet', actions: READ_ONLY },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.CASH_FLOW_STATEMENT', label: 'Cash Flow Statement', actions: READ_ONLY },
  { module: 'ACCOUNTS', feature: 'ACCOUNTS.TA_DA', label: 'TA/DA', actions: MASTER_APPROVE },

  // -- 7. Setting ------------------------------------------------------------
  // Workstation and Warehouse are on the §3 menu but have no wireframe (§11).
  // No permission is defined for a screen that cannot be built — an unusable
  // checkbox in the superadmin matrix is worse than an absent one.
  { module: 'SETTING', feature: 'SETTING.SEA_AIR_PORT', label: 'Sea-Air Port', actions: MASTER_DELETABLE },
  { module: 'SETTING', feature: 'SETTING.COST_HEAD', label: 'Cost Head', actions: MASTER_DELETABLE },
  {
    module: 'SETTING',
    feature: 'SETTING.CURRENCY',
    label: 'Currency',
    // SET_BASE on top of the master set: see the note on the action.
    actions: [...MASTER_DELETABLE, 'SET_BASE'],
  },
  { module: 'SETTING', feature: 'SETTING.CARRIER', label: 'Carrier', actions: MASTER_DELETABLE },
  // CR-001 §6. Carrier PIC and Service Port are gated by SETTING.CARRIER, but
  // the client asked for Port Pair to be grantable on its own — lane rankings
  // are the pricing team's, and not everyone who maintains carrier contacts
  // should be able to move them. No EXPORT: the CR lists four actions.
  {
    module: 'SETTING',
    feature: 'SETTING.CARRIER_PORT_PAIR',
    label: 'Carrier Port Pair',
    actions: ['VIEW', 'CREATE', 'EDIT', 'TOGGLE_STATUS'],
    childScreen: true,
  },
  { module: 'SETTING', feature: 'SETTING.VESSEL', label: 'Vessel', actions: MASTER_DELETABLE },
  { module: 'SETTING', feature: 'SETTING.COMMODITY_CATEGORY', label: 'Commodity Category', actions: MASTER_DELETABLE },

  // Purchase & Sales lookups (docs/MODULE_PURCHASE_SALES.md §3.1, §6).
  // SETTING.INQUIRY_SOURCE is not in the spec's §6 list, but inquiry_source is
  // a §3.1 lookup with a Settings screen — without a permission its screen
  // could not be gated at all, so it is added on the same shape as the rest.
  { module: 'SETTING', feature: 'SETTING.GOODS_TYPE', label: 'Goods Type', actions: MASTER_DELETABLE },
  { module: 'SETTING', feature: 'SETTING.CONTAINER_SIZE', label: 'Container Size', actions: MASTER_DELETABLE },
  { module: 'SETTING', feature: 'SETTING.RATE_TIER', label: 'Rate Tier', actions: MASTER_DELETABLE },
  { module: 'SETTING', feature: 'SETTING.TOS', label: 'Terms of Shipment', actions: MASTER_DELETABLE },
  // The client's "Modes" screen. The values are Incoterms; the label follows
  // their wording so the menu matches what they asked for.
  { module: 'SETTING', feature: 'SETTING.MODE', label: 'Modes', actions: MASTER_DELETABLE },
  // One row of configuration, not a list — it is read and written, nothing else.
  { module: 'SETTING', feature: 'SETTING.NOTIFICATION', label: 'Notifications', actions: ['VIEW', 'EDIT'] },
  { module: 'SETTING', feature: 'SETTING.INQUIRY_SOURCE', label: 'Inquiry Source', actions: MASTER_DELETABLE },

  // -- 8. CRM ----------------------------------------------------------------
  { module: 'CRM', feature: 'CRM.CUSTOMER', label: 'Customer', actions: MASTER_DELETABLE },
  { module: 'CRM', feature: 'CRM.AGENT', label: 'Agent', actions: MASTER_DELETABLE },
  // Moved from Setting at the client's request: a vendor is a party you keep
  // a ledger against, like a customer or an agent, not a configuration value.
  // The migration renames the permission keys in place so existing grants survive.
  { module: 'CRM', feature: 'CRM.VENDOR', label: 'Vendor', actions: MASTER_DELETABLE },
  { module: 'CRM', feature: 'CRM.EMPLOYEE', label: 'Employee', actions: MASTER_DELETABLE },
  { module: 'CRM', feature: 'CRM.USER', label: 'User', actions: MASTER_DELETABLE },

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
