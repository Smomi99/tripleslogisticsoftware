# MODULE SPEC — DOCUMENTATION: SHIPMENT ADVISE & BL DRAFT — **v1, transcribed from `Design (6).xlsx`**

> **How to use.** Start a Claude Code session with:
> *"Read CLAUDE.md, then /docs/MODULE_DOCUMENTATION.md. We are building Phase A. Show me the schema
> before any migration."*
> `CLAUDE.md` governs stack, tenancy, RBAC, screen patterns and design tokens.
> **Depends on** `/docs/MODULE_BOOKING_CARGO.md` (shipment, PO, cargo line, schedule, shipping
> order, cargo receipt) and `/docs/MODULE_CLP.md` + `CR-002` (container plan, stuffing, EFR).
> **Contains change requests** against both — see §3.8 and §7.2.
> Nothing here is invented: every field comes from a sheet cell. Everything I could not find in a
> sheet is in §12 as a question, not in the schema.

---

## 0A. BUILD STATUS — 2026-09-20

| Phase | State |
|---|---|
| A · Schema | **done** — 5 tables, 3 enums, 2 shipment statuses |
| B · Migration, permissions, seed | **done** — `20260920100000_documentation_module`, registry + seed applied |
| C · Shipment Advise — Sea | **done** — worklist, prefill, PO grid, save, HBL, send, cancel |
| D · Shipment Advise — Air | **done** — same screen, `shipment_type`-driven (§3.7's default) |
| E · BL Draft + List + templates | **done** except the print document (see below) |
| F · Customer access | **done** — CR-004 steps 1–3, portal router, `/portal/shipment` |
| G · Documents and mail attachments | **done** — both PDFs, attached on send |

**Also built, after the first pass:**

- **The two PDF documents.** `shipment-advise-pdf.ts` renders the sheet's header
  block and PO grid with its totals row, landscape, the House BL number set
  where the eye lands. `bl-draft-pdf.ts` draws the bill on the boxed geometry of
  the client's sheet, **watermarked DRAFT until the draft is approved** — a page
  that can be mistaken for an original is the one way this document does real
  damage. `Download & Print` and `Print` are wired on the staff screens and on
  the customer's.
- **Mail attachments**, on §12 Q4's own default. `email_log.attachments` holds
  storage keys rather than bytes, the worker reads them at send time, and a
  missing file logs and sends the letter anyway rather than swallowing it. The
  rendered document is stored once and its key written to `pdf_file`, so what
  the customer receives is the page the operator printed.
- **A BL template screen** at `/documentation/bl-template`, reached from the BL
  Draft tab rather than the sidebar — the client's menu has `Make Templet` and
  `Use Templet` and no third item.

**Still not built, and deliberately:**

1. **The rest of the portal columns** (§7.3, §12 Q7) — Inquiry List, Quotation
   List, Shipment Booking, Shipment status, Financial Statement on the Customer
   column, and the Agent column's three. No wireframes exist for any of them.
2. **BL Print and Copy Doc upload** (Menu K7, K8) — the next two screens in the
   Documentation module, and not part of what was asked for here.

**Two deviations worth recording.** `runtimeDatabaseUrl` no longer falls back to
the owner connection in production — CR-004 F6; it now refuses to boot, because
an API silently running with row level security switched off is the wrong thing
to be quiet about.

**And one from §4:** `bl_template` carries `TOGGLE_STATUS`
rather than `DELETE`. CR-002 keeps DELETE inside Settings and CRM, and a
permission test enforces it; a template under a transactional module retires by
going inactive instead, which is all §8's Action column ever offers.

---

## 0. SOURCE — WHAT ARRIVED

`docs/Design (6).xlsx`, 2026-09-20. Four sheets are new work; the Menu sheet moved under them.

| Sheet | Screen | State |
|---|---|---|
| `Shipment Advise.-Sea` | Documentation → Shipment Advise - Sea | **new** |
| `Shipment Advise-Air` | Documentation → Shipment Advise - Air | **new** |
| `BL Draft-outbound` | Documentation → BL Draft - Sea (staff) | **new** |
| `BL Draft-outbound-Customer` | The same document, drafted by the customer | **new** |
| `Menu` K3–K8 | `shipment Advise-Sea` · `shipment Advise-Air` · `BL Draft-Sea` · **`BL Draft List`** · `BL Print` · `Copy Doc upload` | `BL Draft List` is new; CLAUDE.md §3 did not have it |
| `Menu` V2–V6 / W2–W7 | **Agent** and **Customer** menu columns | new; of these only `AGENT.INQUIRY` exists today |

Already built and unaffected: every other sheet in the workbook.

---

## 1. WHERE THIS SITS

```
… Cargo Receipt → CLP → physical stuffing → ► SHIPMENT ADVISE ◄ → ► BL DRAFT ◄ → BL Print → EGM/SI → Debit Note
```

The Menu sheet's own chain (F17):
`Quotation > Shipment Booking > Shipment Approval > Shipping Order > Cargo Receipt > CLP > Stuffing >
Shipment Advise > EGM > SI Submission > BL Issue > Debit Note`.

Two facts follow from the chain, and they decide most of the design:

1. **The advise is the first document that needs a finalised CLP.** Its PO grid, stuffing date and
   container facts have no other source (sheet: *"PO details will pull from CLP"*).
2. **The BL draft needs the advise.** The BL Draft list carries `House BL No` and `MBL No` as
   columns, and those two numbers are born on the advise (`P18 = Auto generate`, `Q18 = entry`).
   A BL draft cannot be started before its advise exists.

---

## 2. WHAT THE SHEETS SAY

Transcribed, not summarised. Where a cell is quoted, it is the authority.

### 2.1 Shipment Advise — Sea (`Shipment Advise.-Sea`)

**List** (row 6) — one row per **booking**, with a `Search` box (N5):

`Booking NO · S/O NO · CLP NO · Customer · Exporter · Commodity · Shipment Type · POL/AOL ·
POD/AOD · Required Container · Carrier · Stuffing date · Action`

Action = **`Make Shipment Advise`** (single button, opens the form below).
Sample row: `BOO-01 · so-1 · Shafidi · Shafidi · Jute · Sea · Chittagong · Humburg ·
20STD(1) + (40HC(1) · SITC`.

**Form header** (rows 12–15):

| Cell | Field | The sheet's note |
|---|---|---|
| B12 | Carrier | `SITC` |
| B13 | Transit type | `Direct / Indirect` |
| B14 | 1st Leg Vessel · POL · POD · ETD · ETA | M14: *"Approved vessel schedule will show"* · M15: *"If required then change the approved vsl schedule"* |
| Q14 | `TSL+26+09+001` | an example number written beside the schedule block — see §12 Q3 |

**PO grid** (row 17), headed B16 *"PO details will pull from CLP"*:

`PO · Item · SKU · CTN Qty · PCS Qty · PO's Total N.WT · PO's Total G.WT · L · W · H ·
PO's Total CBM · Cargo Rvt dt · Stuffing dt · EFR No · House BL No · MBL No`

- Rows 18–20 are three PO lines; **row 21 is a totals row** — `3 PO · 780 · 11000 · 11300 · 12100 · 28`.
- **Columns M–Q are merged across all three PO rows** (`M18:M20`, `N18:N20`, `O18:O20`, `P18:P20`,
  `Q18:Q20`). Cargo Rvt dt, Stuffing dt, EFR No, House BL No and MBL No are therefore **one value
  for the whole advise**, not one per PO. This is the most load-bearing detail on the sheet — see §3.1.
- `P18 = Auto generate` (House BL No), `Q18 = entry` (MBL No).

**Footer:** B24 *"(Email id of customer. Auto fill of customer id and other will be additional)"* ·
B26 buttons **`Save` · `Save & Send` · `Download & Print`** · B29 *"Email Subject: Shipment Advise
of Booking no :"*.

### 2.2 Shipment Advise — Air (`Shipment Advise-Air`) — deltas only

- **List drops** `CLP NO` and `Required Container`; **adds** `Gross Weight` (`521 Kg`); `Carrier`
  becomes `Airlines` (`BG`); `POL/AOL → AOL`, `POD/AOD → AOD`. `Stuffing date` **stays**.
- **Header:** `Airline` (`Bangladesh Biman`) · `Transit type` · `1st Leg Flight · AOL · AOD ·
  Departure dt & time · Arrival Date & Time`. Note the air legs carry **time**; the sea legs do not.
- **PO grid adds** `Chargeable weight` (M17) and ends with `HAWB No` (auto generate) · `MAWB No` (entry).
- B16 still reads *"PO details will pull from CLP"* — but the Menu sheet says at I23
  **"No need CLP for Air Shipment."** These contradict. See §3.7 and §12 Q1.
- Same three buttons. No email-subject line was written on the air sheet.

### 2.3 BL Draft — Sea, staff (`BL Draft-outbound`)

Title: *"BL draft ( Only for Outbound shipment-Sea)"*. B12: *"Internal Customer Service team will use"*.

**List** = the advise list plus `Importer`, `House BL No`, `MBL No`; `Required Container` becomes
`Container Qty`; Action = **`Make BL draft`**.

**Form** — a real bill of lading, laid out as one:

| Block | Fields |
|---|---|
| Parties | `Shipper` (B13) · `Consignee` (B20) · `Notify Party` (B27) · `Also Notify Party` (G27) |
| References | `Manifest No` (G13) · `Bill of Lading Number` (L13) · `Export References` (G15) · `Forwarding Agent-References` (G20) · `Point & Country of Origin` (G26) |
| Routing | `Pre-Carriage By(mode)*` · `Place of Reciept*` (both starred = required) · `Ocean Vessel/Voyage` · `Port of Loading` · `Port of Discharge` · `Place of Delivery` |
| Delivery agent | `For Delivery of Goods Please Apply to:` (G34), with H37: *"There will be an option to select the agent."* |
| Cargo | `Marks and Numbers Container and Seal Numbers` (B40) — `container no / size` (D42), `seal` (D43), free `text input` (G43) · `Numbers and Description of Packages and Goods` (F40) · `Gross Weight ( KG)` (K40) · `Measurement(cubic meters)` (L40) |
| Foot | `Freight Payable at` · `No. of Original BL` · `Laden on Board Date` · `( email id of customer )` |
| Buttons | **`Draft` · `Make Templet` · `Save & Send` · `Print`** |

`Use Templet` sits at N13, beside the BL number.

### 2.4 BL Draft — the customer's copy (`BL Draft-outbound-Customer`) — deltas only

Same list, same form, four differences — and they are the whole feature:

1. `Shipper` is labelled **Shipper ( Exporter)**, `Notify Party` becomes **Notify Party(Importer)** —
   the customer is told which party each block means.
2. **`Pull`** appears under both (B16, B29): the customer pulls their own saved party details in
   rather than typing an address twice.
3. The internal-only notes are gone — no *"Internal Customer Service team will use"*, and no agent
   selector note. **The customer does not choose the destination agent.**
4. The third button is **`Save & Submit`**, not `Save & Send`. The customer hands the draft to the
   forwarder; the forwarder is the one who sends anything outward.

### 2.5 Menu sheet — the two portal columns

| Agent (V) | Customer (W) |
|---|---|
| RFQ (Live Inquiry) — **built** | Inquiry List |
| Nomination | Quotation List |
| Shipment status | Shipment Booking — Y5: *"Shipment booking + List + Approval will be in one page with link"* |
| Financial Statement | Shipment status |
| | Financial Statement |

**The customer column does not list BL Draft**, yet a customer BL-draft screen exists on its own
sheet. See §12 Q6 — my reading is that it opens from the customer's own shipment row, which is
exactly the child-screen pattern of CLAUDE.md §8, not a menu item.

---

## 3. ARCHITECTURAL DECISIONS

### 3.1 One advise per booking. One House BL per booking.

The merged M–Q columns say so, and it agrees with what the client already confirmed for the CLP:
CR-002 Addendum H reads *"one, `EFR-001` (\"1 HBL\")"* for an FCL booking and *"one per booking"*
for LCL. So:

- **HBL is per booking**, never per container. An LCL box holding three bookings produces three
  HBLs — one per booking — and one MBL.
- A booking whose cartons span two containers still has **one** advise and **one** HBL.

`shipment_advise` therefore hangs off `shipment`, and the container is a detail inside it.

### 3.2 The advise is a snapshot, not a live view of the CLP

The advise is a letter that went to a customer at a moment in time. If a CLP is cancelled and
rebuilt next week, the advise the customer is holding must not silently change underneath them —
this is the rule `email_log` already follows (*"rendered when queued, not when sent"*).

So `shipment_advise_line` **stores** the pulled values (PO, item, SKU, cartons, pcs, weights,
dimensions, CBM, chargeable weight, EFR, stuffing date, cargo-receipt date, source CLP) rather than
joining them at read time. The pull is a build step: re-runnable while the advise is `DRAFT`, frozen
the moment it is sent.

### 3.3 The advise allocates the House BL number; the BL draft reads it

`P18 = Auto generate` sits on the advise, and the BL Draft list shows `House BL No` as a column it
already has. So the number is allocated when the advise is **created** — not when it is sent, because
the BL Draft list has to show it and a draft advise is still a real record.

`MBL No` is typed on the advise (`Q18 = entry`) and is nullable — the carrier often issues it later.

### 3.4 The BL's party blocks are free text, and the document owns them

A bill of lading's Shipper / Consignee / Notify blocks are addresses as they must appear on the
document, line breaks included — never a foreign key rendered at print time. They are **pulled once**
from the shipment (exporter / importer name and address, which `shipment` already stores as text)
and then belong to the draft. A later correction to the customer master must not rewrite a BL that
has been sent to a carrier.

### 3.5 `Make Templet` / `Use Templet` is a reusable party block

`bl_template` stores the blocks a forwarder retypes on every shipment for the same customer —
shipper, consignee, notify, also-notify, freight payable at, number of originals, delivery agent.
Scoped to a customer when saved from that customer's draft; workspace-wide when not.

### 3.6 The customer's BL draft is the same row, in a different state

Not a second table, not a copy. One `bl_draft`, with:

- `origin ENUM('STAFF','CUSTOMER')` — who started it, which is what the two sheets differ on;
- a status that carries the hand-off: the customer's `Save & Submit` moves `DRAFT → SUBMITTED`, and
  from there it is the forwarder's document to finish.

Two tables would mean two schemas, two PDFs and two sets of validation drifting apart, for one
document that only ever has one final version.

### 3.7 Air: the CLP contradiction

`MODULE_CLP.md` §9 already ruled that air is ULD build-up and **a separate, unbuilt module**; the
Menu sheet agrees (*"No need CLP for Air Shipment"*); the air advise sheet says the grid pulls from
the CLP. Until the client rules (§12 Q1), the **working default** is:

- the air PO grid is built from **confirmed cargo receipts** (`ACCEPTED` lines) — the same pool the
  CLP itself allocates from, so the numbers are identical either way;
- `EFR No` comes from those receipts, exactly as `lib/clp-efr.ts` already resolves it;
- `Stuffing dt` is a **typed field** on the air advise, because with no CLP nothing else knows it.

### 3.8 Two new shipment statuses — a change request against `MODULE_BOOKING_CARGO`

Both new screens are worklists of bookings, and every worklist in this product is
`SHIPMENT_WORKLISTS` narrowed by `shipment.status`. The status machine stops at `CARGO_RECEIVED`
today — finalising a CLP moves nothing — so neither queue can be expressed without adding:

```
CARGO_RECEIVED ─► ADVISED ─► BL_DRAFTED         (+ CANCELLED / SHORT_CLOSED from each)
```

- `ADVISED` — set when the advise is **sent**, not when it is saved. A draft advise is not an event
  the customer has seen.
- `BL_DRAFTED` — set when a BL draft reaches `APPROVED`. `BL_ISSUED` belongs to BL Print, later.

The alternative, if the client would rather not grow the enum: derive both queues from document
existence (*has a FINAL CLP and no SENT advise*). It works, but the booking list's Status column then
stops telling the truth after cargo receipt, and §5.1's *"an explicit enum, never a set of booleans"*
is the rule this codebase has followed everywhere else. **Recommendation: add the two.**

---

## 4. SCHEMA

Every table takes the CLAUDE.md §4 standard columns (`tenant_id` first and indexed, `id`, `code`,
`is_active`, `created_at/by`, `updated_at/by`, `deleted_at`) and the §4 rule 10 composite FKs. Listed
below is only what is specific to this module.

```
enum advise_status        DRAFT | SENT | CANCELLED
enum bl_draft_status      DRAFT | SUBMITTED | APPROVED | SENT | CANCELLED
enum bl_draft_origin      STAFF | CUSTOMER

shipment_advise                                        -- one per booking (§3.1)
  shipment_id        FK → shipment      UNIQUE(tenant_id, shipment_id) WHERE deleted_at IS NULL
  code               'SA-2026-000001'   (formatDocumentNo, prefix SA)
  series_year
  schedule_id        FK → shipment_schedule   -- the APPROVED one it was built from; nullable
  carrier_id         FK → carrier             -- sea: Carrier · air: Airline
  transit_type       DIRECT | INDIRECT        -- existing enum
  first_vessel_id    FK → vessel   nullable   -- sea
  voyage_no          text          nullable   -- sea
  first_flight_no    text          nullable   -- air
  pol_id / pod_id    FK → port                -- POL/AOL, POD/AOD: an overridable copy of the schedule
  etd / eta          timestamptz              -- sea shows the date, air shows date & time (§2.2)
  stuffing_date      date          nullable   -- air only; sea reads it from the CLP (§3.7)
  house_bl_no        text                     -- allocated on create (§3.3) — HBL or HAWB
  mbl_no             text          nullable   -- typed — MBL or MAWB
  status             advise_status
  sent_at / sent_by / email_log_id
  pdf_file           text          nullable
  -- totals, frozen with the lines (row 21 of the sheet)
  total_po_count, total_ctn_qty, total_pcs_qty,
  total_net_weight_kg, total_gross_weight_kg, total_volume_cbm,
  total_chargeable_wt_kg                                -- air

shipment_advise_line                                    -- one per cargo line, in PO order
  advise_id              FK → shipment_advise
  shipment_po_id         FK → shipment_po
  shipment_cargo_line_id FK → shipment_cargo_line
  clp_id                 FK → clp      nullable         -- null on air (§3.7)
  po_no, item_code, sku
  ctn_qty, pcs_qty, net_weight_kg, gross_weight_kg,
  carton_length_cm, carton_width_cm, carton_height_cm,
  volume_cbm, chargeable_wt_kg
  cargo_receipt_date     date nullable
  stuffing_date          date nullable                  -- the CLP's load_datetime
  efr_no                 text nullable

bl_draft
  shipment_id        FK → shipment
  advise_id          FK → shipment_advise               -- §3.3, where the BL number came from
  code               'BLD-2026-000001'
  series_year
  origin             bl_draft_origin
  bl_no              text                               -- = advise.house_bl_no, copied at create
  manifest_no        text nullable
  shipper_text       text                               -- §3.4, free text with line breaks
  consignee_text     text
  notify_text        text
  also_notify_text   text nullable
  export_references           text nullable
  forwarding_agent_references text nullable
  point_country_of_origin     text nullable
  pre_carriage_by_mode_id     FK → mode   NOT NULL      -- starred on the sheet
  place_of_receipt            text        NOT NULL      -- starred on the sheet
  delivery_agent_id           FK → agent  nullable      -- staff-only field (§2.4 rule 3)
  delivery_agent_text         text nullable
  ocean_vessel_voyage         text nullable
  pol_id / pod_id             FK → port
  place_of_delivery           text nullable
  packages_description        text nullable             -- F40, free text
  marks_and_numbers           text nullable             -- G43, free text beside the container list
  gross_weight_kg             numeric(18,3)
  measurement_cbm             numeric(18,4)
  freight_payable_at          text nullable
  original_bl_count           int  nullable
  laden_on_board_date         date nullable
  status                      bl_draft_status
  submitted_at / submitted_by                           -- the customer's Save & Submit
  approved_at / approved_by
  sent_at / sent_by / email_log_id
  pdf_file                    text nullable

bl_draft_container                                      -- the B40 block, pulled from the CLPs
  bl_draft_id        FK → bl_draft
  clp_id             FK → clp   nullable
  container_no, container_size, seal_no
  ctn_qty, gross_weight_kg, measurement_cbm

bl_template
  customer_id        FK → customer  nullable            -- null = workspace-wide (§3.5)
  name
  shipper_text, consignee_text, notify_text, also_notify_text,
  freight_payable_at, original_bl_count, delivery_agent_id
```

**Migration boilerplate — every new table needs all five.** This is where new tables have gone wrong
here before:

1. `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation … USING (tenant_id =
   app_staff_tenant())` — the **new** single-comparison form from
   `20260917090000_rls_estimable_tenant_check`, never the old `AND app_current_agent() IS NULL`.
2. `GRANT SELECT, INSERT, UPDATE ON TABLE … TO ff_app` and `GRANT USAGE, SELECT ON SEQUENCE …`.
3. `CREATE TRIGGER "<table>_audit" AFTER INSERT OR UPDATE OR DELETE … EXECUTE FUNCTION
   app_audit_row()` — the audit trail is a trigger in this codebase, not Prisma middleware.
4. `app_assert_parent_tenant` guards on every FK to a **system-capable** master (`port`, `carrier`,
   `vessel`, `mode`) — a plain FK would happily accept another workspace's private row.
5. The customer-facing policies of §7.2, on `bl_draft`, `bl_draft_container` and `bl_template`.

---

## 5. LIFECYCLE

```
SHIPMENT ADVISE
  (none) ──Make Shipment Advise──► DRAFT ──Save & Send──► SENT ──► (shipment → ADVISED)
                                     │
                                     └── re-pull from the CLP allowed while DRAFT only (§3.2)
  SENT is terminal except CANCELLED (reason mandatory; the HBL number is retained forever)

BL DRAFT
  staff:     (none) ─Make BL draft─► DRAFT ─Save & Send──► SENT
  customer:  (none) ─Make BL draft─► DRAFT ─Save & Submit─► SUBMITTED ─staff APPROVE─► APPROVED ─Save & Send─► SENT
  APPROVED sets shipment → BL_DRAFTED.  A SUBMITTED draft is read-only to the customer.
```

Rules:

1. **No advise before a finalised CLP** (sea). The API refuses and says why, rather than returning a
   bare 400.
2. **No BL draft before an advise exists** — the BL number comes from it (§3.3).
3. A `SENT` advise and an `APPROVED` BL draft are **immutable**. Corrections are cancel-and-reissue,
   the rule `MODULE_BOOKING_CARGO` §5.4 rule 2 already gives the shipping order.
4. Every status move goes through the status service — never a bare `data: { status }` in a route.

---

## 6. PERMISSIONS — registry diff

`packages/shared/src/permissions.ts`. Existing keys are **kept**, never pruned: production
`role_permission` rows point at them.

```diff
 ACTIONS
+  'BUILD'            // re-pull the PO grid from the CLP; separate from EDIT because it
+                     // discards typed corrections
 FEATURES
-  DOCUMENTATION.SHIPMENT_ADVISE   actions: MASTER
+  DOCUMENTATION.SHIPMENT_ADVISE   actions: [...MASTER, 'BUILD', 'SEND', 'EXPORT_PDF', 'CANCEL']
-  DOCUMENTATION.BL_DRAFT          actions: MASTER_APPROVE
+  DOCUMENTATION.BL_DRAFT          actions: [...MASTER_APPROVE, 'SEND', 'EXPORT_PDF', 'CANCEL']
+  DOCUMENTATION.BL_TEMPLATE       actions: ['VIEW','CREATE','EDIT','DELETE']   // Make/Use Templet
+ MODULE 'CUSTOMER'
+  CUSTOMER.BL_DRAFT               actions: ['VIEW','CREATE','EDIT','SUBMIT','EXPORT_PDF']
                                   childScreen: true      // §2.5 — reached from a shipment row
```

`SEND`, `EXPORT_PDF`, `SUBMIT`, `APPROVE`, `CANCEL` and `DELETE` already exist in `ACTIONS`; only
`BUILD` is new.

Why `SEND` is separate from `EDIT`, in this module's terms: composing an advise and putting it in
front of a customer are different acts, and the reasoning the registry already applies to a quotation
applies here with more force — the advise is what the customer plans their receiving week around.

---

## 7. CUSTOMER ACCESS — the third kind of user

### 7.1 What already exists

More than you would expect. `user` carries `agent_id | customer_id | vendor_id` with only one ever
set; `user_type = CUSTOMER` is already a creatable account on the CRM → User screen; and
`authenticateAs('STAFF')` already refuses **any** external account (`isExternal`), so no staff route
is reachable by a customer today. `MODULE 'AGENT'` is the working precedent for *"everything an
outside company can see is one line of `permissions.ts`"*.

### 7.2 What is missing — and the one thing that is dangerous

**`app_staff_tenant()` must learn about customers before a customer session is ever opened.**

```sql
-- today
CREATE FUNCTION app_staff_tenant() RETURNS BIGINT AS
  $$ SELECT CASE WHEN app_current_agent() IS NULL THEN app_current_tenant() END $$;
```

A customer session that sets `app.tenant_id` and leaves `app.agent_id` empty looks exactly like a
staff session to that function — so **every `tenant_isolation` policy in the database would admit
it**. The API layer would still refuse (§7.1), but RLS is meant to be the net under the API, and on
the day somebody adds a customer route that net would not be there. Required, in this order:

1. `app_current_customer()`, mirroring `app_current_agent()`.
2. Redefine `app_staff_tenant()` to return the tenant only when **both** are null.
3. `withCustomer(tenantId, customerId, fn)` in `lib/tenant-client.ts`, setting `app.customer_id` and
   clearing `app.agent_id` — mirroring the existing `withAgent`.
4. `authenticateCustomer = authenticateAs('CUSTOMER')`, and extend the kind check so `'AGENT'` and
   `'CUSTOMER'` each refuse the other.
5. `customer_read` / `customer_rw` policies on exactly three tables — `bl_draft`,
   `bl_draft_container`, `bl_template` — plus `customer_read` on `shipment` (their own bookings
   only) and on the master lookups the form renders (`port`, `mode`, and the agent's name only).
6. The §7A rule 4 isolation test, in the shape `agent-rls.test.ts` already has: seed two customers in
   one tenant plus a second tenant, sign in as customer A, and assert every endpoint returns zero
   rows of customer B **and** zero rows of tenant B.

### 7.3 Scope boundary

This spec builds **one** customer screen: the BL draft of §2.4. The rest of the Menu's Customer
column (Inquiry List, Quotation List, Shipment Booking, Shipment status, Financial Statement) and
the Agent column's three new items are a portal-sized piece of work with no wireframes in this
workbook — §12 Q7. The user-kind plumbing above is built once and carries all of them.

---

## 8. API

`{ success, data, meta?, error? }`, `page/limit/search/sortBy/sortOrder`, every route guarded.

| Method | Route | Permission |
|---|---|---|
| GET | `/shipment-advise/worklist` | `DOCUMENTATION.SHIPMENT_ADVISE.VIEW` |
| GET | `/shipments/:id/advise/prefill` | `…SHIPMENT_ADVISE.CREATE` |
| POST | `/shipments/:id/advise` | `…SHIPMENT_ADVISE.CREATE` (allocates the HBL) |
| GET / PATCH | `/shipment-advise/:id` | `…VIEW` / `…EDIT` |
| POST | `/shipment-advise/:id/build` | `…BUILD` (re-pull; DRAFT only) |
| POST | `/shipment-advise/:id/send` | `…SEND` |
| POST | `/shipment-advise/:id/cancel` | `…CANCEL` (reason required) |
| GET | `/shipment-advise/:id/pdf` | `…EXPORT_PDF` |
| GET | `/bl-drafts` | `DOCUMENTATION.BL_DRAFT.VIEW` — the new `BL Draft List` menu item |
| POST | `/shipments/:id/bl-draft` | `…BL_DRAFT.CREATE` |
| GET / PATCH | `/bl-drafts/:id` | `…VIEW` / `…EDIT` |
| POST | `/bl-drafts/:id/approve` | `…APPROVE` |
| POST | `/bl-drafts/:id/send` | `…SEND` |
| GET | `/bl-drafts/:id/pdf` | `…EXPORT_PDF` |
| GET/POST/PATCH/DELETE | `/bl-templates[/:id]` | `DOCUMENTATION.BL_TEMPLATE.*` |
| GET | `/customer/shipments` | `CUSTOMER.BL_DRAFT.VIEW` — `authenticateCustomer` |
| POST | `/customer/shipments/:id/bl-draft` | `CUSTOMER.BL_DRAFT.CREATE` |
| GET / PATCH | `/customer/bl-drafts/:id` | `CUSTOMER.BL_DRAFT.VIEW` / `.EDIT` (DRAFT only) |
| POST | `/customer/bl-drafts/:id/submit` | `CUSTOMER.BL_DRAFT.SUBMIT` |

The customer routes are a **separate router** under `authenticateCustomer` and `withCustomer` — never
a staff route that branches on who is calling.

---

## 9. DOCUMENTS AND EMAIL

- **PDF:** two renderers beside the existing `quotation-pdf.ts`, `shipping-order-pdf.ts` and
  `clp-print.ts` — `shipment-advise-pdf.ts` and `bl-draft-pdf.ts`. The BL renders on the standard BL
  geometry of the sheet; the advise renders the header block plus the PO grid and its totals row.
- **Email templates** (seeded, `email_template.key`): `SHIPMENT_ADVISE_SENT`, subject taken from the
  sheet — *"Shipment Advise of Booking no : {bookingNo}"* — plus `BL_DRAFT_SENT` and
  `BL_DRAFT_SUBMITTED` (to the C/S team when a customer submits one).
- **Recipients** come from `customer_pic` emails, prefilled and editable, matching B24's note.
- **Attachments do not exist yet.** `queueMail` takes a rendered body and inline images only; the
  quotation's "Save & Send" sends a body and leaves the PDF to a download link. A BL draft sent to a
  customer for confirmation with no BL attached is half a letter, so this module needs
  `attachments: { filename, content }[]` added to `QueueMailInput`, to `email_log` and to the worker.
  Roughly half a day, and flagged rather than assumed — §12 Q4.

---

## 10. TESTS — before either screen ships

1. **Tenant isolation**, per §7A rule 4, for `shipment_advise`, `bl_draft` and `bl_template`.
2. **Customer isolation** — §7.2 step 6. Not optional, and not a variant of the agent test: it is the
   first time `app_staff_tenant()` has had to be right for two reasons at once.
3. **Phase-seam tests.** Fixtures in this repo build their own state, which is exactly where the
   joins between modules have hidden bugs before. So: build an advise from a **genuinely finalised
   CLP** (not a hand-inserted `clp` row), and a BL draft from a **genuinely sent advise**, asserting
   that the PO grid, the EFR list and the container block match what the CLP and the receipts hold.
4. **Immutability** — a `SENT` advise and an `APPROVED` BL refuse every write path.
5. **Permission matrix** — `SEND` without `EDIT`, `EDIT` without `SEND`, a customer without `SUBMIT`.

---

## 11. PHASE PLAN

One session each. Schema phases **stop and wait** for review before the migration is generated.

| Phase | Work | Done when |
|---|---|---|
| **A** | Schema for §4 — six tables, three enums, the two `shipment_status` values. **Show the schema; do not migrate.** | Schema reviewed by hand |
| **B** | The migration + the §6 permission registry + the seed, together. RLS in the new single-comparison form, grants, audit triggers, tenant guards. | `db:deploy` clean; isolation test green |
| **C** | Shipment Advise — Sea, end to end: worklist, prefill from the CLP, form, PO grid with totals, save, HBL allocation, PDF, send. **This is the reference implementation.** | One advise sent, PDF correct |
| **D** | Shipment Advise — Air: the same screen, `shipment_type`-driven, per §2.2 and §3.7. | Air advise sent |
| **E** | BL Draft (staff) + BL Draft List + templates: form, container block pulled from the CLPs, approve, send, print. | One BL sent |
| **F** | Customer access: §7.2 steps 1–6, then the customer BL draft screen and `Save & Submit`. | Customer isolation test green; a customer-submitted draft lands in the C/S queue |
| **G** | `attachments` on the mail queue, if §12 Q4 says yes. | The advise PDF arrives attached |

Rough size: A–B one session, C two, D one, E two, F two, G half. C and E are where the estimate will
move, because both are full-page forms with a printed document behind them.

---

## 12. OPEN QUESTIONS — for the client

Nothing below is guessed at in the schema. Each has a working default so the build is not held up.

| # | Question | Working default |
|---|---|---|
| 1 | **Air and the CLP.** The air advise sheet says *"PO details will pull from CLP"*; the Menu sheet says *"No need CLP for Air Shipment"*. Which? | Build the air grid from confirmed cargo receipts; `Stuffing dt` typed (§3.7) |
| 2 | **`Stuffing date` on the air list.** With no CLP and no ULD module, who types it and when? | A field on the air advise |
| 3 | **House BL format.** `Q14` on the sea sheet reads `TSL+26+09+001` — is that the HBL format: company prefix + 2-digit year + 2-digit month + a serial that resets monthly? And is `TSL` per workspace? | `{TENANT_PREFIX}{YY}{MM}{NNN}`, the prefix configurable in Settings |
| 4 | **Should `Save & Send` attach the PDF?** Today nothing in the product attaches a file to an email (§9). | Yes, for both documents — build the attachment support |
| 5 | **Who may set `MBL No`?** It is typed on the advise, but it arrives from the carrier, often after the advise has gone out. | Editable on a `SENT` advise by `EDIT` holders — the one exception to §5 rule 3, recorded in the audit log |
| 6 | **Where does the customer reach their BL draft?** The Customer menu column does not list BL Draft (§2.5). | From the Action column of the customer's own shipment row |
| 7 | **The rest of the portal columns.** Customer: Inquiry List, Quotation List, Shipment Booking, Shipment status, Financial Statement. Agent: Nomination, Shipment status, Financial Statement. No wireframes in this workbook. | Out of scope here; §7.2's plumbing is built so each becomes a screen, not a re-architecture |
| 8 | **Inbound BL.** Both BL sheets say *"Only for Outbound shipment-Sea"*. Does an inbound shipment get a BL screen at all, and is there an air equivalent (HAWB draft)? | Outbound sea only, as written |
| 9 | **`Also Notify Party` and `Forwarding Agent-References`** — free text, or pulled from the agent master? | Free text, with the agent's details pullable into it |
| 10 | **The two new shipment statuses** (§3.8) — confirm `ADVISED` and `BL_DRAFTED`, or keep the queues derived. | Add them |
