# MODULE SPEC — SHIPMENT BOOKING → CARGO RECEIPT

> **How to use.** Save as `/docs/MODULE_BOOKING_CARGO.md`. Start a Claude Code session with:
> *"Read CLAUDE.md, then /docs/MODULE_BOOKING_CARGO.md. We are building Phase A. Show me the schema
> before any migration."*
> `CLAUDE.md` governs stack, tenancy, RBAC, screen patterns and design tokens.
> Depends on `/docs/MODULE_INQUIRY_QUOTATION.md` — portal users (§2.1) and email (§2.3) must exist.

---

## 1. THE FLOW AND ITS STATUS MACHINE

```
QUOTATION
   │ customer submits booking (portal)
   ▼
SHIPMENT BOOKING ─────────────────────► status: BOOKING_RECEIVED     action: Vsl/Flight Booking
   │ C/S team proposes vessel or flight schedule
   ▼
VESSEL / FLIGHT BOOKING ──────────────► status: VESSEL_PROPOSED      action: Awaiting Approval
   │ customer approves or rejects the proposed schedule
   ▼
SHIPMENT APPROVAL ────────────────────► status: APPROVED_FOR_SHIPMENT  action: Issue S/O
   │                        (rejected → back to VESSEL_PROPOSED with comments)
   ▼
SHIPPING ORDER ───────────────────────► status: SO_ISSUED
   │                        (inbound → SKIP S/O button, status: SO_SKIPPED)
   ▼
CARGO RECEIPT ────────────────────────► status: CARGO_RECEIVED | PART_RECEIVED
   ▼
[ CLP → Stuffing → Shipment Advise → EGM → SI → BL → Debit Note ]   ← later modules
```

The three status conditions and their action buttons are stated verbatim in the client's Booking
List sheet. Model them as an explicit enum with guarded transitions (§5.1) — **never as a set of
booleans**, and never let the frontend decide what the next state is.

---

## 2. FOUR ARCHITECTURAL DECISIONS

### 2.1 Booking creates the shipment file — the spine of the whole system

The Booking View is a tabbed record: `Overview · Booking · Vessel Schedule · Approval · Shipping
Order · Cargo Receipt · Stuffing · Shipment Advise · BL · Documents · Tracking · Finance ·
Activities`. Every remaining module in the client's chain hangs off it.

So booking is not just another form — it is where a quotation becomes an operational **shipment**
that eleven later modules will FK into. Create one canonical entity now:

```
shipment    id, tenant_id, shipment_no, quotation_id, ... , status
```

Everything downstream references `shipment_id`. Do not create a separate `shipment` table later and
try to bridge it to `booking` — you would be reconciling two identities across a dozen tables.

Build the tabbed view in phase F as a shell with the tabs that exist and placeholders for the rest.
The tabs are how the operations team will actually use this software daily.

### 2.2 Cargo is a three-level hierarchy: PO → Item → SKU

The client states it twice: *"One PO multiple Item. One Item multiple SKU."* And the Approval sheet
states *"Single PO can be approved / Multiple can be approved."*

**PO is therefore an entity, not a text column** — it is the unit of approval, and later the unit of
part-delivery. Model:

```
shipment_po        one row per PO
shipment_cargo_line   one row per Item+SKU under a PO
```

The screens still render one flat grid exactly as drawn, with PO repeating down the rows and
subtotals per PO (`PO's Total N.WT`, `PO's Total CBM`).

### 2.3 Measurements are computed, never typed

```
volume_cbm        = (L × W × H) × ctn_qty          -- L/W/H in metres; see §9 Q2 for the unit
gross_weight_kg   = sum of line gross weights
volumetric_kg     = volume_cbm × 167               -- IATA, 1 m³ = 167 kg  (6000 cm³/kg)
chargeable_wt_kg  = MAX(gross_weight_kg, volumetric_kg)     -- AIR only
```

Chargeable weight decides what the airline bills. Compute it in the database as a generated column
or in one shared service — **not in React, and not in three different places**. If sales, operations
and accounts each compute it separately, they will eventually disagree, and the customer will be the
one who notices.

The `Total Chargeable WT` column appears only on Air screens. Sea screens stop at CBM.

### 2.4 Each document stage stores its own quantities

This is the rule that makes Cargo Receipt work. The client is explicit:

> *"Qty / figure can be different than S/O or booking qty. If less then treat as part delivery until
> delivery balance qty. If exporter wants to short shipment then balance qty will show and later
> will close the booking."*

So booked quantity, shipping-order quantity, and received quantity are **three different numbers on
the same PO line**, and the gap between them is the business. Never overwrite the booked figure with
the received one. Store:

```
shipment_cargo_line.booked_ctn_qty       what the customer booked
shipment_cargo_line.so_ctn_qty           what the shipping order authorised
cargo_receipt_line.received_ctn_qty      what actually arrived at the warehouse
                  → balance = booked − Σ received, tracked until zero or short-closed
```

A booking may therefore have **many cargo receipts** over time.

---

## 3. MENU CHANGES IN THIS WORKBOOK

| Item | Change |
|---|---|
| Shipment Booking | Split into **Shipment Booking - Sea** and **Shipment Booking - Air** |
| Shipment Approval | Split into **Shipment Approval - Sea** and **Shipment Approval - Air** |
| Shipping Order | Split into **Shipping Order - Sea** and **Shipping Order - Air** |
| Agent portal | Now: RFQ (Live Inquiry) · **Nomination** · **Shipment status** · **Financial Statement** |
| Customer portal | Now: Inquiry List · Quotation List · **Shipment Booking** · **Shipment status** · **Financial Statement** |

**Sea and Air are the same screen with mode-conditional fields** — Carrier/Airlines, POL/AOL,
POD/AOD, Vessel+Voyage / Flight No+Flight Time, and the extra Chargeable Weight column. Build one
component driven by `shipment_type`, and route both menu items to it. Do not fork the codebase into
a sea copy and an air copy; they will drift within a month.

**`Nomination` on the agent portal has no wireframe** — do not build it. See §9 Q8.

---

## 4. SCHEMA

All tables inherit `CLAUDE.md` §4 conventions: `tenant_id` first, `code`, `is_active`, audit
columns, soft delete, composite tenant-safe FKs.

### 4.1 Shipment / booking

```
shipment
  id, tenant_id, code, shipment_no, booking_no (BKG-2026-000001)
  quotation_id      FK quotation NOT NULL
  shipment_type     ENUM('SEA','AIR')
  customer_id       FK customer
  -- exporter / importer captured per booking (one quotation can yield several bookings):
  exporter_name TEXT, exporter_address TEXT,
  importer_name TEXT, importer_address TEXT,
  goods_type_id     FK goods_type
  place_of_receipt  TEXT
  loading_type      ENUM('FCL','LCL')
  tos_id            FK tos
  mode              TEXT
  carrier_id        FK carrier            -- airline when AIR
  pol_id, pod_id    FK port               -- AOL / AOD when AIR
  etd DATE, eta DATE
  goods_handover_date DATE
  transit_type      ENUM('DIRECT','INDIRECT')
  warehouse_cfs     TEXT                  -- appears on the Shipping Order
  status            ENUM('BOOKING_RECEIVED','VESSEL_PROPOSED','APPROVED_FOR_SHIPMENT',
                         'REJECTED','SO_ISSUED','SO_SKIPPED','PART_RECEIVED','CARGO_RECEIVED',
                         'SHORT_CLOSED','CANCELLED')
  submitted_by, submitted_at
  INDEX (tenant_id, status), INDEX (tenant_id, quotation_id)

shipment_commodity        -- inherited from the quotation, multi
  id, tenant_id, shipment_id FK, commodity_item_id FK, hs_code TEXT

shipment_po
  id, tenant_id, shipment_id FK, po_no TEXT,
  approval_status ENUM('PENDING','APPROVED','REJECTED') DEFAULT 'PENDING',
  approved_by, approved_at, rejection_comments TEXT,
  UNIQUE (tenant_id, shipment_id, po_no)

shipment_cargo_line
  id, tenant_id, shipment_id FK, shipment_po_id FK
  item_code TEXT, sku TEXT
  ctn_qty INT, pcs_qty INT
  net_weight_kg   NUMERIC(18,3)
  gross_weight_kg NUMERIC(18,3)
  carton_length NUMERIC(10,3), carton_width NUMERIC(10,3), carton_height NUMERIC(10,3)
  volume_cbm       NUMERIC(18,4) GENERATED
                   ALWAYS AS (carton_length * carton_width * carton_height * ctn_qty) STORED
  chargeable_wt_kg NUMERIC(18,3) GENERATED
                   ALWAYS AS (GREATEST(gross_weight_kg,
                              carton_length*carton_width*carton_height*ctn_qty*167)) STORED
  dc               TEXT            -- client's "DC" column; see §9 Q1
  so_ctn_qty       INT NULL        -- authorised on the shipping order
```

### 4.2 Vessel / flight schedule

One table for both, because the shape is identical — legs with a sequence, origin, destination and
timings. Direct = one leg; Indirect = two or three.

```
shipment_schedule
  id, tenant_id, shipment_id FK
  carrier_id       FK carrier
  cut_off_date     TIMESTAMPTZ
  vgm_date         DATE NULL      -- SEA only; see §9 Q4
  si_date          DATE NULL
  transit_type     ENUM('DIRECT','INDIRECT')
  version_no       INT DEFAULT 1  -- a rejected schedule is superseded, not overwritten
  status           ENUM('PROPOSED','APPROVED','REJECTED','SUPERSEDED')
  proposed_by, proposed_at, decided_by, decided_at, rejection_comments TEXT

shipment_schedule_leg
  id, tenant_id, schedule_id FK, leg_no INT
  vessel_id       FK vessel NULL     -- SEA
  voyage_no       TEXT NULL          -- SEA
  flight_no       TEXT NULL          -- AIR
  flight_time     TEXT NULL          -- AIR
  origin_port_id  FK port, destination_port_id FK port
  etd TIMESTAMPTZ, eta TIMESTAMPTZ
  UNIQUE (tenant_id, schedule_id, leg_no)
  CHECK (leg_no BETWEEN 1 AND 5)
```

**A rejected schedule is never edited in place.** The C/S team proposes version 2; version 1 stays
`REJECTED` with its comments. The customer must be able to see what they turned down and why.

### 4.3 Shipping order

```
shipping_order
  id, tenant_id, code, so_no (SO-2026-000001)
  shipment_id FK, schedule_id FK
  issue_date, issued_by
  first_vessel_id FK vessel NULL, first_flight_no TEXT NULL
  cut_off TIMESTAMPTZ, etd, eta
  warehouse_cfs TEXT
  qr_payload TEXT            -- see §9 Q5
  status ENUM('ISSUED','SKIPPED','CANCELLED')
  skip_reason TEXT NULL      -- inbound shipments skip S/O
  pdf_file TEXT
```

### 4.4 Cargo receipt

```
cargo_receipt
  id, tenant_id, code, receipt_no (CR-2026-000001)
  shipment_id FK, shipping_order_id FK NULL   -- null when S/O was skipped
  receive_date DATE
  unload_location TEXT           -- warehouse / CFS
  efr_no TEXT                    -- client's EFR No
  receipt_seq INT                -- 1st, 2nd… receipt against this booking
  status ENUM('DRAFT','CONFIRMED')
  received_by, confirmed_at

cargo_receipt_line
  id, tenant_id, cargo_receipt_id FK, shipment_cargo_line_id FK
  received_ctn_qty INT, received_pcs_qty INT
  received_net_weight_kg NUMERIC(18,3), received_gross_weight_kg NUMERIC(18,3)
  carton_length, carton_width, carton_height NUMERIC(10,3)
  received_volume_cbm NUMERIC(18,4) GENERATED …
  line_status ENUM('ACCEPTED','DECLINED') NOT NULL
  decline_reason TEXT
  remarks TEXT
```

---

## 5. BUSINESS RULES

### 5.1 Status transitions — one guarded service, `ShipmentStatusService`

```
BOOKING_RECEIVED       → VESSEL_PROPOSED         (C/S saves a schedule)
VESSEL_PROPOSED        → APPROVED_FOR_SHIPMENT   (customer approves)
VESSEL_PROPOSED        → REJECTED                (customer rejects, comments mandatory)
REJECTED               → VESSEL_PROPOSED         (C/S proposes a new version)
APPROVED_FOR_SHIPMENT  → SO_ISSUED | SO_SKIPPED
SO_ISSUED | SO_SKIPPED → PART_RECEIVED | CARGO_RECEIVED
PART_RECEIVED          → PART_RECEIVED | CARGO_RECEIVED | SHORT_CLOSED
any                    → CANCELLED               (privileged, reason mandatory)
```

Every transition writes to `audit_log` with actor and timestamp. Reject anything not on this list
with a clear error. The Action button on the Booking List is derived from status, never stored.

### 5.2 Booking

1. **One quotation, one exporter, one booking. One quotation, many exporters, many bookings.**
   So `quotation_id` is not unique on `shipment` — several bookings may share a quotation, each with
   its own exporter. Do not add a unique constraint there.
2. Header fields copy down from the quotation and stay editable on the booking; edits never write
   back to the quotation.
3. The cargo grid is the PO/Item/SKU hierarchy with an `ADD` row, `Edit | Delete` per row, and a
   **Grand Total** line summing CTN, PCS, N.WT, G.WT, CBM (and Chargeable WT for air).
4. A booking cannot be submitted with zero cargo lines.

### 5.3 Approval is per PO, not per booking

The client states single or multiple POs may be approved. So:

- The customer ticks POs and approves or rejects them individually.
- Rejection **requires** a comment, shown back to the C/S team.
- The shipment reaches `APPROVED_FOR_SHIPMENT` when at least one PO is approved; unapproved POs stay
  `PENDING` and are excluded from the shipping order.
- Show the approver a clear summary: *"3 of 5 POs approved. 2 will not ship on this vessel."*

### 5.4 Shipping order

1. Pulls from the booking plus the **approved** schedule and **approved** POs only.
2. Numbered on issue, never on draft. Issuing is a one-way action; a mistake is cancelled and
   reissued with a new number.
3. **Inbound shipments skip the S/O.** Show a `SKIP S/O` button when the movement is Inbound; it
   sets `SO_SKIPPED` and requires no document. Cargo Receipt must work with a null
   `shipping_order_id`.
4. The PDF carries the tenant's letterhead, address and QR code — **from tenant settings, not
   hardcoded**, exactly as the Quotation PDF.

### 5.5 Cargo receipt and part delivery — the heart of this module

1. Received quantities are **editable and may differ** from the S/O and booking figures. Show booked,
   S/O and received side by side, with the variance highlighted — a receiver who cannot see the gap
   cannot flag it.
2. Each line is **Accepted or Declined** individually, with a reason on decline.
3. After confirming a receipt, recompute per PO line:
   `balance_ctn = booked_ctn − Σ accepted received_ctn`
   - any balance > 0 → shipment status `PART_RECEIVED`, booking stays open
   - all balances = 0 → `CARGO_RECEIVED`
4. A booking may have **several receipts**; each is numbered and kept.
5. **Short shipment:** a privileged user may close the remaining balance with a reason, setting
   `SHORT_CLOSED`. The balance stays visible on the record — never delete it. This is what accounts
   and the customer will argue about later, and the trail is the answer.
6. Never let received exceed booked without an explicit override and a reason.

---

## 6. SCREENS

Follow `CLAUDE.md` §8 and §12. All weights, volumes, quantities and dates in IBM Plex Mono with
tabular figures, right-aligned.

### 6.1 Shipment Booking (Sea / Air) — customer portal + internal

Header: Quotation No · Shipment Type · Customer · **Exporter** (Name, Address) · **Importer**
(Name, Address) · Goods Type · Commodity · Place of Receipt · HS Code · Loading Type · TOS · Mode ·
Carrier / Airlines · POL/AOL · POD/AOD · ETD · ETA · Goods hand over date · Transit Type.

Cargo grid — add row on top, list below, `Edit | Delete` per row:

`PO · Item · SKU · CTN Qty · PCS Qty · Total N.WT · Total G.WT · [Carton Size: L · W · H] ·
Total CBM · (Total Chargeable WT — air only) · DC`

CBM and chargeable weight are **read-only computed cells** that update live as L/W/H/qty are typed.
Group rows visually by PO with a subtotal strip. `Grand Total` pinned at the bottom.
`Submit` · `back to quotation list`.

### 6.2 Shipment Booking List

Columns: Quotation No · Booking No · Customer · Commodity · Shipment Type · POL/AOL · POD/AOD ·
Required Container · Transit Type · Goods H/DT · ETD · ETA · Status · Action.

Action is status-driven: `View` · `Edit` · then `Vsl Booking` (sea) / `Flight Booking` (air) /
`Awaiting Shipment Approval` / `Issue S/O`. Status renders as the §12 dot.

### 6.3 Booking View — the shipment file

A full-width record view with tabs: `Overview · Booking · Vessel Schedule · Approval ·
Shipping Order · Cargo Receipt · Stuffing · Shipment Advise · BL · Documents · Tracking · Finance ·
Activities`.

Build `Overview`, `Booking`, `Vessel Schedule`, `Approval`, `Shipping Order`, `Cargo Receipt` and
`Activities` (the audit trail) now. Render the rest as disabled tabs marked "Coming soon" — do not
hide them; the operations team needs to see the shape of the file.

### 6.4 Vessel Booking / Flight Booking

Read-only booking header and cargo summary on top, then the schedule form:

- Carrier/Airlines · Cut off · VGM Date · SI Date
- Leg grid with `Add`: `Leg · Vessel Name · Voyage · POL · POD · ETD · ETA`
  (air: `Leg · Airlines · Flight No · Flight Time · AOL · AOD · Departure · Arrival`)
- **Direct** allows one leg. **Indirect** allows two or three. Enforce this on save, and drive it
  from `transit_type` rather than showing two separate forms as the wireframe draws them.
- Validate leg continuity: leg 2's origin must equal leg 1's destination, and each ETD must follow
  the previous ETA. A schedule that cannot physically happen should not reach the customer.
- `Save` → status `VESSEL_PROPOSED`, notify the customer by email.

### 6.5 Shipment Approval (Sea / Air)

Booking header + proposed schedule, read-only. PO grid with selection checkboxes.
`Approved` / `Reject` + `Rejection comments` (mandatory on reject).
On decision: update PO statuses, transition the shipment, email the C/S team.

### 6.6 Shipping Order (Sea / Air)

Print-ready document: tenant letterhead and address · **QR code** · `SHIPPING ORDER` ·
Quotation No · Booking No · S/O No · full header block · Exporter / Importer · First Vessel or
Airlines · cut off · ETD · ETA · Warehouse/CFS · cargo table · Grand Total ·
`ISSUE SHIPPING ORDER`.

Also show `SKIP S/O` when the movement is Inbound.

### 6.7 Cargo Receipt

List: Booking No · S/O No · Customer · Exporter · Commodity · Shipment Type · POL/AOL · POD/AOD ·
Required Container · Goods H/DT · Carrier · Cut off · ETD · ETA · Status ·
Action (`View S/O` · `Accept` / `Edit`).

Detail: `Receive Date` · `Unload Location` · `EFR No`, then the cargo grid with **Booked · S/O ·
Received** columns side by side, editable received figures, and `Accept / Declined` per line.
A balance strip at the bottom: *"Balance 40 CTN across 2 POs"* with a `Short close` action for
privileged users.

---

## 7. PERMISSIONS

```
CS.BOOKING          VIEW CREATE EDIT DELETE VIEW_ALL SUBMIT CANCEL
CS.SCHEDULE         VIEW CREATE EDIT           -- vessel / flight booking
CS.APPROVAL         VIEW APPROVE REJECT
CS.SHIPPING_ORDER   VIEW ISSUE SKIP CANCEL EXPORT_PDF
OPS.CARGO_RECEIPT   VIEW CREATE EDIT CONFIRM DECLINE_LINE SHORT_CLOSE OVERRIDE_QTY
PORTAL.BOOKING      VIEW CREATE SUBMIT         -- customer portal
PORTAL.APPROVAL     VIEW APPROVE REJECT        -- customer portal
PORTAL.SHIPMENT_STATUS  VIEW                   -- customer + agent portal
```

`SHORT_CLOSE` and `OVERRIDE_QTY` are deliberately separate — they write off cargo the customer paid
to move, and should sit with a supervisor, not the warehouse clerk.

Portal scoping from the quotation module still applies: a `CUSTOMER` user sees only their own
shipments; an `AGENT` user sees only shipments they are nominated on, and **never the customer's
identity**.

---

## 8. BUILD ORDER

| Phase | Prompt | Done when |
|---|---|---|
| A | "Add the §4.1 shipment schema — shipment, PO, cargo lines with generated CBM and chargeable weight. Show me the generated column expressions before migrating." | Math verified against a sample carton |
| B | "Build the Shipment Booking screen (one component, sea/air conditional) with the PO/Item/SKU grid and live totals." | A booking saves with grouped POs |
| C | "Build `ShipmentStatusService` per §5.1 with the full transition table and tests." | Illegal transitions rejected |
| D | "Build the Booking List with status-driven actions." | Actions change with status |
| E | "Add §4.2 schedule schema + Vessel/Flight Booking screens with leg continuity validation." | Indirect 3-leg schedule saves |
| F | "Build the §6.3 Booking View tab shell with the seven live tabs." | Shipment file navigable |
| G | "Build Shipment Approval with per-PO approval and rejection comments." | Partial approval works |
| H | "Add §4.3 shipping order + PDF + QR + the inbound SKIP path." | S/O issues and prints |
| I | "Add §4.4 cargo receipt schema and screens, including the booked/SO/received comparison." | A receipt confirms |
| J | "Implement §5.5 part-delivery balances, multiple receipts, and short close, with tests." | Balances reconcile to zero |

**Write tests in A, C and J.** Those are the measurement maths, the state machine, and the balance
arithmetic — three places where a silent error becomes a billing dispute rather than a visible bug.

---

## 9. QUESTIONS FOR THE CLIENT

**Blocking phase A–B:**

1. **What is the `DC` column?** It appears on every cargo grid with no defined values — Delivery
   Challan number? Dangerous Cargo flag? Description of Cargo? It is the only unexplained column in
   the module.
2. **What unit are carton L / W / H entered in — cm or metres?** The CBM formula depends on it.
   §2.3 assumes metres. If centimetres, divide by 1,000,000.
3. **Are Exporter and Importer free text, or should they come from a master?** Captured as text in
   §4.1, but if the same exporters recur (very likely for a garment forwarder), they should be a CRM
   master with an address book. Cheaper to decide now.

**Blocking phase E–G:**

4. **VGM Date and SI Date appear on the Flight Booking screen.** VGM is a sea-container concept
   (SOLAS verified gross mass). Is this a copy-paste from the sea form, or does the client use those
   fields for air too?
5. **What should the Shipping Order QR code contain** — the S/O number, a tracking URL, or the full
   cargo summary? Affects whether it needs to be scannable offline at the warehouse gate.
6. **Who approves the shipment?** The Booking List says *"when Customer approved the proposed vsl"*,
   but Shipment Approval also sits in the internal Customer Service menu. Both, with the actor
   recorded? Or does C/S record the customer's approval on their behalf? §5.3 assumes both are
   possible and logged.
7. **Can the customer edit a booking after submitting**, before a vessel is proposed?

**Blocking later phases:**

8. **`Nomination` on the agent portal has no wireframe.** In forwarding this usually means the
   overseas agent nominating a shipment to us. Is that what it is, and when does it arrive?
9. **`Shipment status` and `Financial Statement`** now appear on both portals with no wireframes.
   Not built here.
10. **Booking number format** — `BKG-2026-000001`? Separate series for Sea and Air? Same question
    for S/O and Cargo Receipt numbers.
11. **On short close, what happens to the money?** Does the customer get credited for the
    unshipped balance, or was the quotation priced per shipment regardless? This decides whether
    Accounts needs a link to `SHORT_CLOSED`.
