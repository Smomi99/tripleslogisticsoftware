# CHANGE REQUEST — CR-002: MULTI-BOOKING CLP CONSOLIDATION

> **How to use.** Save as `/docs/CR-002-clp-consolidation.md` alongside `MODULE_CLP.md` (v2).
> Start a Claude Code session with: *"Read CLAUDE.md, then /docs/MODULE_CLP.md, then
> /docs/CR-002-clp-consolidation.md. CR-002 amends the CLP module — apply it before building."*
> **Apply this before Phase B of the CLP build**, not after. It changes the CLP schema at the root.

---

## 1. WHAT IS CHANGING

| # | Request | Verdict |
|---|---|---|
| 1 | FCL: one quotation with several bookings → group them in the list as `Inquiry No → Quotation No → bookings`, merge them into **one CLP** | **Correct — adopt.** Changes the CLP schema, see §2 |
| 2 | LCL: select **multiple bookings**, the selection becomes one CLP | **Correct — adopt.** Same schema change, different selection rule, see §3 |
| 3 | Keep CLP as its own screen, *or* put it inside Cargo Receipt | **Keep it separate.** See §5 — request 1 and 2 effectively decide this |
| 4 | Separate Cargo Receipt for FCL and LCL | **Separate the view, not the table.** See §6 |

Requests 1 and 2 are the same underlying capability: **a CLP is no longer owned by one booking.**
That is correct and it is how consolidation works — a container is a physical box, and what goes in
it does not care which booking paid for it.

---

## 2. SCHEMA CHANGE — a CLP belongs to many bookings

`MODULE_CLP.md` §3.2 currently has `clp.shipment_id` as a single FK, with `clp_seq` unique per
shipment. Both must go.

```
clp
  REMOVE  shipment_id
  REMOVE  shipping_order_id
  REMOVE  UNIQUE (tenant_id, shipment_id, clp_seq)

  ADD     consolidation_type ENUM('SINGLE','FCL_QUOTATION','LCL_CONSOLIDATION') NOT NULL
  ADD     quotation_id       FK quotation NULL   -- set for FCL_QUOTATION grouping
  ADD     pol_id, pod_id     FK port             -- the physical lane, snapshotted
  ADD     schedule_id        FK shipment_schedule NULL   -- the vessel/voyage this box sails on
  ADD     cfs_location       TEXT                -- where it is being stuffed
  ADD     UNIQUE (tenant_id, clp_no)

clp_booking                        -- NEW: which bookings participate in this container
  id, tenant_id, clp_id FK, shipment_id FK,
  shipping_order_id FK NULL,
  UNIQUE (tenant_id, clp_id, shipment_id)

clp_line
  (unchanged — still FKs shipment_cargo_line, which carries its own shipment_id)
```

`clp_line` needs no change, and that is the point: **the conservation rule in §4.1 still works
untouched**, because it is enforced per cargo line, not per booking. A line can only ever be
allocated up to its received quantity, whether the container holds one booking or six.

### Numbering must move

`clp_seq` was "CLP No : 1, 2" within a shipment. With a merged CLP that is meaningless — the same
container would be "CLP 1" for one booking and "CLP 3" for another.

- `clp_no` becomes the single identity: `CLP-2026-000001`, unique per tenant.
- For display on a booking's own file, show the **position within that booking's containers**,
  computed on read, not stored.
- The printed document shows `clp_no`, plus every participating booking number.

### Downstream consequence — check these before building

- The **CLP print document** now needs a booking column, or one block per booking. A warehouse
  loading a consolidated box must see which cartons belong to which shipper.
- A **booking's status** can no longer be derived from "its CLP". A shipment is fully planned when
  *all of its received cargo* is allocated to finalised CLPs — which may be several containers shared
  with other bookings.
- **Cancelling a CLP** releases allocations across several bookings at once. The confirm dialog must
  name every affected booking.

---

## 3. MERGE RULES — FCL AND LCL ARE GENUINELY DIFFERENT

Your instinct to treat them separately is right, and the reason is worth stating plainly: FCL
consolidation is **within one customer**, LCL consolidation is **across customers**.

### FCL — group by quotation

```
Grouping:   Inquiry No → Quotation No → its bookings
Merge:      bookings under the SAME quotation only
Why:        one quotation means one customer, often several exporters.
            Merging two customers' cargo into one FCL box is not consolidation, it is a mistake.
```

### LCL — select across quotations

```
Grouping:   a flat, filterable pool of LCL bookings with cargo received
Merge:      any bookings the user ticks, across customers and quotations
Why:        this is exactly what LCL is — many shippers sharing one box.
```

### Compatibility rules — enforce these on **both**, server-side

Whatever the selection rule, the bookings must be able to physically travel together. Block the merge
and say which booking failed and why:

1. Same `pol_id` and `pod_id`
2. Same `carrier_id`
3. Same vessel and voyage (`schedule_id`) — different sailings cannot share a box
4. Same or compatible cut-off date
5. Same CFS / unload location — the cargo has to be in one warehouse to be stuffed into one container
6. `shipment_type = SEA` for both
7. Every booking has cargo **received and accepted** (status `PART_RECEIVED` or `CARGO_RECEIVED`)
8. Same `loading_type` — never mix FCL and LCL bookings in one CLP

Rule 3 is the one that catches real mistakes. Two bookings on the same lane with the same carrier but
different sailings look identical in a list, and merging them produces a container that cannot exist.

**One question on the FCL rule** — see §7 Q1. "Same quotation" is a business grouping; "same lane,
carrier and vessel" is physical reality. I would make the compatibility rules the hard constraint and
the quotation the default grouping, so a user can still merge two quotations for the same customer
when operations require it.

---

## 4. SCREEN CHANGES

### 4.1 FCL — grouped booking selector

```
▼ INQ-2026-000042  ·  QTN-2026-000031  ·  Shafidi  ·  Chittagong → Hamburg  ·  SITC  ·  V.2609E
     ☐  BKG-2026-000101   Exporter A   340 CTN   18.0 CBM   received
     ☐  BKG-2026-000102   Exporter B   180 CTN    9.5 CBM   received
     ☐  BKG-2026-000103   Exporter C   120 CTN    6.0 CBM   part received
                                    [ Make CLP from selected ]
```

Group header carries what the bookings share (inquiry, quotation, customer, lane, carrier, vessel);
child rows carry what differs (booking, exporter, cargo, receipt status). Selecting rows across two
different group headers is blocked, with the reason shown.

### 4.2 LCL — flat multi-select pool

Filters first, because the pool is the whole CFS: POL · POD · Carrier · Vessel/Voyage · Cut-off week
· CFS location. Then a flat list with checkboxes across customers, and a running strip at the bottom
as boxes are ticked:

```
4 bookings selected  ·  3 customers  ·  610 CTN  ·  31.4 CBM  ·  8,240 kg
Fits: 40HC (72 CBM) — 43% volume, 32% weight
```

That running total is what makes the screen usable — an LCL planner is answering "what else fits in
this box", and they need the number to move as they tick.

### 4.3 Inside the CLP itself

The cargo pool grid gains a **Booking** column (and Exporter for LCL), placed before PO. Colour bands
in the virtual container group by **booking** for consolidated CLPs and by **PO** for single-booking
ones — on a consolidated box, whose cargo is where matters more than which PO.

---

## 5. KEEP CLP AS ITS OWN SCREEN

You asked whether CLP could live inside Cargo Receipt instead. **It should not**, and requests 1 and 2
are the reason:

- A Cargo Receipt is scoped to **one booking**. A consolidated CLP spans several. A screen scoped to
  one receipt structurally cannot host a plan that covers six bookings from three customers.
- The **timing differs.** Receipts arrive over days as trucks turn up; the CLP is made once, when
  enough cargo is in to fill a box. Putting the plan inside the receipt implies planning at receipt
  time, which is not how the floor works.
- The **people differ.** A receiving clerk accepts cartons; a load planner decides what goes in the
  container. Those are separate permissions (`OPS.CARGO_RECEIPT` vs `OPS.CLP`) and often separate
  people.
- CLP has its own list, its own DRAFT/FINAL lifecycle, and its own signed print document.

**Do add the shortcut**, though: a `Make CLP` action on the Cargo Receipt row that opens the CLP
screen with that booking pre-selected. That gives you the convenience without merging two different
jobs into one screen.

---

## 6. CARGO RECEIPT: SEPARATE THE VIEW, NOT THE TABLE

Two menu entries — `Cargo Receipt - FCL` and `Cargo Receipt - LCL` — are fine, and worth having.
**One schema and one component behind them**, filtered on `loading_type`.

The reason is the same one that applies to the Sea/Air booking screens: the part-delivery and balance
logic in `MODULE_BOOKING_CARGO.md` §5.5 is the most intricate and highest-risk code in that module.
Fork the table and you fork that logic into two copies that will drift, and a bug fixed in the FCL
balance calculation will quietly persist in the LCL one.

What genuinely differs between them is **conditional fields, not structure**:

- LCL usually needs a **re-measurement** step at CFS — the forwarder re-measures and re-weighs because
  LCL is billed per CBM and shippers under-declare. Add `remeasured_cbm`, `remeasured_gross_weight_kg`
  and a variance flag, shown only when `loading_type = 'LCL'`.
- FCL receipts are often whole-container drops and can default to accepting the full booked quantity
  in one action.

Both are conditional rendering over one table. If the client insists the two forms look completely
different, that is still a view decision — say so and keep the schema single.

---

## 7. QUESTIONS

1. **FCL merge — is "same quotation" a hard rule or the default grouping?** §3 recommends making the
   physical rules (same lane, carrier, vessel, CFS) the hard constraint, with quotation as the default
   grouping a user can step outside for the same customer. Confirm which you want enforced.
2. **Can an FCL booking and an LCL booking ever share a container?** §3 rule 8 says no. Confirm — if
   a "FCL" booking that under-fills can be topped up with LCL cargo, that rule changes.
3. **For LCL, can bookings going to different final destinations share a container** if they share the
   POD? Common in practice (deconsolidation at destination CFS), but it affects the merge rules.
4. **Does LCL need the CFS re-measurement step** described in §6? If billing is per CBM, you almost
   certainly do, and it should go in now rather than after the first billing dispute.
5. **On a consolidated CLP, how is the container cost split** across the participating bookings for
   invoicing? LCL is billed per CBM so it resolves itself, but an FCL box shared across three
   exporters on one quotation needs an apportionment rule. This lands in Accounts, but it originates
   here — worth deciding before the CLP is built so the data needed for it is captured.

---

## 8. EFFORT IMPACT

This is a real addition, not a tweak. On top of the revised CLP figure in `MODULE_CLP.md` §9:

| Item | Man-days |
|---|---|
| Multi-booking schema, `clp_booking`, numbering rework | 2 |
| Compatibility rule engine + server-side enforcement | 2 |
| FCL grouped selector | 1.5 |
| LCL multi-select pool with live fit calculation | 2 |
| LCL re-measurement fields on Cargo Receipt (if adopted, Q4) | 1.5 |
| **Added to Sea CLP** | **~9** |

Sea CLP moves from ~12–14 to roughly **21–23 man-days**. Air ULD build-up remains separate at 8–10,
and will inherit the same consolidation model — which is an argument for building the compatibility
engine generically now rather than twice.

---

# ADDENDUM — IMPACT ASSESSMENT AGAINST THE BUILT MODULE

> Written 2026-09-15, after surveying the code and the database. Nothing in
> §1–§8 above has been altered; this records what changed between the CR being
> written and being read.

## A. The timing assumption no longer holds

The header says **"Apply this before Phase B of the CLP build, not after."**
Phases A→H are built, tested and deployed: `clp` and `clp_line` exist with RLS,
audit triggers, check constraints and live rows, and production carries
finalised CLPs with signed print documents against them.

So this is now a **migration**, not a schema decision. That is worth saying
plainly because it changes what the work is, not just how long it takes.

## B. The blast radius is smaller than the CR assumes

Measured rather than estimated:

- **Only `clp_line` has a foreign key to `clp`.** No other module joins to it.
- `clp.shipment_id` is referenced in **48 places across 8 files**, all inside
  the CLP module: `clp.route.ts`, `packages/shared/src/clp.ts`, two web pages
  and five test files.
- Every column the compatibility rules need already exists:
  `shipment.loading_type`, `pol_id`, `pod_id`, `carrier_id`, `shipment_type`,
  `status`.

The module was built self-contained, so the retrofit is mostly internal. The
genuinely new costs are the **data migration** (§C) and the **numbering
change** (§D), neither of which the CR's 9 man-days accounts for — it was
priced as greenfield.

## C. Existing CLPs have to be migrated

`clp_booking` starts empty. Every existing CLP needs a row generated from its
current `shipment_id` before that column can be dropped, in the same migration,
or finalised plans lose the booking they belong to:

```sql
INSERT INTO clp_booking (tenant_id, clp_id, shipment_id, shipping_order_id)
SELECT tenant_id, id, shipment_id, shipping_order_id FROM clp;
```

Their `consolidation_type` becomes `SINGLE`. This must ship as one migration
with the column drop — a release that lands the new table without the backfill
leaves production unable to say which booking a container belongs to, and
CLAUDE.md's deployment note already records that the VPS 500s on any release
whose migration has not run.

## D. Two corrections the CR needs before it can be built

**1. `schedule_id` cannot work as written.** §2 proposes
`clp.schedule_id FK shipment_schedule`, and §3 rule 3 says bookings must share
it. But `shipment_schedule` is keyed **per shipment** — it carries
`shipment_id`, `version_no` and a PROPOSED/ACCEPTED status. Two bookings on the
same sailing therefore have two *different* schedule rows, so "same
`schedule_id`" is not merely restrictive, it is unsatisfiable: no two bookings
can ever pass it.

The sailing identity actually lives one level down, on
`shipment_schedule_leg.(vessel_id, voyage_no)`. Rule 3 has to compare those,
on each booking's ACCEPTED schedule. The CR calls this "the one that catches
real mistakes", which is exactly why it should not ship as written.

**2. `cfs_location` has no single source.** §2 adds `cfs_location TEXT` to
`clp` and rule 5 requires bookings to share it, but the only such field today is
`cargo_receipt.unload_location` — recorded **per receipt**. A booking whose
cargo arrived in three deliveries can have three. Whether the rule means "every
receipt agrees", "the latest one", or a new field on the booking is a decision,
not a detail.

## E. What is not blocked

§5 (keep CLP its own screen) is already how it is built, and the `Make CLP`
shortcut from Cargo Receipt is a small, independent addition that needs no
schema change and no answers.

§6's FCL/LCL view split is likewise independent of §2, and the recommendation —
one table, two filtered views — matches what the codebase already does for
Sea/Air bookings.

## F. Effort, revised

| Item | CR estimate | Revised | Why |
|---|---|---|---|
| Multi-booking schema + `clp_booking` + numbering | 2 | 3 | adds migration of live rows, and `clp_seq` is on the print document and both screens |
| Compatibility rule engine | 2 | 2 | unchanged; every input column exists |
| FCL grouped selector | 1.5 | 1.5 | unchanged |
| LCL multi-select pool | 2 | 2 | unchanged |
| LCL re-measurement (Q4) | 1.5 | 1.5 | unchanged |
| Rework of built CLP screens, print document and 5 test files | — | 2 | not in the CR; this is the cost of arriving after Phase H |
| **Total** | **~9** | **~12** | |

---

# ADDENDUM 2 — THE CLIENT'S LOADING-TYPE SHEET (2026-09-16)

> The client sent a one-page sheet with four example tables, one per loading type.
> Where it disagrees with §3 above or with the 2026-09-15 decisions, **the sheet wins**.
> §1–§8 and Addendum 1 are left unaltered.

## G. What the sheet says

| Type | Inquiry → Quotation → Booking | Customer / Exporter | EFR No |
|---|---|---|---|
| **FCL** (customer = exporter) | 1 → 1 → 1 booking, 2 POs, `1x40HC` | ABC / ABC | one, `EFR-001`, covering both POs |
| **FCL** (customer ≠ exporter) | 1 → 1 → 1 booking, 2 POs, `1x40HC` | ABC / XYZ | one, `EFR-001` ("1 HBL") |
| **LCL** | 1 → 1 → 3 bookings, 1 PO each, `1x40HC` | ABC / ABC, XYZ, KLM | one per booking, `EFR-001…003` |
| **Consol box** | 1 → 1 → 1 booking, 2 POs, no container | ABC / ABC | `EFR-001`, `EFR-002`, though the heading says "1 EFR" |

And one instruction: *"multiple exporter's PO will select by check box and make CLP."*

## H. Decisions, confirmed 2026-09-16

| # | Question | Answer | Supersedes |
|---|---|---|---|
| 1 | Can two FCL bookings share one container? | **No.** An FCL container holds one booking. Several exporters in one box is LCL. | §3 "FCL — group by quotation", §4.1 |
| 2 | Can LCL bookings from different customers share a container? | **Yes**, as §3 already said. The list gains an Inquiry → Quotation grouping. | — |
| 3 | Which bookings can share a Consol box? | **Any customers.** Consol box is its **own workflow**, never mixed with FCL or LCL. | 2026-09-15 "CONSOL_BOX is FCL-like" |
| 4 | How is the plan made? | **Tick POs.** `Create container plan` makes the plan *and* loads every received, unplanned carton of each ticked PO. Split and Remove still work inside the plan. | booking-level ticking |

Physical rules 1–8 of §3 are unchanged and apply to every workflow.

## I. How it is built

- **Rule 9** in `clp-consolidation.ts`: a second FCL booking in a selection is refused, naming both bookings and saying to book them as LCL.
- **Three workflows**, one per `shipment.loading_type`: `FCL`, `LCL`, `CONSOL_BOX`. The creation screen, the planning queue and the CLP register each have a tab per workflow.
- **`POST /clps/consolidate`** takes `shipmentPoIds`. It checks the rules, refuses POs that would overfill the chosen container before writing anything, creates the plan, then loads each PO through the same `allocate()` that `add` uses, in one transaction. `shipmentIds` still works and creates an empty plan; sending both is refused.
- **`POST /clp-candidates/check`** takes `shipmentPoIds` too. For ticked POs its totals are what ticking loads, not what arrived.
- **EFR No** stays on `cargo_receipt.efr_no`, where the cargo receipt wireframe put it. A cargo line's EFR numbers are read from the confirmed receipts its accepted cartons came in on (`clp-efr.ts`). They show on the candidate list, the pool, the loaded lines and the printed CLP (new last column `EFR NO`). **No schema change**, and **no EFR count is enforced** — a booking delivered on two receipts has two, which is exactly the Consol box table.
- **`consolidation_type`**: a new multi-booking plan (LCL or Consol box) is stored as `LCL_CONSOLIDATION`. Which of the two it is comes from the bookings' loading type. `FCL_QUOTATION` stays in the enum for plans that already have it, and can no longer be created.

## J. Not done, and why

- **Existing plans are not re-judged.** A draft that already merges two FCL bookings keeps its bookings. Rule 9 applies when a plan is created. The dev database has none; production was not checked.
- **N.WT and Req. Cont.** are on the sheet's tables but not on the creation list. The plan screen still shows N.WT per line and the booking's Required Container in its reconciliation banner.
- **The Consol box's "1 EFR" heading against its two-EFR table** is left unresolved, since nothing enforces a count. Raise it with the client if EFR ever needs to be one per booking.

## K. One Container Load Plan screen (2026-09-17)

The list and the "New container plan" screen showed the same bookings twice, in two layouts, under three names ("Cargo Load Plan", "Container Load Plan", "New container plan"), and the list's `Make CLP` opened a different way of planning from `+ New container plan`. They are now one screen, **Container Load Plan**, with the same controls on both tabs:

| Tab | What it is |
|---|---|
| **To plan** | The PO-ticking view (§I): Inquiry · Quotation · customer as a group header, then booking → PO rows, the running strip and `Create container plan`. `Open` on each booking reaches its own plan page — more containers, Split, finalising. |
| **Container plans** | The register, on the product's standard list table: row numbers, CLP No on the code gutter, pager, density toggle. |

- One workflow switch, **All · FCL · LCL · Consol box**, on both tabs. The tab and workflow live in the URL, so Back from a booking's plan returns to them.
- `/operation/container-load-plan/new` redirects to the To plan tab, keeping `booking` and `family`; Cargo Receipt's `Make CLP` links straight to the new address.
- The booking plan page is headed "Container Load Plan · Containers for this booking", and its container picker is titled "Add a container".
- A consol box's Required Container reads "None — our consol box" instead of the inquiry's weight ("60 Kg").
- A fully planned PO reads "Planned in CLP-…" with one **View / edit** button (**View** once final) that opens its booking's plan scrolled to that container, and aims add and Split at it. A partly planned PO carries the same link under its carton count. The register's action uses the same words and lands on the same card.

Server changes that came with it:

- `GET /clp-candidates` — `family` is optional (All), each row carries `requiredContainer`, search also matches PO numbers, and "Same sailing" suggestions count only bookings with cargo left, totalled on what is left.
- `GET /clps` — search now finds a shared container by any of its bookings or their customer (it matched only `clp.shipment_id`, which a consolidated plan does not have).
- `plannedCount` counts shared containers, so a booking in one no longer reads "0 planned" beside "All assigned".

**Fixed (2026-09-17), migration `20260917090000_rls_estimable_tenant_check`:** the slow queue was not the CLP code. Every tenant-owned RLS policy read `tenant_id = app_current_tenant() AND app_current_agent() IS NULL`, which Postgres estimates at 0.5% of any table, so queries filtering through related tables nested full scans (`GET /clp-bookings`: 9 s at ~90 bookings, failing on the 5 s transaction limit). The 65 tenant-owned policies now read `tenant_id = app_staff_tenant()` — the tenant for staff, NULL for agents — which admits exactly the same rows and is estimated from real statistics. Proven in a rolled-back transaction: identical visibility for staff, another workspace, an agent and no workspace on all 81 RLS tables; forbidden writes still refused; the query 1,205 ms → 0.4 ms. The 16 system-capable policies and every agent-portal policy are unchanged. `tenant-isolation.test.ts` now fails if a new table's policy uses the old form, or if a tenant table is estimated at one row. **The VPS needs `pnpm db:deploy` with the release that carries it.**
