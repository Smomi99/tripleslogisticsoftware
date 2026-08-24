# MODULE SPEC — INQUIRY → QUOTATION

> **How to use.** Save as `/docs/MODULE_INQUIRY_QUOTATION.md`. Start a Claude Code session with:
> *"Read CLAUDE.md, then /docs/MODULE_INQUIRY_QUOTATION.md. We are building Phase A. Show me the
> schema before any migration."*
> `CLAUDE.md` governs stack, tenancy, RBAC, screen patterns and design tokens.
> This file **supersedes the inquiry section** of `/docs/MODULE_PURCHASE_SALES.md` — see §3.

---

## 1. THE FLOW

```
NEW INQUIRY ──┬─ Outbound, rate exists  → Price Check → Quotation
              │
              ├─ Outbound, no valid rate → email Price Team → (they buy) → Quotation
              │
              └─ Inbound → share to country agents → RFQ on agent portal
                                   → agents quote → we pick cheapest → Quotation
                                                          ↓
                                              winner sees "Won"
                                              others see "Business Lost"

QUOTATION → Save & Send (PDF by email) → QUOTATION LIST → Booking → [next module]
```

The client's full chain, for context — **stop this module at Quotation**:
`Quotation > Shipment Booking > Shipment Approval > Shipping Order > Cargo Receipt > CLP > Stuffing
> Shipment Advise > EGM > SI Submission > BL Issue > Debit Note`

---

## 2. THREE THINGS THAT CHANGE THE ARCHITECTURE

Read these before writing any code. Each one is cheap now and a rewrite later.

### 2.1 The software now has external users

The Menu sheet defines separate navigation for **Agent** (`RFQ`) and **Customer** (`Inquiry List`,
`Quotation List`, `Shipment Booking`, `Shipment Approval`). Agents log in to quote on inquiries;
customers log in to see their own inquiries and quotations. These are not staff.

Add to the existing `user` table:

```
user
  user_type   ENUM('INTERNAL','AGENT','CUSTOMER') NOT NULL DEFAULT 'INTERNAL'
  party_id    BIGINT NULL     -- agent.id when AGENT, customer.id when CUSTOMER
  CHECK (user_type = 'INTERNAL' OR party_id IS NOT NULL)
```

Rules, enforced server-side in a base guard — not per-endpoint:

1. An `AGENT` user sees only inquiries explicitly shared with their agent record, and only their own
   quotes. A `CUSTOMER` user sees only rows where `customer_id = their party_id`.
2. **Agents must never see the customer's identity.** The RFQ screen in the wireframe deliberately
   omits the Customer column — that is a business rule, not a layout choice. If an agent can see who
   the shipper is, they can approach them directly and cut the forwarder out. Strip
   `customer_id`, customer name, and salesman from every payload served to an `AGENT` user.
3. Agents must not see each other's quotes, or the count of competing quotes.
4. Agent and customer logins are created from the existing `agent_pic` / `customer_pic` records —
   invite by email, they set their own password. Do not build a separate credentials table.
5. Portal users get their own navigation tree, not the internal sidebar with items hidden.

**Isolation tests are mandatory here**, in the same style as the tenancy tests: seed two agents and
one customer, then assert that each sees exactly their own rows and no customer identity leaks.

### 2.2 A quotation is a legal document — snapshot everything

The quotation PDF goes to a customer and is binding for its validity period. If a cost head is
renamed, a rate expires, or the USD rate moves tomorrow, **the quotation issued today must not
change**.

So `quotation_line` stores its own copies of `cost_head_name`, `unit_name`, `selling_price`,
`currency_code` and `conversion_rate` — not just FK ids. Keep the FKs too, for reporting. This is
deliberate denormalization, and it is the correct call here: normalizing a document to live
references means every historical quotation silently rewrites itself over time.

The `Booking Rate` column (`129` in the sample) is the USD→BDT conversion **frozen at quotation
time**. Copy it from `currency` when the quotation is created, then never re-read it.

### 2.3 Email becomes core infrastructure, not a side effect

This module sends mail in three places: agent RFQ notification, price-team alert, and the quotation
itself. Build it once, properly:

```
email_template   id, tenant_id, key, subject, body_html, variables
email_log        id, tenant_id, template_key, to_addresses, cc, subject, body_html,
                 related_type, related_id, status ENUM('QUEUED','SENT','FAILED'),
                 error, attempts, sent_at
```

Queue and retry (BullMQ or equivalent). **Never send inline in a request handler** — a slow SMTP
server must not make Save & Send time out, and a failed send must not roll back a saved quotation.
Every send is logged and visible on the record.

---

## 3. CORRECTIONS TO EARLIER SPECS

The new workbook answers open questions and changes prior assumptions. Apply these:

| Item | Earlier spec | Correct now |
|---|---|---|
| **TOS** | Seeded CY/CY, CFS/CFS, Door/Door | **Incoterms**: EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DPU, DAP, DDP. Reseed. |
| **Goods Type** | Open question | Confirmed separate list: **Textile, Non-Textile, DG** |
| **Container Type** | Not specified | **Dry, Flat Rack, Open Top, Reefer** — per container line, not per inquiry |
| **Commodity** | Single FK | **Multi-select** — many commodities per inquiry |
| **Loading Type** | Not present | New field: **FCL / LCL** (separate from Shipment Type Sea/Air) |
| **Menu: Inquiry List** | — | Renamed **Live Inquiry** |
| **Menu: Vendor** | Under Setting | Moved to **CRM** |
| **Menu: Customer Service** | — | Now: Quotation, Quotation List, Shipment Booking, Shipment Booking List, Shipment Approval, Shipping Order |
| **`Table_Inquiry_Details`** | — | Client drew it wide (`Required_container_20STD`, `_40STD`, `_Type`, `_Weight`, `_TP`, ~24 columns). **Normalize to rows** — same argument as rate tiers in the Purchase spec. The UI still renders the client's grid. |

---

## 4. SCHEMA

All tables inherit `CLAUDE.md` §4 conventions: `tenant_id` first, `code`, `is_active`, audit
columns, soft delete, composite tenant-safe FKs.

### 4.1 Lookups to add / reseed

```
goods_type        reseed: Textile, Non-Textile, DG
container_type    reseed: Dry, Flat Rack, Open Top, Reefer     -- the physical type
tos               reseed as Incoterms (11 values above), with incoterm_year
transit_type      Direct, Indirect                              -- or ENUM
```

Note `container_type` (Dry/Reefer/Flat Rack) is **different** from container **size**
(20STD/40STD/40HC/45FT). Size lives in `rate_tier` / `container_size`. Keep them separate — the
earlier spec conflated them.

### 4.2 Inquiry

```
inquiry                                            -- client: Table_Inquiry
  id, tenant_id, code, inquiry_no (INQ-2026-000001)
  inquiry_date        DATE
  source_id           FK inquiry_source
  shipment_type       ENUM('SEA','AIR')
  customer_id         FK customer
  movement_type       ENUM('INBOUND','OUTBOUND')
  pol_id, pod_id      FK port
  goods_type_id       FK goods_type
  place_of_receipt    TEXT
  tos_id              FK tos
  loading_type        ENUM('FCL','LCL')
  weight_kg           NUMERIC(18,3)
  target_price        NUMERIC(18,4), currency_id FK
  expected_shipment_date DATE
  valid_to            DATE                          -- Inquiry Valid Upto
  remarks             TEXT
  salesman_id         FK employee
  status              ENUM('OPEN','RFQ_SENT','PRICED','QUOTED','WON','LOST','EXPIRED','CANCELLED')
  won_agent_id        FK agent NULL                 -- set when we win via an agent
  won_at              TIMESTAMPTZ NULL

inquiry_commodity                                  -- multi-select
  id, tenant_id, inquiry_id FK, commodity_item_id FK, hs_code TEXT

inquiry_container                                  -- client: Table_Inquiry_Details, normalized
  id, tenant_id, inquiry_id FK
  size_code           TEXT     -- '20STD' | '40STD' | '40HC' | '45FT' | 'LCL' | 'AIR'
  quantity            INT NULL           -- containers
  cbm                 NUMERIC(18,3) NULL -- when LCL
  weight_kg           NUMERIC(18,3) NULL -- per line  (client: _Weight)
  container_type_id   FK container_type NULL        -- Dry/Reefer/etc (client: _Type)
  target_price        NUMERIC(18,4) NULL            -- client: _TP
  UNIQUE (tenant_id, inquiry_id, size_code)

inquiry_agent_share                                -- who this inquiry was sent to
  id, tenant_id, inquiry_id FK, agent_id FK, agent_pic_id FK NULL,
  shared_at, shared_by, notified_at, email_log_id FK NULL,
  status ENUM('SHARED','VIEWED','QUOTED','WON','LOST')

inquiry_followup                                   -- client: Table_Inquiry_Follow_Up
  id, tenant_id, inquiry_id FK, comments TEXT, followup_status,
  followup_date, next_followup_date, created_by
```

### 4.3 Agent quote (the RFQ response)

An agent may submit **more than one option** per inquiry — the wireframe shows two rate blocks on
one form.

```
agent_quote
  id, tenant_id, code, inquiry_id FK, agent_id FK, option_no INT
  carrier_id      FK carrier
  transit_time    TEXT        -- T/T
  via             TEXT
  pod_free_days   INT
  validity_date   DATE
  etd, eta        DATE
  remarks         TEXT
  total_amount    NUMERIC(18,4), currency_id FK
  status          ENUM('SUBMITTED','SHORTLISTED','WON','LOST')
  submitted_at, submitted_by

agent_quote_line
  id, tenant_id, agent_quote_id FK, cost_head_id FK,
  container_size TEXT NULL, unit_id FK, qty NUMERIC(18,3),
  unit_price NUMERIC(18,4), currency_id FK,
  total_amount NUMERIC(18,4) GENERATED ALWAYS AS (qty * unit_price) STORED
```

### 4.4 Quotation

```
quotation                                          -- client: Table_Quotation
  id, tenant_id, code, quotation_no (QTN-2026-000001)
  inquiry_id        FK inquiry NOT NULL            -- client marks Inquiry No mandatory
  revision_no       INT DEFAULT 1
  quotation_date    DATE, validity_date DATE
  -- snapshot of the inquiry header at issue time:
  customer_id FK, shipment_type, movement_type, pol_id, pod_id,
  goods_type_id, place_of_receipt, loading_type, tos_id, mode TEXT,
  carrier_id FK, first_vessel_id FK NULL,
  transit_type ENUM('DIRECT','INDIRECT'),
  etd DATE, eta DATE,
  local_currency_id FK, conversion_rate NUMERIC(18,4),   -- frozen; client: Booking Rate
  source_agent_quote_id FK agent_quote NULL,             -- when built from an agent's price
  total_amount_usd   NUMERIC(18,4),
  total_amount_local NUMERIC(18,4),
  amount_in_words    TEXT,
  status ENUM('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED')
  sent_at, sent_by

quotation_line                                     -- client: Table_Quotation_Details
  id, tenant_id, quotation_id FK, line_group ENUM('STANDARD','ADDITIONAL'), sort_order
  cost_head_id FK, cost_head_name TEXT,            -- snapshot
  container_size TEXT NULL,                        -- '20STD' | 'No size'
  unit_id FK, unit_name TEXT,                      -- snapshot
  qty NUMERIC(18,3),
  selling_price NUMERIC(18,4),
  currency_id FK, currency_code TEXT,              -- snapshot
  total_amount NUMERIC(18,4) GENERATED ALWAYS AS (qty * selling_price) STORED,
  conversion_rate NUMERIC(18,4),                   -- snapshot
  bill_amount_local NUMERIC(18,4) GENERATED ALWAYS AS (qty * selling_price * conversion_rate) STORED,
  source ENUM('AUTO','MANUAL')                     -- pulled from price table vs typed
  price_source_rate_line_id FK freight_rate_line NULL

quotation_recipient
  id, tenant_id, quotation_id FK, email, kind ENUM('TO','CC'), source ENUM('CUSTOMER','MANUAL')

quotation_followup
  id, tenant_id, quotation_id FK, comments, followup_date, next_followup_date, created_by
```

Both generated columns match the client's arithmetic exactly: `Total Amount ($) = Qty × Selling
Price`, `Bill Amount = Total × Booking Rate`. Verify against the sample: 2 × 5252 = 10504,
10504 × 129 = 1,355,016. ✓

---

## 5. BUSINESS RULES

### 5.1 Inquiry routing — build this as one explicit service, not scattered ifs

On inquiry save, run `InquiryRoutingService`:

```
if movement_type = INBOUND:
    → list agents whose country matches the POL country          (CRM agent master)
    → user selects one or more; write inquiry_agent_share
    → queue an email to each selected agent PIC: "an inquiry is available for quotation"
    → inquiry appears on those agents' RFQ screen
    → status = RFQ_SENT
    → EXCEPTION: if a valid rate already exists for the lane, skip the email entirely
      (the client states this explicitly — do not spam agents for lanes we can already price)

if movement_type = OUTBOUND:
    → look for a valid rate: matching mode, POL, POD, goods type, today within validity
    → found     → status = PRICED, show it on Price Check
    → not found → queue an email to the Price Team role:
                  "no valid rate for <lane>, please obtain from carrier"
                  status stays OPEN, flag the inquiry as awaiting-rate
```

The Price Team recipient resolves from the **role**, not a hardcoded address — everyone holding
`PURCHASE.RATE.MANAGE_PROFIT` in that tenant.

### 5.2 Win / loss

When the business is won through an agent, the user picks the winning agent on the inquiry
(the wireframe's "Agent:" field, visible only after Won).

- `inquiry.status = WON`, `won_agent_id` set
- winning `agent_quote.status = WON` → that agent's portal shows **Won**
- every other quoting agent's status = `LOST` → their portal shows
  *"Business Lost — your price was not competitive"* (client's exact intent; keep the wording
  professional and identical for all losers)
- **Never reveal the winning price, the winning agent's name, or how many agents quoted.**

### 5.3 Quotation build

1. `Inquiry No` is mandatory — a quotation cannot exist without an inquiry.
2. On selecting the inquiry, **copy the header down** (customer, lane, goods type, commodity, HS
   code, TOS, loading type). Editable afterwards; edits do not write back to the inquiry.
3. **Auto-pull the lines**: match the price table on `POL + POD + Goods Type + Carrier`, pull every
   cost head with a selling price, and create one line per applicable container size using the
   quantities from `inquiry_container`. Mark them `source = AUTO`.
4. The user can add any other cost head manually (`line_group = ADDITIONAL`, `source = MANUAL`).
5. **If no selling price exists, the field is editable and the user types it.** Never block the
   quotation because the price table is incomplete — flag the line instead.
6. Totals are the sum of the lines, in USD and local currency. Recompute on every line change; store
   the result on the quotation for the PDF.
7. `Amount in words` is generated from the USD total on save.
8. **Editing a SENT quotation creates revision 2**, marks revision 1 `SUPERSEDED`, and keeps both.
   Quotation numbers do not get reused.
9. On send: status → `SENT`, inquiry → `QUOTED`, PDF generated and attached, `email_log` written.

### 5.4 Currency

Freight in USD, billing in BDT. Every line carries its own `conversion_rate` snapshot so a
multi-currency quotation still totals correctly. The rate defaults from the `currency` master at
creation and is editable before sending, never after.

---

## 6. SCREENS

Follow `CLAUDE.md` §8 patterns and §12 tokens. All money, rates, quantities and dates in IBM Plex
Mono with tabular figures, right-aligned.

### 6.1 New Inquiry — internal

Client's field order: Source · Shipment Type · Customer · Type of Movement · POL · POD · Goods Type ·
Commodity (multi) + HS Code · Place of Receipt · TOS · Loading Type · **Required container grid** ·
Weight in Kg · Target Price ($) · Expected Shipment Date · Inquiry Valid Upto · Remarks · Salesman ·
Share to Agent/Carrier · Email ID · `Save`.

The **Required container grid** is the heart of the form — one row per size:

| Size | Qty / CBM / Kg | Container Type | Weight (kg) | Target Price |
|---|---|---|---|---|
| 20STD · 40STD · 40HC · 45FT | qty | Dry/Flat Rack/Open Top/Reefer | | |
| LCL (CBM) | cbm | — | | |
| Air (Kg) | kg | — | | |

Show FCL size rows when `Loading Type = FCL`, the LCL row when LCL, the Air row when
`Shipment Type = AIR`. Rows the user leaves blank are not persisted.

`Share to Agent / Carrier` appears **only when movement = Inbound**, listing agents whose country
matches the POL country, with their PIC and email prefilled and editable.

### 6.2 Live Inquiry (internal list)

Columns: Inquiry No · Date · Customer · Commodity · Shipment Type · POL/AOL · POD/AOD ·
Required Container (rendered `20STD(1) + 40HC(1)`) · Quotation (`View` / `—`) · Valid to Date ·
Status · Action.

Actions: `View` · `Edit` · `Price` · `Follow up` · `Quote` · **`Carrier Position`**.

`Carrier Position` opens the lane ranking from `carrier_port_pair` (CR-001) for this inquiry's
POL→POD — cheapest-first and best-service-first. This is what those rankings were built for.

### 6.3 Price Check

Reached from `Price`. Shows every matching rate for the lane, **multiple carriers stacked** so the
user compares: POL · POD · Carrier · Goods type · size columns · POL Local Charges · Validity ·
Remarks · Purchase via. `Back to List`. Selecting a row carries the carrier and prices into the
quotation.

### 6.4 RFQ — agent portal

List: Inquiry No · Date · Commodity · Shipment Type · POL/AOL · POD/AOD · Required Container ·
Valid to Date · Quotation · Status · Action (`View` · `Quote`).
**No Customer column, no salesman, no target price.**

Quote form — repeatable option blocks, each with:
- line grid: Carrier · Cost Head · Container Size · Unit · Qty · Unit Price · Currency · Total Amount
- routing strip: T/T · Via · POD Free Day · Validity · ETD · ETA · Remarks
- `Submit`

After submission the agent sees their own quote read-only, plus any comments, and finally
**Won** or **Business Lost — your price was not competitive**.

### 6.5 Quotation

Header block in the client's layout: Quotation Date · Validity Date · Inquiry No (mandatory) ·
Shipment Type · Customer · Type of Movement · POL · POD · Goods Type · Commodity · Place of Receipt ·
HS Code · Loading Type · TOS · Mode · Local Currency · Carrier · First Vessel · Transit Type ·
ETD · ETA.

Line grid: Cost Head · Container Size · Unit · Qty · Selling Price · Currency · Total Amount ($) ·
Booking Rate · Bill Amount (Local) · `Edit | Delete`. A separate **Additional Charge** section below,
same columns. Totals row pinned at the bottom, both currencies.

Auto-pulled lines carry a small `--steel` "from price list" marker; manually priced lines carry a
`--signal` marker so the pricing team can see what was typed by hand.

Footer: `Insert Email ID` (prefilled from the customer record, more addable) · `Save & Send`.

### 6.6 Quotation PDF

Header `TRIPLE S LOGISTICS` (from tenant settings — logo and name must come from the tenant, not be
hardcoded) · `QUOTATION` · Inquiry No + Date · Quotation No + Date · Valid Till · `To,` + customer
block · the full header field set · the line table with Conversion Rate · totals · **In word (USD)**.

Standard notes, stored as editable tenant text, not hardcoded:
1. This is a quotation only; the final freight invoice follows the shipment.
2. Excludes all VAT & TAX; if TDS is deducted, 1% is added to total invoice value.
3. Payment before BL release by pay order, cash, or online transfer.

Then `For and on behalf of` + tenant name. `Back to list`.

### 6.7 Quotation List

Inquiry No · Quotation No · Quotation Date · Customer · Commodity · Shipment Type · POL/AOL ·
POD/AOD · Required Container · Valid to Date · Status · Action (`View` · `Edit` · `Follow up` ·
`Booking`). `Booking` is the hand-off to the next module — wire the button, route it to a
placeholder for now.

---

## 7. PERMISSIONS

```
SALES.INQUIRY            VIEW CREATE EDIT VIEW_ALL FOLLOWUP PRICE_CHECK CARRIER_POSITION
                         SHARE_AGENT CONVERT_QUOTE SET_WON_LOST
CS.QUOTATION             VIEW CREATE EDIT DELETE SEND FOLLOWUP EXPORT_PDF VIEW_ALL
CS.QUOTATION_LINE        ADD_ADDITIONAL MANUAL_PRICE      -- typing a price by hand is privileged
PORTAL.RFQ               VIEW QUOTE                        -- agent portal only
PORTAL.CUSTOMER          VIEW_INQUIRY VIEW_QUOTATION       -- customer portal only
SETTING.GOODS_TYPE / CONTAINER_TYPE / TOS   VIEW CREATE EDIT TOGGLE_STATUS
```

Role templates: **Sales Executive** (own inquiries, no manual price), **Sales Manager**
(`VIEW_ALL`, `SET_WON_LOST`), **Pricing Team** (price check, manual price), **Agent Portal**
(`PORTAL.RFQ.*` only), **Customer Portal** (`PORTAL.CUSTOMER.*` only).

Portal roles are system roles — the tenant superadmin may view them but must not be able to add
internal permissions to them.

---

## 8. BUILD ORDER

| Phase | Prompt | Done when |
|---|---|---|
| A | "Reseed the §4.1 lookups (TOS as Incoterms, goods type, container type) and correct the earlier seeds." | Lookups match §3 |
| B | "Add §2.1 portal user support: `user_type`, `party_id`, the base scoping guard, agent/customer invite flow. Write the isolation tests first." | An agent user sees nothing but their shares |
| C | "Add §2.3 email infrastructure — templates, queue, `email_log`, retry. One test template." | A queued mail sends and logs |
| D | "Add the §4.2 inquiry schema and the New Inquiry form with the container grid." | Inquiry saves with containers + commodities |
| E | "Build `InquiryRoutingService` per §5.1, with tests for all three branches." | Inbound shares, outbound alerts |
| F | "Build Live Inquiry list with all six row actions, including Price Check and Carrier Position." | Internal sales workflow usable |
| G | "Build the §4.3 agent quote schema and the RFQ portal screens." | An agent can submit two options |
| H | "Build §5.2 win/loss, including the loser message. Verify no price or identity leaks." | Portal shows Won/Lost correctly |
| I | "Build the §4.4 quotation schema and the Quotation screen with §5.3 auto-pull." | Lines pull from the price table |
| J | "Build the PDF per §6.6 and Save & Send." | Customer receives a correct PDF |
| K | "Build Quotation List, revisioning per §5.3 rule 8, and the Booking placeholder." | Ready for Shipment Booking |

**Write tests in B, E, H and I.** Those four are where a silent bug is either a data leak or a
wrong number on a customer-facing document.

---

## 9. QUESTIONS FOR THE CLIENT

**Blocking phase D–F:**

1. **What is `Mode` on the Quotation?** Shipment Type is Sea/Air and Loading Type is FCL/LCL, so
   Mode is a third thing — CY/CY vs Door delivery? Direct/Transhipment? It is the only field on the
   quotation with no defined values.
2. **Can a customer log in?** The Menu lists a Customer tree (Inquiry List, Quotation List, Shipment
   Booking, Shipment Approval). §2.1 assumes yes. If customers can raise their own inquiries, the
   New Inquiry form needs a customer-facing variant.
3. **Multiple commodities but one HS Code field** — is HS code per commodity (§4.2 assumes yes) or
   one per inquiry?
4. **Agent selection for Inbound** — filtered by POL country, or POD country? §5.1 assumes POL
   country, since inbound means the goods originate abroad. Please confirm; getting this backwards
   sends every RFQ to the wrong agents.

**Blocking phase G–I:**

5. **Does an agent's quote feed the price table?** When we win on an agent's price, should that
   become a `freight_rate` row for reuse, or stay quote-only? §4.3 keeps it separate.
6. **Can an agent revise a submitted quote** before we decide, or is submission final?
7. **Is there an approval step before a quotation is sent** to the customer — e.g. manager sign-off
   above a discount threshold? Common in forwarding, and much cheaper to add now.
8. **One quotation per inquiry, or several** (different carriers offered side by side)? §4.4 allows
   many, with revisions. Confirm the client doesn't expect one quotation containing multiple carrier
   options — that changes the line structure.

**Blocking phase J:**

9. **Is `TRIPLE S LOGISTICS` the tenant, or a hardcoded brand?** §6.6 assumes tenant settings supply
   the name, logo, address and signature block — required anyway once this is sold as SaaS.
10. **Quotation number format** — `QTN-2026-000001`? Reset yearly? Separate series for Sea and Air?
11. **Who sends the mail** — a tenant-configured SMTP account, or a platform address with reply-to
    set to the salesman? Affects deliverability and the tenant settings screen.

**Worth deciding now:**

12. The `Booking Rate` label on the quotation and `Conversion Rate` on the PDF are the same field.
    Pick one label for the UI so the team isn't confused later.

**Raised while building I and K (2026-08-25):**

13. **May a draft quotation be deleted?** §7 lists `DELETE` on `CS.QUOTATION`. CR-002 draws the
    line at master data — a quotation is business history retired by its own status — and its test
    names quotations explicitly. The stricter rule was followed, so the permission and the route do
    not exist. But a draft raised against the wrong inquiry is a real case neither rule covers, and
    there is currently no way to remove one. Confirm whether a `CANCELLED` status, or a delete
    limited to `DRAFT`, is what the client wants.
14. **What names the freight on a quotation?** The price table prices the box but does not name the
    charge: `freight_rate` carries no cost head, only `rate_local_charge` does. So auto-pull can
    name the Seal, ENS and HBL lines and cannot name the Ocean Freight line. It is asked on the
    Quotation form instead — what the freight is *called* on a customer document is a sales
    decision, not a purchasing one — and left blank, only the local charges pull. If the client
    would rather set it once per rate, that is a column on `freight_rate` and a field on the
    Purchase screens.

---

## 10. IMPLEMENTATION NOTES — what was already built, and where this spec differs

> Added 2026-08-24 after auditing the spec against the running code. The spec was written without
> sight of the repository; several phases are already shipped, and two of its schema proposals are
> weaker than what exists. Recorded here so nobody rebuilds working code from a stale instruction.

### Already shipped — do not rebuild

| Spec phase | Status | Where |
|---|---|---|
| **B** — external users | **Done, differently and better.** Instead of one polymorphic `party_id`, `user` carries `agent_id`, `customer_id` and `vendor_id`, each a real composite FK to its own parent. A `party_id` pointing at two different tables cannot have a foreign key at all; this can, and does. The CHECK `user_external_is_not_staff` allows at most one link and forbids an external account from holding `employee_id` or `is_superadmin`. | `d8771b3`, migration `20260824140000_customer_vendor_users` |
| **G** — agent quote + RFQ screens | **Done.** The spec puts `option_no` on `agent_quote`, duplicating the whole header per option. The built shape normalizes it: `agent_quote_option` (one alternative offer, carrying carrier/TT/via/free days/validity/ETD/ETA/remarks) with `agent_quote_line` beneath it. Confirmed with the client on 2026-08-24 as "two alternative offers". | `b38b03f`, migration `20260824160000_agent_quote_options` |
| **H** — win/loss + loser message | **Mostly done.** `ACCEPTED`/`DECLINED` were renamed `WON`/`LOST`; a loss cannot be recorded without a message, and the client's wording is the placeholder. The thread is two-way and append-only. **Outstanding:** §5.2 says winning for one agent automatically loses it for the others; the build deliberately does not do that yet, because at the time no rule had been stated. | `b38b03f` |
| **6.4** — RFQ list and quote form | **Done**, columns as specified: no customer, no salesman, no target price, all three enforced by `agent_inquiry_v` rather than by the query. | `b38b03f` |

Since that audit, two things closed:

- **`SHORTLISTED` shipped.** §4.3's fourth state was the one part of the phase genuinely missing.
  It is reversible, guarded by `SALES.INQUIRY.ATTACH_PRICE` alongside the win/loss decision, and
  **never shown to the agent** — §6.4 lists Won and "Business Lost" as the only answers their
  portal gives, and telling somebody they made a shortlist reveals that they are being compared.
  Being shortlisted does not close their quote to amendment.
- **Phases I and K shipped** (§4.4 schema, §6.5 Quotation, §6.7 Quotation List). Deltas from the
  spec, all deliberate: `mode` is the `mode_id` key rather than loose TEXT, since Mode became a
  real lookup; `container_size` on a line is the key plus a snapshot name rather than TEXT;
  `quotation_line` carries a second provenance column (`price_source_local_charge_id`) because the
  price table answers in two parts and §4.4 named only one; `quotation_commodity` snapshots the
  commodities §5.3 rule 2 copies down. Two things the spec asked for were **not** built and are
  now questions 13 and 14 below. Phase J — the PDF — is still outstanding, and `EXPORT_PDF` is
  seeded ready for it.
- **The RFQ_SENT bug.** §5.1 marks an inquiry `RFQ_SENT` the moment it is shared with agents, but
  both the portal API and its page tested for `OPEN` alone — so the one state an agent is *asked*
  to quote in was the state that refused them. The rule now lives once in `packages/shared`
  (`INQUIRY_OPEN_TO_AGENT_QUOTES`) and both sides read it. `QUOTED` is deliberately excluded: once
  a customer quotation rests on an agent's price, that price is frozen. No test caught this because
  every fixture built its inquiry as `OPEN` and none went through `InquiryRoutingService` — the
  seam between phases E and G was never crossed.

### Naming collision — `container_type` already means *size*

The spec is right that size and physical type are different things, and right that the earlier spec
conflated them. It is conflated **in the database as well**: `container_type` currently holds
`20STD`, `40STD`, `40HC`, `45FT` — sizes — and is referenced by `rate_tier`, `inquiry_volume`,
`rate_local_charge` and `agent_quote_line`.

So "reseed `container_type` to Dry/Flat Rack/Open Top/Reefer" would destroy the size lookup that
live rows depend on. The resolution taken is in §4.1 of this file plus the migration notes: the
existing table is renamed to what it actually holds, and a new table takes the name the spec uses.

### Other deltas from the built schema

- `inquiry_volume` is the built equivalent of the spec's `inquiry_container`. It already carries
  `quantity`, `cbm`, `weight_kg` and `target_price` per row. It gains the physical container type.
- Commodity is currently a single FK on `inquiry` plus one `hs_code`; the spec makes it many.
- `tos` currently holds CY/CY-family terms. Those are a real freight concept and are the most
  plausible answer to open question 1 (`Mode`); they are deactivated rather than deleted so the
  answer stays available.
