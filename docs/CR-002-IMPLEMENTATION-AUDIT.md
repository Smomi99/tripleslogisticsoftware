# CR-002 — IMPLEMENTATION AUDIT

> The §21 deliverable: what the code and database actually contain today,
> before any schema change. Measured 2026-09-15 against the live repository and
> the development database, not against the CR's description.

---

## 1. Current relevant schema

```
clp          tenant_id id code series_year clp_seq shipment_id shipping_order_id
             container_size_id carrier_id container_no seal_no load_datetime
             loaded_by supervisor_employee_id tally_man_name status
             finalised_by finalised_at cancelled_by cancelled_at cancel_reason
             capacity_override_by capacity_override_reason stuffing_started_at
             total_ctn_qty total_pcs_qty total_net_weight_kg
             total_gross_weight_kg total_volume_cbm
             volume_utilisation weight_utilisation
             is_active created_at updated_at created_by updated_by deleted_at

  CHECK      clp_final_ck   clp_cancel_ck   clp_override_ck
             clp_seq_ck     clp_totals_ck
  UNIQUE     (tenant_id, code)   (tenant_id, shipment_id, clp_seq)

clp_line     FKs shipment_cargo_line, shipment_po, clp
             snapshots carton_length/width/height_cm and the derived
             pcs/net/gross/volume for its own ctn_qty
```

**Only `clp_line` has a foreign key to `clp`.** Nothing else in the schema
depends on it, which is what makes this retrofit affordable.

## 2. Current CLP relationships

`clp.shipment_id` → one booking. `clp_seq` is that container's position
*within that booking*, unique per `(tenant_id, shipment_id, clp_seq)`, and it
is what the screens print as "CLP No : 1".

`clp_line.shipment_cargo_line_id` → the booked cargo line, which itself carries
`shipment_id`. **This is why the CR is right that `clp_line` needs no change:**
allocation and conservation are enforced per cargo line, so a container holding
six bookings is already expressible in the line table as it stands.

## 3. Where `shipment_schedule_leg` is joined

It is not joined anywhere in the CLP module today. The canonical pattern lives
in `shipping-order.route.ts:169`:

```ts
const schedule = await db.shipmentSchedule.findFirst({
  where: { shipmentId, deletedAt: null, status: 'APPROVED' },
  select: { id: true, cutOffDate: true,
    legs: { where: { deletedAt: null }, orderBy: { legNo: 'asc' },
      select: { vesselId: true, voyageNo: true, etd: true, eta: true,
                originPortId: true, destinationPortId: true } } },
});
const first = schedule.legs[0];
const last  = schedule.legs[schedule.legs.length - 1];
```

- `shipment_schedule` is **per shipment**: it carries `shipment_id`,
  `carrier_id`, `cut_off_date`, `version_no` and a status of
  `PROPOSED | APPROVED | REJECTED | SUPERSEDED`.
- `shipment_schedule_leg` carries `schedule_id`, `leg_no`, `vessel_id`,
  `voyage_no`, `flight_no`, `etd`, `eta`, `origin_port_id`,
  `destination_port_id`.

So the sailing identity is **`legs[0].(vessel_id, voyage_no)` on the APPROVED
schedule**, exactly as the instruction requires. `shipment_schedule.id` is
unusable for this and will not be used.

## 4. Current FCL/LCL determination

`shipment.loading_type`, an enum of **`FCL`, `LCL`, `CONSOL_BOX`**.

The CLP module **does not read it at all today** — the booking selector filters
on receipt state and optionally `shipment_type`, never on `loading_type`. FCL
and LCL bookings therefore already appear in one undifferentiated list.

`CONSOL_BOX` is a third value the CR never mentions. Unused in current data
(3 FCL, 4 LCL bookings) but valid in the enum. **See Decision 1.**

## 5. Current destination field / source

There is **no final-destination or place-of-delivery field anywhere**. A
repository-wide column search for `final_dest`, `place_of_deliv`,
`delivery_place`, `destination` returns exactly one column:
`shipment_schedule_leg.destination_port_id`.

So "final destination" is either:
- `shipment.pod_id` — the booked discharge port, always present; or
- `legs[last].destination_port_id` — the end of the routed carriage, which for
  a transhipment differs from the first leg's discharge.

**See Decision 2.**

## 6. Current CBM / weight source

| Stage | Column | How |
|---|---|---|
| Booked | `shipment_cargo_line.volume_cbm` | **GENERATED** — booked carton L×W×H × booked ctn |
| Received / actual | `cargo_receipt_line.received_volume_cbm` | **GENERATED** — *receipt's own* carton L×W×H × received ctn |
| Allocated | `clp_line.volume_cbm` | written by `recomputeCargoLine` |

**§7's "booked vs actual" already exists and is already separate.** The receipt
carries its own carton dimensions, so re-measuring at CFS is done by recording
the measured carton, and `received_volume_cbm` recomputes itself. Adding
`remeasured_cbm` would duplicate a generated column.

Weight is the weak half: `received_gross_weight_kg` is **hand-entered**, not
generated, and the audit I ran yesterday found it copied from the booked total
on a short delivery. There is no `remeasured_*` column of any kind.

**Billing CBM is calculated nowhere. See Decision 4.**

## 7. Current container capacity implementation

Single source of truth, already correct and matching the instruction's figures:

```
container_size.max_volume_cbm / max_weight_kg
  20STD  28.00 / 26,000      40STD  65.00 / 26,000
  40HC   72.00 / 26,000      45FT   80.00 / 30,000
```

Enforced in exactly one place — `assertWithinCapacity()` in
`clp-allocate.ts`, called inside the allocation transaction after the write, so
a refusal unwinds. Weight is never overridable; volume is overridable by a
holder of `OVERRIDE_CAPACITY` with a written reason recorded on the CLP and in
`audit_log`. The consolidation engine will call this, not reimplement it.

## 8. Current cost / rate / accounting relationships

**There is no accounting module.** Tables matching invoice/cost/ledger/payable/
receivable/account/charge: only `cost_head`, `cost_unit` (master data) and
`rate_local_charge`. No invoice table, no ledger, no cost table.

What does exist:

- `freight_rate_line.buy_price` — what we pay, per container size (Purchase)
- `freight_rate_line.profit_type` / `profit_value`
- `quotation_line.selling_price`, `total_amount`, `currency_id`,
  `container_size_id`, and `price_source_rate_line_id` tracing back to the rate

So a container's **cost** has no home today. §9's worked example ("Container
total cost = $2,000") has no field it could be read from. **See Decision 3.**

## 9. Current CLP finalisation / signature flow

`DRAFT → FINAL` requires container_no (ISO 6346 validated), seal_no,
load_datetime and ≥1 line — enforced by `clp_final_ck` in the database *and*
by `clpFinaliseSchema` at the boundary, so the refusal names the missing field.
`finalised_at` / `finalised_by` are stamped. FINAL has no edit path: the
details endpoint refuses, and re-finalising refuses.

Signature is **wet, not digital** — `clp-print.ts` draws three signature blocks
(Supervisor / Tally Man / Carrier representative) for signing on the floor. A
DRAFT print carries a diagonal DRAFT watermark; a cancelled one carries
CANCELLED. There is no stored signed artefact, so "signed documents" means
paper printed from a FINAL row. **Preserving finalised rows preserves the
documents.**

Non-Latin text: `clp-print.ts` uses pdfkit's built-in Helvetica (WinAnsi). A
`winAnsi()` guard turns unrenderable characters into a visible `?`. Bengali does
not render — a known, separately-tracked limitation affecting every PDF in the
product, not something this work introduces or fixes.

## 10. Proposed migration

Minimal, additive, and reversible in one direction only where it must be.

```sql
-- 1. the participation table
CREATE TABLE clp_booking (
  tenant_id BIGINT NOT NULL, id BIGSERIAL PRIMARY KEY,
  clp_id BIGINT NOT NULL, shipment_id BIGINT NOT NULL,
  shipping_order_id BIGINT NULL,
  ... audit columns, RLS, tenant-composite FKs, audit trigger ...
  UNIQUE (tenant_id, clp_id, shipment_id)
);

-- 2. backfill EVERY existing clp, in the same migration
INSERT INTO clp_booking (tenant_id, clp_id, shipment_id, shipping_order_id, ...)
SELECT tenant_id, id, shipment_id, shipping_order_id, ... FROM clp
ON CONFLICT (tenant_id, clp_id, shipment_id) DO NOTHING;   -- idempotent

-- 3. consolidation columns, defaulted so existing rows are untouched
ALTER TABLE clp
  ADD COLUMN consolidation_type clp_consolidation NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN quotation_id BIGINT NULL,
  ADD COLUMN final_cfs_location TEXT NULL;

-- 4. clp.shipment_id is KEPT for now — see below
```

**`clp.shipment_id` is deliberately not dropped in this migration.** The CR says
remove it; the safer path on a live table is to stop *writing* it, derive
everything from `clp_booking`, and drop the column in a later release once the
new path has run in production. That keeps every finalised row readable by the
old code if a rollback is needed, and satisfies "preserve signed-document
references".

`clp_seq` is likewise kept and left unique per `(tenant_id, shipment_id,
clp_seq)` for existing single-booking rows; consolidated CLPs will carry
`clp_seq = NULL` and be identified by `code` alone, with per-booking position
computed on read. That requires making `clp_seq` nullable and the unique index
partial — a change the existing partial-index migration already sets a
precedent for.

Not added: `pol_id`, `pod_id`, `schedule_id`, `cfs_location` as the CR
describes them. `pol`/`pod`/sailing are derivable from the participating
bookings and would be denormalised copies that can drift; `schedule_id` is the
corrected rule and must not exist; `cfs_location` is replaced by
`final_cfs_location` as an **explicit operator choice**, per instruction §8,
rather than something derived from one receipt.

## 11. Files that will change

**Schema / migration** — one new migration directory, plus `schema.prisma`.

**Backend**
- `apps/api/src/lib/clp-consolidation.ts` *(new)* — eligibility and
  compatibility rules, the single server-side gate
- `apps/api/src/lib/clp-allocate.ts` — unchanged logic; reads bookings through
  `clp_booking`
- `apps/api/src/routes/clp.route.ts` — selector grouping, create-from-many,
  reconciliation across bookings
- `apps/api/src/lib/clp-print.ts` — booking column / per-booking blocks

**Shared** — `packages/shared/src/clp.ts` (DTOs, schemas, permission keys)

**Web**
- `operation/container-load-plan/page.tsx` — FCL/LCL split, grouped selector
- `operation/container-load-plan/[id]/page.tsx` — booking column, cancel dialog
  naming every affected booking
- `components/ops/virtual-container.tsx` — bands by booking when consolidated
- Cargo Receipt tab — `Make CLP` shortcut

**Tests** — 8 existing CLP test files updated for the new shape; new files for
consolidation eligibility, sailing identity, destination, CFS and cost
allocation.

---

## DECISIONS REQUIRED — these cannot be read from the code

Per §21: *"If an important business rule cannot be determined from the existing
code, stop at that point and clearly identify the decision."*

### Decision 1 — `CONSOL_BOX` (blocks the engine)
`loading_type` has three values, not two. The instruction covers FCL+FCL and
LCL+LCL and forbids FCL+LCL, but says nothing about `CONSOL_BOX`. Is it
LCL-like (consolidatable across customers), FCL-like, or its own workflow that
the CLP selector should exclude for now? Unused in current data, but the rule
must be explicit or the engine will have an undefined branch.

### Decision 2 — what "final destination" means (blocks the engine)
No such field exists. Compare `shipment.pod_id`, or
`legs[last].destination_port_id` on the approved schedule? They differ whenever
a routing tranships. My recommendation: compare **`pod_id`**, because it is
always present and is what the booking, the quotation and the shipping order
all already agree on — and report the leg-derived value in the UI where it
differs. Confirm, or tell me a real place-of-delivery field is needed.

### Decision 3 — where a container's cost comes from (blocks cost allocation)
There is no cost field on a CLP and no accounting module. The candidates are
`freight_rate_line.buy_price` (what the carrier charges us for the box),
the sum of the participating `quotation_line.selling_price`, or a figure an
operator types per CLP. These are different numbers and only one of them is
"container total cost".

### Decision 4 — allocation basis, and Billing CBM (blocks cost allocation)
§9 allows CBM, weight, or another approved basis. §7 asks where Billing CBM is
calculated: **nowhere** — Accounts has no tables. I will store the basis
explicitly as an enum so the choice is recorded per CLP rather than assumed,
but the default basis and the billing rule are business decisions.

### What is NOT blocked
Steps 3–6 and 8–11 can proceed on Decisions 1 and 2 alone. Step 7 (cost
allocation) needs 3 and 4. The `Make CLP` shortcut (§12) and the FCL/LCL view
split (§13) need none of them.
