# CHANGE REQUEST — Carrier Service Port (revised) + Carrier Port Pair (new)

> CR-001. A change request against the already-built Settings module.
> CLAUDE.md still governs stack, tenancy, RBAC, screen patterns and design tokens.

---

## 1. WHAT CHANGED AND WHY IT MATTERS

The client moved carrier ranking **from the port to the lane**.

**Before:** a carrier served a port, and that port carried a `Low pricewise position` and a
`Servicewise Position`. That says "Maersk is rank 1 at Chittagong" — which is meaningless on its
own, because a carrier that is cheapest out of Chittagong to Singapore may be fourth-cheapest to
Hamburg.

**Now:** ranking lives on the POL → POD pair. "Maersk is rank 1 on Chittagong → London" is a fact
sales can actually use. The Service Port screen shrinks to a plain list of ports the carrier serves.

Two screens now hang off the Carrier row, and the Carrier list gains a third action button:

```
Carrier row actions:   Edit | Inactive | ADD PIC | Service Port | Port Pair
                                                        ↑            ↑
                                              which ports      which lanes,
                                              they serve       and their rank
```

**Downstream impact — flag this to the pricing team.** Once lane rankings exist, the Price List
(SF FCL List, SF LCL List, AF Price List) can sort carriers by cheapest-first or best-service-first
on the searched lane. Build the tables now; the sort comes when the Purchase module lands.

---

## 2. STEP 1 — MIGRATE `carrier_service_port`

Drop two columns:

```
carrier_service_port
  REMOVE  low_price_position
  REMOVE  service_position
  KEEP    id, tenant_id, carrier_id, port_id, country, is_active, audit columns
```

Before dropping, **check for existing data**. If any rows hold non-null positions, the values
cannot be migrated automatically — a port rank has no POD to attach to, so there is nothing to
derive the pair from. In that case: dump the affected rows to a CSV in `/docs/migration-backups/`,
report the count to me, and let the client re-enter them as pairs. **Do not guess a POD.**

The `country` column stays, but it should be **derived from the selected port, not typed**. If it is
currently a free-text input, change it to a read-only field that fills from `port.country`.

---

## 3. STEP 2 — NEW TABLE `carrier_port_pair`

Client's name: `Table_Carrier_Service_Port_pairing`. Inherits all CLAUDE.md §4 conventions —
`tenant_id` first, `code`, `is_active`, audit columns, soft delete, tenant-safe composite FKs.

```
carrier_port_pair
  id                    BIGSERIAL PK
  tenant_id             FK tenant
  code                  CPP-000001
  carrier_id            FK carrier            -- client: Carrier_ID_no
  pol_id                FK port               -- client: Carrier_Service_port_POL
  pod_id                FK port               -- client: Carrier_Service_port_POD
  low_price_position    NUMERIC(5,2) NULL     -- client: Low pricewise position
  service_position      NUMERIC(5,2) NULL     -- client: Servicewise Position
  remarks               TEXT NULL
  is_active             BOOLEAN DEFAULT true
  + created_at, updated_at, created_by, updated_by, deleted_at

  CHECK  (pol_id <> pod_id)
  UNIQUE (tenant_id, carrier_id, pol_id, pod_id) WHERE deleted_at IS NULL
  INDEX  (tenant_id, pol_id, pod_id)            -- the lane lookup the Price List will use
  INDEX  (tenant_id, carrier_id)
```

**Why `NUMERIC(5,2)` and not `INT`:** the client's sample row shows `1.0`, and rankings get
re-shuffled constantly. Decimals let the pricing team slot a carrier at 1.5 between existing ranks 1
and 2 without renumbering the whole lane. Both position fields are nullable — a pair can be recorded
before anyone has ranked it.

---

## 4. STEP 3 — VALIDATION RULES

1. **POL and POD must both come from that carrier's own Service Port list.** This is the relation
   that makes the Service Port screen meaningful: you record which ports a carrier serves, then pair
   them. Enforce server-side; the dropdowns query `carrier_service_port` for that `carrier_id`, and
   the API rejects anything outside it with: *"Add London to this carrier's service ports before
   pairing it."* If the client wants free choice of any port instead, see §8 Q1.
2. **POL ≠ POD**, enforced by the CHECK constraint and validated client-side too.
3. **One active pair per carrier + lane.** On duplicate, don't create a second row — open the
   existing one for edit and tell the user: *"This carrier already has a Chittagong → London pair.
   Editing it instead."*
4. **Duplicate ranks warn, they do not block.** If another carrier already holds
   `low_price_position = 1` on the same lane, show a non-blocking notice naming that carrier.
   Hard-blocking makes re-ranking impossible — you'd have to vacate a rank before assigning it, and
   the team ranks in bulk. See §8 Q2 if the client wants strict uniqueness.
5. **Deactivating a service port that is used in an active pair:** warn and list the affected pairs,
   then let the user proceed. **Never cascade-delete the pairs.**
6. **Ports are filtered by carrier type** — SEAPORT for MLO/NVOCC/SOC, AIRPORT for Airline.
   Server-side, not just in the dropdown.

---

## 5. STEP 4 — SCREEN: Carrier → Port Pair

Child screen of Carrier, same pattern as Service Port and Carrier PIC (CLAUDE.md §8), route
`/settings/carrier/[id]/port-pair`. Header shows the carrier name and type. **Back to list** link
required.

**Add row across the top** (matching the wireframe order exactly):
POL · POD · Low pricewise position · Servicewise Position · Remark · `[ ADD ]`

- POL and POD are searchable selects, scoped per rule 1, showing `port_code — Port Name, Country`.
- The two position fields are numeric, right-aligned, IBM Plex Mono with tabular figures
  (CLAUDE.md §12).
- Remark is a single-line text input; it wraps in the table below.

**List below:** `SL NO` · `POL` · `POD` · `Low pricewise position` · `Servicewise Position` ·
`Remarks` · `Action` with `Edit | Inactive` per row, following the standard list pattern.

- Default sort: `low_price_position` ascending, nulls last. Sortable by either position column.
- Rows with no rank yet show `—` in `--steel`, not `0`. A blank rank and a rank of zero are
  different things.
- Empty state: *"No lanes paired yet. Add a POL and POD pair to rank this carrier by price or
  service."*

Also update the **Carrier list screen**: add the `Port Pair` action button after `Service Port`.

---

## 6. STEP 5 — PERMISSIONS

Register in the permission constant so the superadmin matrix picks them up automatically:

```
SETTING.CARRIER_PORT_PAIR    VIEW  CREATE  EDIT  TOGGLE_STATUS
```

Grant to whichever roles already hold `SETTING.CARRIER_SERVICE_PORT` — the same people maintain
both. Update the seed script so a fresh tenant gets this on the Pricing Team template.

---

## 7. BUILD ORDER

| Step | What | Done when |
|---|---|---|
| 1 | Check for existing position data, back it up, drop the two columns from `carrier_service_port`, make `country` derived | Migration applied, backup reported |
| 2 | `carrier_port_pair` model + migration — show me the schema before applying | Constraints reviewed |
| 3 | API: CRUD + the §4 validation, scoped by tenant and permission | Isolation + permission tests pass |
| 4 | Port Pair screen + Port Pair button on the Carrier list | Matches §5 |
| 5 | Update the Service Port screen to the two-column version | Positions gone from the UI |
| 6 | Seed + permission registration | Fresh tenant works end to end |

**Reuse the existing Carrier PIC / Service Port components** — this is the same child-of-carrier
pattern with different columns. If you find yourself writing a new table component, stop; the shared
`DataTable` should already cover it.

---

## 8. QUESTIONS FOR THE CLIENT

1. **Must POL/POD come from the carrier's Service Port list, or can any port be paired?** §4 rule 1
   assumes the former, since that is what makes the Service Port screen useful. If it's the latter,
   the Service Port screen becomes redundant and should probably be merged into this one.
2. **Are the ranks unique per lane?** Can two carriers both be `low_price_position = 1` on
   Chittagong → London? §4 rule 4 warns but allows. If they must be unique, the system needs a
   re-rank flow, not just a validation error.
3. **What is being ranked — the carrier, or the lane?** Two readings of the sample data:
   (a) "on Chittagong → London, Maersk is the 1st cheapest carrier" (rank compares carriers on one
   lane), or (b) "of the lanes Maersk serves, Chittagong → London is their 1st cheapest" (rank
   compares lanes within one carrier). The schema supports both, but the Price List sort and the
   duplicate-warning logic differ completely. **This one genuinely blocks step 3 — please confirm
   before the API is written.**
4. **Should ranks be maintained by hand forever, or eventually calculated from actual purchase rates
   once the Purchase module is live?** If calculated later, add a `rank_source` column
   (`MANUAL` / `CALCULATED`) now — it is one column today and a migration plus a data reconciliation
   later.
5. **Is the pair direction-specific?** Chittagong → London and London → Chittagong are separate rows
   as specced. Confirm the client doesn't expect one row to cover both directions.
