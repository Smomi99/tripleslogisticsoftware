# MODULE SPEC — CONTAINER LOAD PLAN (CLP) — SEA · **v2, client-confirmed**

> **How to use.** Save as `/docs/MODULE_CLP.md`, **replacing v1**. Start a Claude Code session with:
> *"Read CLAUDE.md, then /docs/MODULE_CLP.md. We are building Phase A. Show me the schema before any
> migration."*
> `CLAUDE.md` governs stack, tenancy, RBAC, screen patterns and design tokens.
> Depends on `/docs/MODULE_BOOKING_CARGO.md` — shipment, PO, cargo lines and cargo receipt must exist.
> **Contains a change request against that module — see §2.3.**

---

## 0. DECISIONS LOCKED BY THE CLIENT

| # | Question | Answer | Effect |
|---|---|---|---|
| 1 | Allocate from received or booked? | **Received quantities** | §2.4 confirmed |
| 2 | Is the split ratio carton-driven? | **Yes** | §2.3 confirmed |
| 3 | Can PCS / weights be overridden after split? | **No — carton is the unit of work; PCS and weight follow the carton and are calculated** | §2.3 **rewritten** — override removed, per-carton values now the source of truth |
| 5 | ISO 6346 validation? | **Enforce, with check digit** | §5.2 hard validation |
| 7 | Editable after FINAL? | **No** | §4.3 confirmed — cancel and recreate only |
| 8 | Air equivalent? | **Yes — ULD build-up, not containers** | Separate module, see §9 |
| 9 | Where does CLP sit? | **After goods received at CFS, before physical stuffing** | §1 confirmed; Stuffing executes the CLP |

**Still open — see §8.** Q4 (block vs warn on over-volume) and Q6 (Supervisor) came back without a
decision. Both have a working default below so the build is not held up.

---

## 1. WHERE THIS SITS

```
… Shipping Order → Cargo Receipt (goods in at CFS) → ► CLP ◄ → Physical Stuffing → Shipment Advise → BL …
```

Client's wording: the CLP is made **after the goods are received at CFS and before the physical
stuffing of the container**. So CLP is the *plan*; Stuffing is the *execution* of that plan against
real cartons. Stuffing therefore consumes a finalised CLP — build the hand-off with that assumption.

Two screens: `Cargo Load Plan - SEA` (build the plan) and `List of CLP - SEA` (finalise and print).

---

## 2. ARCHITECTURAL DECISIONS

### 2.1 CLP is an allocation ledger, not a form

One PO can go into two containers; one container holds several POs. The client's own sample does
this — PO-003 appears in both CLP 1 and CLP 2. That is a many-to-many allocation with a conservation
rule:

> For every cargo line: `Σ allocated across all CLPs ≤ quantity received`. Always.

```
clp          one row per container
clp_line     one row per (container, cargo line) allocation, with its own carton quantity
```

Never store "which container is this PO in" on the cargo line.

### 2.2 `add` and `Split` are the same operation

- `add` → allocate the **entire remaining** cartons of that line to the selected CLP
- `Split` → allocate **part** of them, the user types the carton count

One `allocate(cargo_line, clp, ctn_qty)` service. `add` passes the full remaining balance. Two code
paths means two places for the conservation rule to break, and only one gets fixed.

### 2.3 **The carton is the only number a user types** — everything else is calculated

The client was explicit: *"Carton represents the PCS and weight, so if carton split the PCS and
weight also be split accordingly. In fact we need to calculate PCS. We always work at carton level."*

This is stronger than v1 assumed, and it simplifies the whole module. **Remove the override.** PCS,
net weight, gross weight and CBM are derived from the carton count and are never editable on the
CLP screen.

**Change request to `MODULE_BOOKING_CARGO.md` §4.1** — store per-carton unit values on the cargo
line, so every downstream split is exact by construction rather than by ratio arithmetic:

```
shipment_cargo_line
  ADD  pcs_per_carton          NUMERIC(18,6) GENERATED ALWAYS AS (pcs_qty         / NULLIF(ctn_qty,0)) STORED
  ADD  net_weight_per_carton   NUMERIC(18,6) GENERATED ALWAYS AS (net_weight_kg   / NULLIF(ctn_qty,0)) STORED
  ADD  gross_weight_per_carton NUMERIC(18,6) GENERATED ALWAYS AS (gross_weight_kg / NULLIF(ctn_qty,0)) STORED
  ADD  cbm_per_carton          NUMERIC(18,6) GENERATED ALWAYS AS (volume_cbm      / NULLIF(ctn_qty,0)) STORED
```

Booking data entry does not change — the user still types totals, and the per-carton values derive
from them.

> **Built 2026-09-13, with one correction.** `cbm_per_carton` cannot be written as
> `volume_cbm / NULLIF(ctn_qty,0)`: `volume_cbm` is itself a generated column and Postgres refuses
> — *"a generated column cannot reference another generated column"*. It is stored as the carton's
> own volume instead, `(L × W × H) / 1000000`, which is the same number, since `volume_cbm` is
> exactly that multiplied by the carton count. `chargeable_wt_kg` on the same table already works
> around the identical restriction.

**The rounding rule — implement exactly; it is the one place this module can silently lose data.**

Per-carton values rarely divide evenly (the client's own PO-003 is 5,000 PCS over 300 cartons =
16.667 per carton). Rounding each split independently means the parts stop summing to the whole:

```
for an allocation of n cartons:

  if n < cartons still unallocated:            -- an intermediate split
      pcs  = ROUND(pcs_per_carton          × n)
      nwt  =       net_weight_per_carton   × n
      gwt  =       gross_weight_per_carton × n
      cbm  =       cbm_per_carton          × n

  if n = cartons still unallocated:            -- the LAST allocation for this line
      pcs  = pcs_qty         − Σ(pcs already allocated)
      nwt  = net_weight_kg   − Σ(nwt already allocated)
      gwt  = gross_weight_kg − Σ(gwt already allocated)
      cbm  = volume_cbm      − Σ(cbm already allocated)
```

The final allocation absorbs the rounding remainder, so once a line is fully allocated the parts sum
to the original **exactly**. Assert it in a test: split one line three uneven ways and check every
measure reconciles.

If an allocation is later removed or changed, **recompute the whole line's allocations** rather than
patching one row — otherwise the remainder stays attached to a split that is no longer last.

> **Confirmed 2026-09-13 — which totals the remainder reconciles to.** The pool is drawn from the
> receipt (§2.4), and the **booked line totals stay the reference and the remainder basis**. So the
> last allocation subtracts from `pcs_qty`, `net_weight_kg`, `gross_weight_kg` and `volume_cbm` on
> `shipment_cargo_line`, exactly as written above.
>
> Where a line is received in full — the ordinary case — the two bases are the same number and this
> is simply the rule as drafted. They diverge only on a short receipt: 280 cartons arriving against
> 300 booked means the pool empties at 280, and the final allocation then absorbs the pieces and
> weight of the 20 cartons that never arrived. On the client's own PO-003 that is 5,000 pieces
> recorded against 280 cartons. Implement as confirmed; raise it again if a short receipt ever
> reaches a printed CLP.

### 2.4 CLP packs what was received — confirmed

```
available_cartons = Σ accepted cargo_receipt_line ctn  −  Σ already allocated to active CLPs
```

Not booked quantity. If 280 of 300 cartons arrived, the pool offers 280. Declined receipt lines never
enter the pool.

> **Confirmed 2026-09-13.** Quantity, weight and volume all come from `cargo_receipt_line` —
> `received_ctn_qty`, `received_net_weight_kg`, `received_gross_weight_kg`, `received_volume_cbm` —
> for what may be allocated and for what the container is carrying. The booked totals on
> `shipment_cargo_line` remain the reference they are compared against.

---

## 3. SCHEMA

Inherits `CLAUDE.md` §4 conventions: `tenant_id` first, `code`, `is_active`, audit columns, soft
delete, tenant-safe composite FKs.

### 3.1 Container capacity master (Settings)

```
container_size
  id, tenant_id, code, name, sort_order
  max_volume_cbm  NUMERIC(10,2)
  max_weight_kg   NUMERIC(12,2)
  tare_weight_kg  NUMERIC(12,2) NULL
  teu_factor      NUMERIC(4,2)

  seed from the client's table:
    20STD   28 CBM    26,000 kg
    40STD   65 CBM    26,000 kg
    40HC    72 CBM    26,000 kg
    45FT    80 CBM    30,000 kg
```

Editable in Settings — these limits vary by carrier and lane, and the client will want to change them.

> **Confirmed 2026-09-13.** `container_size` is system-capable (`CLAUDE.md` §7A rule 7): the four
> seeded sizes are shared with every workspace and stay **read-only**. A workspace that needs its
> own capacity uses **Customise** (CR-003), which copies the row into the workspace and repoints
> existing references at the copy. The Settings screen therefore offers Customise rather than Edit
> on a shared size, which is what the list already does.
>
> Capacities are **nullable**. The four seeded sizes are backfilled, but a workspace may have added
> a size before the column existed, and §4.2 must read a missing limit as *"capacity not set"* —
> never as unlimited.

### 3.2 CLP

```
clp
  id, tenant_id, code, clp_no (CLP-2026-000001)
  shipment_id        FK shipment
  shipping_order_id  FK shipping_order NULL
  clp_seq            INT                     -- "CLP No : 1" within the shipment
  container_size_id  FK container_size
  carrier_id         FK carrier
  container_no       TEXT NULL               -- ISO 6346, validated; required at FINAL
  seal_no            TEXT NULL               -- required at FINAL
  load_datetime      TIMESTAMPTZ NULL
  loaded_by          TEXT NULL
  supervisor_employee_id FK employee NULL    -- see §8 Q6
  tally_man_name     TEXT NULL               -- free text, client-confirmed
  status             ENUM('DRAFT','FINAL','CANCELLED') DEFAULT 'DRAFT'
  finalised_by, finalised_at
  cancelled_by, cancelled_at, cancel_reason TEXT
  capacity_override_by, capacity_override_reason TEXT
  -- rollups, recomputed on every line change:
  total_ctn_qty INT, total_pcs_qty INT,
  total_net_weight_kg NUMERIC(18,3), total_gross_weight_kg NUMERIC(18,3),
  total_volume_cbm NUMERIC(18,4),
  volume_utilisation NUMERIC(5,4), weight_utilisation NUMERIC(5,4)
  UNIQUE (tenant_id, shipment_id, clp_seq)
  INDEX (tenant_id, shipment_id, status)

clp_line
  id, tenant_id, clp_id FK
  shipment_cargo_line_id FK shipment_cargo_line
  shipment_po_id         FK shipment_po
  po_no TEXT, item_code TEXT, sku TEXT        -- snapshot for the printed document
  ctn_qty INT NOT NULL CHECK (ctn_qty > 0)    -- the ONLY user-entered quantity
  pcs_qty INT, net_weight_kg NUMERIC(18,3), gross_weight_kg NUMERIC(18,3),
  volume_cbm NUMERIC(18,4)                    -- all calculated per §2.3
  carton_length, carton_width, carton_height NUMERIC(10,3)
  is_split BOOLEAN DEFAULT false
  is_final_allocation BOOLEAN DEFAULT false   -- carries the rounding remainder
  UNIQUE (tenant_id, clp_id, shipment_cargo_line_id)
```

---

## 4. BUSINESS RULES

### 4.1 Conservation — enforce in the database

Inside the allocation transaction:

```sql
SELECT COALESCE(SUM(ctn_qty),0) FROM clp_line
WHERE shipment_cargo_line_id = :line
  AND clp_id IN (SELECT id FROM clp WHERE status <> 'CANCELLED')
FOR UPDATE;
```

Reject when `already_allocated + new_qty > received_qty`. `FOR UPDATE` is not optional — two planners
on the same booking in two tabs is the realistic case, and last-write-wins means cartons loaded twice
on paper and a container that will not close.

Error text must be concrete: *"PO-003 has 40 cartons left to allocate. You entered 80."*

### 4.2 Capacity — **block both, with a logged supervisor override**

The client's answer repeated the question rather than choosing one, so this is the working default
until they confirm (§8 Q1):

- **Weight over 100% → blocked.** An overweight container is a legal and safety matter at the port.
- **Volume over 100% → blocked**, but a user holding `OPS.CLP.OVERRIDE_CAPACITY` may proceed with a
  mandatory reason, recorded on the CLP and in `audit_log`.

This satisfies either reading of their answer: nobody loads an over-capacity container by accident,
and a supervisor can still do it deliberately when the cartons genuinely compress. Show both
utilisation bars from the first allocation, not only when exceeded.

Note the client plans a 20STD to exactly 28.0 CBM — 100% of stated capacity. Treat `= 100%` as
allowed and only `> 100%` as an exception, or every plan they make will trip the block.

### 4.3 Status — FINAL is immutable (confirmed)

```
DRAFT → FINAL       requires container_no (ISO 6346 valid), seal_no, load_datetime, ≥1 line
DRAFT → CANCELLED   any time, by anyone with EDIT
FINAL → CANCELLED   privileged, reason mandatory, blocked once Stuffing has started
FINAL → (no edit path exists)
```

Cancelling a FINAL CLP releases its allocations back to the pool and creates a fresh `clp_seq`; the
cancelled record is retained with its lines for audit.

Because there is no edit path, the finalisation dialog must be a real confirmation step — show
container number, seal, carton total and both utilisation figures, and require an explicit confirm.
Re-keying a container plan is expensive, so the UI has to make the finality obvious before the click.

`PRINT` works in both states; a DRAFT print carries a **DRAFT** watermark.

### 4.4 Reconciliation against the booking

Compare CLPs created against the booking's `Required Container` and show a non-blocking banner on
mismatch: *"Booking declares 1×20STD + 1×40HC. This plan uses 1×20STD + 2×40HC."* Never block — the
real cargo decides, and that difference is exactly what customer service needs to see and re-quote.

Always show the unallocated balance: *"3 POs fully allocated. PO-004 has 20 cartons unassigned."*

### 4.5 Numbering

- `clp_seq` — 1, 2, 3… within the shipment. This is the "CLP No : 1" on the client's cards.
- `clp_no` — document number, unique per tenant: `CLP-2026-000001`.
- Both print on the document. Do not use one for the other.

---

## 5. SCREENS

Follow `CLAUDE.md` §8 and §12. Quantities, weights, volumes and dates in IBM Plex Mono, tabular
figures, right-aligned.

### 5.1 Cargo Load Plan - SEA

**Top — booking selector.** Booking No · S/O No · Customer · Exporter · Commodity · Shipment Type ·
POL/AOL · POD/AOD · Required Container · Carrier · Cut off · ETD · ETA · Status · Action `Make CLP`,
with search above.

**`Select Container`** (20STD / 40STD / 40HC / 45FT) creates a new draft CLP card and reveals its
capacity.

**Cargo pool grid:** `PO · Item · SKU · CTN Qty · PCS Qty · PO's Total N.WT · PO's Total G.WT ·
[Carton Size: L · W · H] · PO's Total CBM · DC · Action`.

- Quantities shown are **remaining to allocate**, drawn from accepted receipts — the grid shrinks as
  the planner works.
- Action per row: `add` · `Split`. Fully allocated rows leave the pool.
- Footer strip exactly as drawn: `Count PO · Count Item · Count SKU · Sum CTN · Sum PCS · Sum N.WT ·
  Sum G.WT · Sum CBM · Assign`.

**Split dialog — carton input only.** One editable field; everything else is read-only and
recalculates live:

```
              Available        Use        Remaining
Cartons            100      [  80 ]              20     ← only editable cell
Pieces           7,000       5,600           1,400
Net weight      3,520 kg    2,816 kg         704 kg
Gross weight    3,620 kg    2,896 kg         724 kg
Volume          10.00 CBM   8.00 CBM        2.00 CBM
```

A direct consequence of the client's answer — the planner works in cartons, the system does the rest.

**CLP cards side by side:** `CLP No : n`, POs assigned with their CBM, container `SIZE`,
`Volume Load`, and a `DRAFT CLP` button.

**Virtual container** — requested twice by the client. Inline SVG: a container outline at the size's
aspect ratio, filled left-to-right in proportion to volume used, **one colour band per PO** with the
PO number labelled on its band. Beneath it, two thin bars for volume and weight utilisation showing
percentage and remaining capacity. §12 palette; a bar crossing 100% turns `--alert`. The picture is
what makes an over-stuffed plan obvious at a glance.

### 5.2 List of CLP - SEA

Columns: Booking No · S/O No · Customer · Exporter · Commodity · Shipment Type · POL/AOL · POD/AOD ·
Required Container · Carrier · CLP No · Status · Action (`FINAL` · `PRINT`).

Finalisation panel per CLP: `Container no` · `Seal no` · `Carrier` · `Load date & time` ·
`Supervisor` · `Tally man` · `SAVE CLP`.

**Container number — ISO 6346 enforced (client-confirmed).** Format is 4 letters + 7 digits: a
3-letter owner code, an equipment category letter (`U` for freight containers), a 6-digit serial and
a check digit. Validate the format **and compute the check digit**, rejecting a mismatch with a
specific message: *"Check digit should be 3, not 7. Please verify the container number."*

Put the algorithm in one shared utility — Stuffing, BL and the customs declaration will all need it.

`Tally man` is free text (client-confirmed). `Supervisor` is a lookup to the Employee master — see
§8 Q2.

### 5.3 CLP document (print)

Header: tenant letterhead · `CONTAINER LOAD PLAN` · Carrier · CLP No · Booking No · S/O No ·
Container No · Seal No · Load Date & Time · Load By.

Table: `CLP NO · PO · Item · SKU · CTN Qty · PCS Qty · PO's Total N.WT · PO's Total G.WT ·
L · W · H · PO's Total CBM`, with a **TOTAL** row showing PO count and column sums — matching the
client's sample: `3 PO · 780 · 11,000 · 11,300 · 12,100 · 28`.

Signature blocks: Supervisor · Tally Man · Carrier representative. One page per container, legible at
A4 — this is signed on the warehouse floor.

---

## 6. PERMISSIONS

```
OPS.CLP     VIEW  CREATE  EDIT  SPLIT  FINALISE  CANCEL  PRINT  OVERRIDE_CAPACITY
```

`FINALISE`, `CANCEL` and `OVERRIDE_CAPACITY` sit with a supervisor. Since FINAL cannot be edited,
`FINALISE` is effectively irreversible — treat it with the same care as issuing a shipping order.

---

## 7. BUILD ORDER

| Phase | Prompt | Done when |
|---|---|---|
| A | "Add capacity columns to `container_size` with the client's seed values, plus the Settings screen. Also apply the §2.3 change request to `shipment_cargo_line`." | 4 sizes with limits; per-carton columns exist |
| B | "Add the §3.2 CLP schema. Show me the constraints before migrating." | Reviewed |
| C | "Build `allocate()` — §4.1 conservation under `FOR UPDATE`, §2.3 carton-derived quantities with the remainder rule. **Write the tests first**: over-allocation, concurrent allocation, three uneven splits reconciling exactly, allocation removal and recompute." | Tests pass, including concurrency and rounding |
| D | "Build the CLP screen: booking selector, container select, cargo pool with add/split, carton-only split dialog, CLP cards." | A two-container plan saves as draft |
| E | "Build the virtual container SVG with per-PO colour bands and utilisation bars." | Over-capacity visible at a glance |
| F | "Add §4.2 capacity blocking with logged override, and §4.4 reconciliation banners." | Both limits block; override logs |
| G | "Build the ISO 6346 validator as a shared utility with check-digit tests, then the CLP list and finalisation panel." | Invalid container numbers rejected |
| H | "Build status transitions incl. cancel-and-release, and the print document with DRAFT watermark." | A CLP finalises, locks and prints |

**Phase C carries the risk.** Everything else is screens; that one is arithmetic deciding what
physically goes into a steel box, and the rounding rule is where it will fail quietly if it fails.

---

## 8. REMAINING QUESTIONS — both now answered

1. **Over-volume: block or warn?**

   > **Confirmed 2026-09-13.** Over-capacity is **BLOCK by default**, with a **Supervisor Override**
   > that requires a written reason and is written to `audit_log`. Built in Phase F: weight is never
   > overridable, volume is overridable by a holder of `OVERRIDE_CAPACITY`, and the reason is shown
   > on the container it excuses as well as recorded. Exactly 100% is allowed; only above it is an
   > exception.

2. **Supervisor — Employee master or free text?**

   > **Confirmed 2026-09-13.** Supervisor stays an **Employee FK** (`supervisor_employee_id`), not
   > free text. Tally Man remains free text. The supervisor signs for the load, so a named employee
   > reference is what a dispute needs; tally men are often casual or third-party CFS staff.

---

## 9. SCOPE ADDED BY THIS ROUND — AIR ULD BUILD-UP

The client confirmed an air equivalent exists and uses **ULD build-up**, not containers. That is a
genuinely different screen, not a variant:

- ULD types (AKE, AMA, PMC, PAG…) with their own volume and weight limits, plus loose/bulk loading
- Chargeable weight rather than CBM as the governing constraint
- ULD identifiers follow IATA format, not ISO 6346
- Pallet build-up and contour rules rather than door-to-door stuffing

**Not built here, and no wireframe exists yet.** Two consequences worth raising now:

- Request the ULD build-up wireframe **before** Operation is scheduled, so the allocation service in
  §2.2 can be designed once for both modes rather than retrofitted around a container-shaped API.
- **It is not in the quotation.** Operation priced `Container Load Plan (CLP)` at 8 man-days as a
  single line. Sea CLP alone is realistically **12–14 man-days** with the allocation ledger, rounding
  rule, concurrency safety, ISO validation, virtual container and print document. Air ULD adds a
  further **8–10**. Revise that line to roughly **20–24 man-days**, or absorb it knowingly.
