# MODULE SPEC — PURCHASE (Rate Management) & SALES (Inquiry)

**How to use this file.** Save it as `/docs/MODULE_PURCHASE_SALES.md` in the repo and start a Claude Code session with: *"Read CLAUDE.md, then read /docs/MODULE_PURCHASE_SALES.md. We are building Phase A."* CLAUDE.md still governs stack, tenancy, RBAC, screen patterns and design tokens. This file only adds the new module. Where the two disagree, CLAUDE.md wins — **except** where this file explicitly overrides it (§4 rule 1).

---

## 1. WHAT THIS MODULE DOES

This is the money layer of the ERP, and it is the reason the whole system exists:

```
Buy a rate from a carrier  →  add profit  →  publish a sell price  →  a customer inquires
       PURCHASE                 ADD-ON            PRICE LIST              INQUIRY
                                                                             ↓
                                                                        QUOTATION
```

Three freight modes, each with the same three screens:

| Mode | Rate unit | Tier columns in the client wireframe |
|---|---|---|
| Sea FCL | per container | 20STD · 40STD · 40HC · 45FT |
| Sea LCL | per CBM | 0-5 · 5-10 · 10-15 · 15+ |
| Air | per KG | 100+ · 300+ · 500+ · 1000+ |

All nine purchase screens share the same columns: POL/AOL · POD/AOD · Carrier/Airlines · Goods type · four tier rates · POL Local Charges · Validity · Purchase via.

Everything here foreign-keys into Settings and CRM, which are already built. **Do not create a new port, carrier, currency, commodity or employee table. Reuse them.**

---

## 2. THE ONE ARCHITECTURAL DECISION — read before writing any schema

The wireframe shows four fixed rate columns per mode. **Do not model them as four fixed columns.** Build a normalized parent/child instead:

```
freight_rate        one row per lane + carrier + goods type + validity period
freight_rate_line   one row per tier      (buy price, profit, sell price)
rate_tier           the tier definitions, seeded per mode, editable in Settings
```

Why this is not over-engineering:

- Air freight in the real world needs more than four breaks — MIN, -45, +45, +100, +300, +500, +1000. The client listed four; the first airline contract will need seven. A wide table needs a migration and a UI rewrite. A child table needs one seed row.
- The client will add 45HC, 20RF, 40RF (reefer) or 20OT (open top) within the year.
- Reporting ("average buy price per TEU on Chittagong–Singapore") is trivial over rows and painful over four columns.
- Profit is stored per tier. With wide columns that means eight more columns, then twelve.

The UI still renders the four columns exactly as the client drew them. Pivot `rate_tier` rows into columns in the query layer. **The screen looks like the wireframe; the schema survives change.**

---

## 3. SCHEMA

Every table below inherits the CLAUDE.md §4 conventions: `tenant_id` first, `id`, `code`, `is_active`, audit columns, soft delete, composite uniques, composite tenant-safe FKs.

### 3.1 New lookup tables (seed these first — Settings module)

```
goods_type       id, tenant_id, name, description
                 seed: General Cargo, Dangerous Goods (DG), Reefer, Personal Effects, Project Cargo
container_type   id, tenant_id, code, name, teu_factor NUMERIC(4,2), sort_order
                 seed: 20STD(1.0), 40STD(2.0), 40HC(2.0), 45FT(2.25)
rate_tier        id, tenant_id, mode ENUM('SEA_FCL','SEA_LCL','AIR'), code, label,
                 unit ENUM('CONTAINER','CBM','KG'), min_value, max_value, sort_order
                 seed SEA_FCL: 20STD, 40STD, 40HC, 45FT      (unit CONTAINER, linked to container_type)
                 seed SEA_LCL: 0-5, 5-10, 10-15, 15+          (unit CBM)
                 seed AIR:     100+, 300+, 500+, 1000+        (unit KG)
tos              id, tenant_id, code, name        Terms of Shipment
                 seed: CY/CY, CY/CFS, CFS/CY, CFS/CFS, Door/Door, Door/CY, CY/Door
inquiry_source   id, tenant_id, name
                 seed: Direct Call, Email, Website, Agent Referral, Existing Customer, Exhibition, Field Visit
```

### 3.2 Rate tables

```
freight_rate
  id, tenant_id, code (RATE-000001)
  mode              ENUM('SEA_FCL','SEA_LCL','AIR')
  pol_id            FK port      -- AOL when mode = AIR
  pod_id            FK port      -- AOD when mode = AIR
  carrier_id        FK carrier   -- filtered to type Airline when mode = AIR
  goods_type_id     FK goods_type
  purchase_source_type ENUM('CARRIER','VENDOR','AGENT')   -- "Purchase via"
  purchase_source_id   BIGINT     -- FK resolved by type; see §9 Q3
  currency_id       FK currency  -- default USD
  valid_from        DATE NOT NULL
  valid_to          DATE NOT NULL
  transit_days      INT NULL
  remarks           TEXT
  status            ENUM('DRAFT','PUBLISHED','EXPIRED')  -- EXPIRED set by nightly job
  CHECK (valid_to >= valid_from)
  INDEX (tenant_id, mode, pol_id, pod_id, valid_to)

freight_rate_line
  id, tenant_id, rate_id FK, tier_id FK rate_tier
  buy_price     NUMERIC(18,4) NOT NULL
  profit_type   ENUM('FLAT','PERCENT') NOT NULL DEFAULT 'FLAT'
  profit_value  NUMERIC(18,4) NOT NULL DEFAULT 0
  sell_price    NUMERIC(18,4) GENERATED ALWAYS AS (
                  CASE WHEN profit_type = 'FLAT'
                       THEN buy_price + profit_value
                       ELSE buy_price * (1 + profit_value / 100) END) STORED
  UNIQUE (tenant_id, rate_id, tier_id)

rate_local_charge          -- "POL Local Charges", broken down, not a lump sum
  id, tenant_id, rate_id FK, cost_head_id FK cost_head,
  side ENUM('POL','POD'), amount NUMERIC(18,4), currency_id FK,
  unit_id  -- follows the cost_head's unit (Container / CBM / KG / HBL / Trip …)

rate_profit_log            -- who changed a margin, when, from what
  id, tenant_id, rate_line_id FK, old_profit_type, old_profit_value,
  new_profit_type, new_profit_value, changed_by, changed_at, reason
```

Both profit methods are supported because the client asked for both — flat amount per unit and percentage of buy price, chosen per rate line. `sell_price` is a generated column: never write it by hand, never let the frontend compute and post it.

### 3.3 Inquiry tables

```
inquiry
  id, tenant_id, inquiry_no (INQ-2026-000001, per tenant per year), inquiry_date
  source_id         FK inquiry_source
  shipment_type     ENUM('SEA','AIR')
  customer_id       FK customer
  movement_type     ENUM('INBOUND','OUTBOUND')
  pol_id, pod_id    FK port
  place_of_receipt  TEXT
  commodity_item_id FK commodity_item
  hs_code           TEXT            -- prefilled from commodity_item, editable
  tos_id            FK tos
  target_price      NUMERIC(18,4), currency_id FK
  expected_shipment_date DATE
  valid_to          DATE            -- "Inquiry Valid Upto"
  weight_kg         NUMERIC(18,3)
  remarks           TEXT
  salesman_id       FK employee
  status            ENUM('OPEN','QUOTED','WON','LOST','EXPIRED','CANCELLED') DEFAULT 'OPEN'

inquiry_volume            -- the Volume row: 20STD | 40STD | 40HC | 45FT | LCL | Air
  id, tenant_id, inquiry_id FK, container_type_id FK NULL,
  volume_kind ENUM('FCL','LCL','AIR'), quantity INT NULL,
  cbm NUMERIC(18,3) NULL, weight_kg NUMERIC(18,3) NULL

inquiry_followup          -- drives the "Follow Up(2)" counter in the list
  id, tenant_id, inquiry_id FK, followup_date, contact_mode ENUM('CALL','EMAIL','VISIT','WHATSAPP'),
  contact_person, notes TEXT, next_followup_date DATE, created_by

inquiry_rate               -- the "Price" action: rates attached to an inquiry
  id, tenant_id, inquiry_id FK, rate_id FK, rate_line_id FK,
  quoted_price NUMERIC(18,4), is_selected BOOLEAN, added_by, added_at
```

### 3.4 Quotation — schema stub only

The client's Quotation sheet stops after six fields (Inquiry No, Quotation Date, Validity Date, Shipment Type, TOS, Mode). Create the table stub and the inquiry → quotation link, then stop. Do not design charge lines, terms, or the print layout — that spec has not arrived. See §9 Q11.

---

## 4. BUSINESS RULES

1. **Rates are versioned, never overwritten** — this overrides the Settings pattern. The wireframe's Action column says Edit | Delete. Implement Edit as: supersede the current row (set `valid_to` = yesterday, `status` = EXPIRED) and insert a new row. Implement Delete as a soft delete. A quotation issued last month must still resolve to the rate that was live when it was issued — if you mutate rate rows in place, every historical quotation and invoice silently becomes wrong. **This is the single most expensive mistake available in this module.**
2. **"By default all valid rates appear."** Price List screens default to `valid_from <= today <= valid_to AND status = 'PUBLISHED'`. Expired rates are reachable only via an explicit "Include expired" toggle, and render in `--steel`.
3. A **nightly job** flips status to EXPIRED where `valid_to < today`. Rates expiring within 7 days show a `--signal` dot on the list, so the pricing team re-buys before the gap.
4. **Sell price = buy + profit, computed by the database.** Never in the frontend, never in the API.
5. **Buy price is restricted data.** Sales staff quoting a customer see `sell_price` only. Gate the buy price and the profit columns behind `PURCHASE.RATE.VIEW_BUY_PRICE` — and **strip them from the API response** when the permission is absent. Hiding a column in React while the JSON still carries the margin is not access control; the whole company's margin is one devtools tab away.
6. Only admin or the price team may set profit (the client stated this). Enforced by `PURCHASE.RATE.MANAGE_PROFIT`, and every change writes to `rate_profit_log`.
7. **Multi-POD search.** Add-on and Price List screens filter by many PODs at once (`pod_id IN (...)`) — the wireframe notes this twice.
8. **Uniqueness.** One active rate per `(tenant_id, mode, pol_id, pod_id, carrier_id, goods_type_id, purchase_source_id)` with overlapping validity. Enforce with a Postgres exclusion constraint on a daterange, and give a clear error: *"A rate already exists for this lane and carrier until 31 Dec 2026. Edit that rate or set a later start date."*
9. **Air mode uses airport ports and airline carriers.** Filter `port.type = 'AIRPORT'` and `carrier.type = 'Airline'`; sea modes filter SEAPORT and MLO/NVOCC/SOC. Enforce server-side — a filtered dropdown is a convenience, not a constraint.
10. **Salesmen see their own inquiries by default.** `SALES.INQUIRY.VIEW_ALL` widens it to the whole team. This is row-level scope, not a new permission action — implement it as a reusable scope: `OWN | ALL` on the permission check, because Quotation, Shipment and Invoice will all need the same thing.
11. Inquiry **auto-expires** when `valid_to < today` and status is still OPEN.
12. **Export** (Price List Download) produces Excel and PDF of exactly the filtered rows the user is looking at, respecting rule 5 — never include buy price or profit in an export the user isn't permitted to see. Gate behind `.EXPORT`.

---

## 5. SCREENS

All follow CLAUDE.md §8 patterns and §12 design tokens. Rates and volumes render in IBM Plex Mono with tabular figures, right-aligned.

### 5.1 Purchase entry — SF Purchase FCL, SF Purchase LCL, AF Purchase

Top: an **inline add row** matching the table columns exactly (POL · POD · Carrier · Goods type · 4 tier inputs · POL Local Charges · Validity · Purchase via) with an ADD button. Below: the list of existing rates with Edit | Delete per row.

- POL Local Charges opens a small side panel to add cost-head lines (§3.2 `rate_local_charge`); the cell displays the total with a line count beneath it.
- Validity is a date range picker, and the two dates always travel together.
- Keyboard-first: Tab across the add row, Enter submits. The pricing team enters dozens of lanes in a sitting and will not reach for the mouse.

### 5.2 Price Add-on — SF PRICE ADD-FCL, SF Price ADD-on LCL, AF Price Add-on

Search by POL · POD (multi) · Carrier · Goods type. Results show **two stacked rows per rate**: buy price (read-only) above, profit (editable) below, per tier — exactly as drawn. A per-row toggle picks Flat or Percent. Save / Update price commits all edited rows in one transaction.

Show the resulting sell price as quiet helper text under each profit input so the user sees the outcome before saving. Gate the whole screen behind `PURCHASE.RATE.MANAGE_PROFIT`.

### 5.3 Price List — SF FCL List, SF LCL List, AF Price List

The screen sales actually lives in. Search + multi-POD filter, valid rates by default, Download → Excel / PDF. Shows sell price. Buy price and profit columns appear only with `PURCHASE.RATE.VIEW_BUY_PRICE`. Sticky header and sticky POL/POD columns — these tables scroll wide.

### 5.4 New Inquiry

Fields in the client's order: Source · Shipment Type (Sea/Air) · Customer · Type of Movement (Inbound/Outbound) · POL · POD · Commodity + HS Code · Place of Receipt · TOS · Volume · Container Type · Target Price ($) · Expected Shipment Date · Inquiry Valid Upto · Weight in Kg · Remarks · Salesman.

- The `+ +` beside Customer is a **quick-add modal** creating a customer inline without leaving the form — gated by `CRM.CUSTOMER.CREATE`, and it must return to the inquiry with the new customer selected.
- Volume is a **small grid**, not six loose inputs: rows appear based on Shipment Type (FCL container types for Sea, a single CBM row for LCL, a KG row for Air).
- HS Code prefills from the selected commodity and stays editable.
- Salesman defaults to the logged-in user's employee record.

### 5.5 Inquiry List

Filters: From DT · To DT · Shipment Type · POL · POD · Salesman · Status. Columns: Inquiry No · Date · Customer · Shipment Type · POL · POD · Commodity · Required Container · Quoted Price · Valid to Date · Status · Action.

Actions per row — each is a distinct permission:

| Action | Behaviour |
|---|---|
| View | Read-only detail drawer |
| Edit | Edit form; blocked once status is WON |
| Price | Opens matching rates for that lane/mode/validity, lets the user attach one or more to the inquiry (`inquiry_rate`), and writes back Quoted Price |
| Follow Up(n) | Drawer listing follow-ups + add form. `n` is the live count from `inquiry_followup` |
| Quote | Creates a quotation from the inquiry and sets status QUOTED |

Status renders as the §12 dot: OPEN steel · QUOTED signal · WON verified · LOST/EXPIRED alert.

---

## 6. PERMISSIONS TO REGISTER

Add to the permission constant; the superadmin matrix picks them up automatically.

```
PURCHASE.SF_FCL          VIEW CREATE EDIT DELETE
PURCHASE.SF_LCL          VIEW CREATE EDIT DELETE
PURCHASE.AIR             VIEW CREATE EDIT DELETE
PURCHASE.ADDON_FCL       VIEW EDIT
PURCHASE.ADDON_LCL       VIEW EDIT
PURCHASE.ADDON_AIR       VIEW EDIT
PURCHASE.PRICE_LIST_FCL  VIEW EXPORT
PURCHASE.PRICE_LIST_LCL  VIEW EXPORT
PURCHASE.PRICE_LIST_AIR  VIEW EXPORT
PURCHASE.RATE            VIEW_BUY_PRICE MANAGE_PROFIT     ← cross-cutting, column-level
SALES.INQUIRY            VIEW CREATE EDIT VIEW_ALL FOLLOWUP ATTACH_PRICE CONVERT_QUOTE
SETTING.GOODS_TYPE       VIEW CREATE EDIT TOGGLE_STATUS
SETTING.CONTAINER_TYPE   VIEW CREATE EDIT TOGGLE_STATUS
SETTING.RATE_TIER        VIEW CREATE EDIT TOGGLE_STATUS
SETTING.TOS              VIEW CREATE EDIT TOGGLE_STATUS
```

Suggested role templates: **Pricing Team** (purchase + add-on + buy price + profit), **Sales Executive** (price list view/export, own inquiries, no buy price), **Sales Manager** (same plus VIEW_ALL, no profit rights).

---

## 7. BUILD ORDER FOR CLAUDE CODE

One phase per session. Do not start a phase until the previous one is verified.

| Phase | Prompt | Done when |
|---|---|---|
| A | "Add the §3.1 lookup tables + their Settings screens, following the Sea-Air Port reference implementation." | 5 lookups seeded and editable |
| B | "Add the §3.2 rate schema. Show me the Prisma schema and the exclusion constraint before the migration." | Migration reviewed and applied |
| C | "Build SF Purchase FCL end to end — API, inline add row, list, local-charge panel, permissions. This is the reference implementation for all nine purchase screens." | One screen fully working |
| D | "Build SF Price Add-on FCL, including profit type toggle, `rate_profit_log`, and buy-price stripping in the API per §4 rule 5." | Margin logic correct |
| E | "Build SF FCL List with multi-POD filter, validity defaults, and Excel/PDF export." | Sales can pull a price list |
| F | "Clone C–E to Sea LCL and Air, driven by `rate_tier`. No copy-pasted screen components." | 9 screens, 1 component set |
| G | "Add the §4 rule 1 supersede-on-edit logic and the nightly expiry job, with tests." | Rate history provable |
| H | "Build §3.3 inquiry schema + New Inquiry form, including the customer quick-add." | Inquiry captured |
| I | "Build Inquiry List with all five row actions and the `OWN\|ALL` scope from §4 rule 10." | Sales can work the pipeline |
| J | "Create the §3.4 quotation stub table and the Quote action link only. Stop there." | Ready for the next spec |

Write tests in phase D and G specifically. Margin calculation and rate versioning are where a silent bug costs the client real money, and neither is visible from the UI.

---

## 8. WHAT CONNECTS TO WHAT (verify before coding)

```
port          → freight_rate.pol_id / pod_id, inquiry.pol_id / pod_id
carrier       → freight_rate.carrier_id, (vessel already links here)
vendor/agent  → freight_rate.purchase_source_id
currency      → freight_rate.currency_id, inquiry.target_price
cost_head     → rate_local_charge.cost_head_id       (unit comes from cost_head)
commodity_item→ inquiry.commodity_item_id            (HS code prefill)
customer      → inquiry.customer_id
employee      → inquiry.salesman_id
user          → rate_profit_log.changed_by, inquiry_followup.created_by
```

If any of these FK targets does not already exist in the built schema, **stop and report it** rather than creating a duplicate table.

---

## 9. OPEN QUESTIONS — ask the client before the affected phase

**Answered 17 Aug 2026 — phase A–B unblocked:**

1. **Goods type** — ~~separate list or reuse Industry Sector?~~
   **Separate list.** Goods type says how the cargo must be *handled* (a reefer
   rate and a DG rate differ regardless of what is in the box); industry sector
   says what the customer *ships*. Built in phase A.
2. **POL Local Charges** — ~~lump sum or breakdown?~~
   **A breakdown by cost head**, per `rate_local_charge` in §3.2. It is the only
   shape that lets Accounts itemise THC, documentation and seal separately.
   Currency: each charge line carries its own `currency_id`, so local charges may
   sit in BDT while the freight is in USD.
3. **Purchase via** — ~~carrier, vendor, agent or free text?~~
   **All three, as a typed FK**: `purchase_source_type ENUM('CARRIER','VENDOR','AGENT')`
   plus `purchase_source_id`, with exactly one of the three concrete FK columns
   set. Covers buying direct from a line, through a coloader, and via an agent.
4. **Rate currency** — ~~USD only or mixed?~~
   **Any currency, USD the default.** Every amount carries `currency_id`
   (CLAUDE.md §4 rule 6), and the Price List gets a display-currency selector
   converting through the `currency` table.
6. **Minimum charge** — ~~needed for LCL and Air?~~
   **Yes** — carried on the rate line, so an LCL rate can bill a minimum 1 CBM and
   an air rate can carry a MIN below its first weight break. Added in phase B
   rather than after quotation maths depends on it.

**Blocking phase C–F:**

5. **Air weight breaks** — the sheet shows four (100+, 300+, 500+, 1000+). Real airline tariffs normally include a MIN charge and -45 / +45 breaks. Should the seed include those?
7. **Same lane, two carriers, same period** — allowed (the buyer compares) or blocked? §4 rule 8 assumes allowed, since carrier is part of the uniqueness key.
8. Who is the **"price team"** — a fixed role, or a permission granted per user? §6 assumes a role template plus per-user override, per the existing RBAC.

**Blocking phase H–J:**

9. **Inquiry No format** — INQ-2026-000001? Restart numbering each year? Any client-specific prefix?
10. **Inquiry status list** — is OPEN / QUOTED / WON / LOST / EXPIRED / CANCELLED right, and who may set WON/LOST?
11. **Quotation screen is incomplete** — the sheet stops after six fields. Needed before phase J+: charge lines (freight + local charges + which cost heads), terms & conditions, approval flow, print/PDF layout, and whether one inquiry can produce multiple quotation versions.
12. **New Sales Lead** and **Sales Lead follow up** appear on the Menu but have no wireframe in this workbook. Is a lead a pre-inquiry stage (no lane yet), or the same record? This decides whether `inquiry` gets a `lead_id` FK now.

**Worth raising even though nothing blocks on it:**

13. **Transit time and free days on the Price List** — ~~show them?~~
    **Both, answered 17 Aug 2026.** `transit_days` already existed on
    `freight_rate`; `free_days` was added as a nullable column in phase E, before
    the pricing team had keyed in enough lanes for a backfill to hurt. Both are
    inputs on the entry row and columns on the Price List.
