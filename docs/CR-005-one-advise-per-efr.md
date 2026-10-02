# CR-005 — One Shipment Advise and one BL per EFR

> **Status, 2026-10-02: built — phases A–D done.** The schema and migration are applied, the
> API groups bookings by EFR as §2 says (`lib/advise-group.ts`), and the screens show it (§8).
> Advise, BL draft, BL Print, the worklists and the customer portal all go through
> `shipment_advise_booking`. `routes/advise-group.route.test.ts` covers it end to end, and the
> screens were checked in a browser against the demo workspace (§12). The client questions in
> §10 are still open; the working defaults are what is built.

---

## 1. The request

The client, 2026-10-02:

> On the cargo receipt we added EFR. When the **same EFR number** is found on **multiple bookings
> (in a single quotation)**, then for the same EFR there will be a **single shipment advice and a
> single BL**.

Today it is strictly one advise and one House BL **per booking** — `MODULE_DOCUMENTATION.md` §3.1,
built on CR-002 Addendum H's "1 HBL" per booking. The database enforces it: one live advise per
booking, one live BL draft per booking, and both documents point at exactly one booking. This CR
reverses §3.1 for bookings that share an EFR.

Example — quotation Q-001, three bookings:

| Booking | EFR on its cargo receipts | Gets |
|---|---|---|
| BKG-1 | EFR-001 | **one** advise, **one** HBL, **one** BL draft, covering BKG-1 and BKG-2 |
| BKG-2 | EFR-001 | (the same advise, HBL and BL) |
| BKG-3 | EFR-002 | its own advise, HBL and BL, as today |

## 2. Rules

Recommended on 2026-10-02 and accepted with "yes go ahead". Rules 5 and 6 were not part of
that recommendation. They are working defaults, repeated in §10.

1. **A group is the bookings of one quotation whose cargo arrived under the same EFR.** A
   booking's EFRs are read from its confirmed cargo receipts, exactly as `lib/clp-efr.ts` does
   for the CLP: ACCEPTED lines on CONFIRMED, undeleted receipts.
2. **EFRs are compared ignoring case and spaces.** `EFR-001`, `efr-001` and `EFR - 001` are the
   same EFR. What prints is what was typed on the receipt.
3. **Grouped automatically only when everything a BL prints once also matches:**
   - **the sailing:** first-leg vessel and voyage (air: flight), POL and POD of the approved
     schedule. **Refinement:** a mismatch here is a refusal, not a warning. One bill of lading
     cannot cover two sailings, so those bookings keep separate advises, and the screen says why;
   - **the shipper and the consignee:** the booking's exporter and importer, name and address,
     compared ignoring case and spaces. A mismatch is a **warning, and the user decides**. They
     are often the same company typed twice. The BL's party blocks are typed on the draft anyway
     (§3.4), so the user fixes what prints there.
4. **Never merged silently.** `Make Shipment Advise` lists the bookings it found. Full matches are
   in the group and cannot be taken out, because the client's rule is one advise per EFR.
   Warned bookings are shown unticked, with the reason, for the user to tick in.
5. **A booking with more than one EFR is not grouped** (the Consol box case in CR-002 has
   EFR-001 and EFR-002 on one booking). It gets its own advise, as today, and the screen lists
   its EFRs. *Working default — §10 Q1.*
6. **Sea and air both.** The advise numbers the house bill on both, HBL on sea and HAWB on air.
   The BL draft follows on sea, where it exists (§12 Q8 of the module spec). *Working default —
   §10 Q2.*
7. **Sending closes the group.** A booking that reaches the EFR after its group's advise was sent
   cannot be added. The advise is cancelled and reissued, which **allocates a new House BL
   number**, because a cancelled advise keeps its number forever (module spec §5). `Save & Send`
   therefore warns when a booking of the same quotation and EFR is not ready yet: "BKG-2 is also
   EFR-001 and has no finalised CLP. Send now, and adding it later means a new House BL number."
8. **While the advise is a draft, the group can grow.** A booking that becomes ready afterwards
   is added from its own `Make Shipment Advise` action ("Add to SA-…"), or by `Build`, which
   re-pulls the PO grid of every booking in the group.

## 3. Lifecycle — what changes

The document states do not change. **Every move a booking made because of its advise or BL is
now made by every booking in the group**, in one transaction, through `transitionShipment`:

| Event | Bookings in the group |
|---|---|
| Advise sent | → `ADVISED` |
| Advise cancelled after send | → `CARGO_RECEIVED` |
| BL draft approved | → `BL_DRAFTED` |
| BL issued | → `BL_ISSUED` |
| Approved or issued BL cancelled | → `ADVISED` |

If any booking in the group cannot make the move, none of them does, and the error names that
booking.

## 4. Schema

```
shipment_advise_booking                 NEW — the bookings an advise covers
  tenant_id, id, advise_id → shipment_advise, shipment_id → shipment,
  released_at   set when the advise is cancelled or deleted (by trigger)
  + §4 standard columns (is_active, created/updated at/by, deleted_at)
  UNIQUE (tenant_id, advise_id, shipment_id)
  UNIQUE (tenant_id, shipment_id) WHERE released_at IS NULL AND deleted_at IS NULL   -- one live advise per booking

shipment_advise
  shipment_id   unchanged in meaning: the booking the advise was made from (the "lead").
                It always has a shipment_advise_booking row too.
  + UNIQUE (tenant_id, id, shipment_id)                       -- target for bl_draft

shipment_advise_line
  + shipment_id NOT NULL                                      -- which booking this PO line is
  FK (tenant_id, advise_id, shipment_id)        → shipment_advise_booking   -- one of the advise's bookings
  FK (tenant_id, shipment_po_id, shipment_id)   → shipment_po                -- replaces the 2-column FK
  FK (tenant_id, shipment_cargo_line_id, shipment_id) → shipment_cargo_line  -- replaces the 2-column FK

bl_draft
  FK (tenant_id, advise_id, shipment_id) → shipment_advise    -- replaces (tenant_id, advise_id)
  shipment_id is therefore always the advise's lead booking; with the existing live index
  bl_draft_tenant_id_shipment_id_live_key that is one live BL draft per advise.

shipment_po, shipment_cargo_line
  + UNIQUE (tenant_id, id, shipment_id)                       -- targets for the line's FKs
```

**Guards in the database**, because these are the rules that leak or corrupt if a code path
forgets them:

- `shipment_advise_booking_group_guard` (BEFORE INSERT/UPDATE): a booking may join an advise
  only if it is on **the same quotation** and **the same customer** as the advise's lead booking,
  and only while the advise is a **DRAFT**. The customer check matters most: the customer
  portal shows an advise to the lead booking's customer, so an advise holding another customer's
  booking would show their POs to the wrong company.
- `shipment_advise_release_bookings` (AFTER UPDATE of status/deleted_at): cancelling or deleting
  an advise releases every booking it covered, so they can be advised again.
- RLS: staff `tenant_isolation` in the single-comparison form, and a `customer_read` policy keyed
  on the booking, the same shape as `customer_read` on `shipment_advise`. Grants
  `SELECT, INSERT, UPDATE` (no `DELETE`, like every table here), and the audit trigger.

**Why EFR is not checked in the database:** it lives on the cargo receipts and can be corrected
after the advise is made. The API checks it when the group is formed or grows (§7).

**Not in the database:** that the lead booking always has a membership row. It would need a
circular, deferred foreign key, which Prisma cannot model. The create route writes both rows in
one transaction, and a test pins it (§9).

## 5. Tables affected

| Table | Change |
|---|---|
| `shipment_advise_booking` | **new** |
| `shipment_advise_line` | + `shipment_id` (backfilled from its PO); two FKs widened to include it; one new FK |
| `bl_draft` | the advise FK widened to include `shipment_id` |
| `shipment_advise` | + one unique index |
| `shipment_po` | + one unique index |
| `shipment_cargo_line` | + one unique index |

Nothing is renamed, no column is dropped, no data is deleted. Three foreign keys are dropped,
each replaced in the same file by a stricter one over the same columns plus `shipment_id`.

## 6. The migration — `20261002170000_one_advise_per_efr_group`

In order:

1. **Preconditions**, before anything changes: every existing advise line is its advise's own
   booking's cargo, and every BL draft sits on its advise's booking. If not, it stops with the
   count and changes nothing.
2. Drops the three foreign keys being replaced.
3. Creates `shipment_advise_booking` and **backfills one row per existing advise**, covering its
   own booking, which is all an advise has ever covered. A cancelled or deleted advise's row is
   released.
4. Adds `shipment_advise_line.shipment_id` as nullable, fills it from the line's PO, then sets
   it NOT NULL.
5. Indexes, the partial live index, the foreign keys, both guard triggers, RLS, grants, audit
   trigger. The audit trigger comes after the backfill, so the migration's own rows are not
   logged as if somebody typed them.

**Verified on a copy of the local database (with the demo data), 2026-10-02:**

- The migration applies cleanly. A draft advise kept its booking, and a cancelled advise's
  booking came back released. Every existing line got its `shipment_id`.
- `prisma migrate diff` from the migrated database to `schema.prisma`: **empty**. No drift.
- 14 checks against the constraints and triggers, all as intended. **Allowed:** two more
  bookings of the quotation join a draft advise, one of them freed by its earlier cancelled
  advise; a PO line for a booking on the advise; advising a booking again once its group's advise
  was cancelled. **Refused:** another quotation's booking; another customer's booking; the same
  booking twice on one advise; a booking already live in another advise; a line for a booking
  not on the advise; a line whose PO is another booking's; a BL draft on a booking other than
  the lead; adding to a sent advise. Cancelling released all three bookings.

## 7. API — phase C

| Route | Change |
|---|---|
| `GET /bookings/:id/advise/prefill` | + `group`: the bookings found for the EFR, each with `match: FULL \| WARN \| REFUSED`, the reason, and whether it is ready. The PO grid covers the group. |
| `POST /bookings/:id/advise` | + `shipmentIds` (the warned bookings the user ticked). Re-checks every rule server-side and writes the lead's membership row in the same transaction. |
| `GET /bookings/:id/advise` | Finds the live advise through membership, so it answers for any booking in the group. |
| `POST /shipment-advise/:id/build` | Re-pulls every member's lines, and adds bookings that have become ready full matches. |
| `POST /shipment-advise/:id/bookings` | **new**: add a booking to a draft (`Add to SA-…`). `BUILD` permission. No new permission keys. |
| `POST /shipment-advise/:id/send` · `/cancel` | Move every member's status (§3). Send warns per rule 7. |
| `POST /shipments/:id/bl-draft` | For any member, opens the group's BL. The draft hangs off the lead. |
| BL approve / issue / cancel, `bl-print` | Status moves for every member. |
| Shipment worklist | A member already in a draft or sent advise shows "In SA-…" instead of `Make Shipment Advise`. |
| Customer portal | `/customer/shipments/:id/bl-draft` resolves the group's BL for any member. |
| Advise PDF and e-mail | Booking No lists every booking. The subject becomes *"Shipment Advise of Booking no : BKG-1, BKG-2"*. The PO grid gets a Booking column when there is more than one booking. |

## 8. Screens — phase D

- **Make Shipment Advise** gets a "Bookings on this advise" panel above the PO grid. Full matches
  are ticked and locked, warned bookings are unticked with their reason, refused bookings are
  listed with why, and bookings not ready yet are shown with what they are waiting for.
  Ticking a warned booking re-pulls the preview, so the grid shows what will be saved.
  (`components/doc/advise-group-panel.tsx`)
- **A booking whose EFR is already on a draft** opens to "Shares an advise with SA-…" and an
  `Add <booking> to SA-…` button. If the advise has been sent, it says to cancel and reissue
  instead.
- **On a saved draft**, the panel offers `Add to this advise` for bookings that have become
  ready. `Save & Send` warns when a booking of the EFR is still missing, because adding it after
  the send means a new House BL number.
- The BL tab, BL Print's issue dialog and the customer's BL screen name every booking the bill
  covers.
- **Advise, BL Draft and BL Print lists** keep one row per booking (they are booking worklists),
  and the row shows the shared document number. Opening any of them opens the one document.
- **BL Draft**: gross weight, measurement and the container block total the whole group.

## 9. Tests — before it ships

1. **Isolation**: `shipment_advise_booking` added to `tenancy.ts` (the registry count becomes 101)
   in the same commit that applies the migration. Two-tenant and customer isolation suites cover
   it.
2. **Phase seams**, from genuinely finalised CLPs and confirmed receipts with typed EFRs: a group of
   two bookings on one quotation, one advise and one HBL. A third booking with another EFR stays
   apart. A booking with two EFRs stays apart. A sailing mismatch is refused. A shipper mismatch
   warns.
3. **Status**: sending, cancelling, approving and issuing move every member. One member in the
   wrong state blocks all of them, and the error names it.
4. **The lead always has a membership row.** **A sent advise refuses new members.**
5. **Customer portal**: the customer opens the group's BL from any of their bookings.

## 10. Open questions for the client

| # | Question | Working default |
|---|---|---|
| 1 | A booking received on two receipts with **two EFRs** (CR-002's Consol box): which advise is it on? | Not grouped; its own advise, its EFRs listed |
| 2 | Does the rule apply to **air** (one HAWB for bookings sharing an EFR)? | Yes, the same rule |
| 3 | A booking reaches a **sent** group's EFR late. Cancel and reissue means a **new House BL number**. Acceptable, or should a sent advise take a late booking until its BL is approved? | Cancel and reissue, warned at send |
| 4 | **Freight invoices**: one per booking, as today, or one per BL? | One per booking, unchanged |
| 5 | Should the EFR No have a **format** or be unique per quotation? It is free text today. | Free text, compared ignoring case and spaces |

## 11. Phases

| Phase | Work | Done when |
|---|---|---|
| A | This document, `schema.prisma`, the migration. Verified on a copy. | **Done** — approved 2026-10-02 |
| B | Apply the migration, `tenancy.ts`, and the existing write paths set `shipment_id` on lines. Nothing groups yet. | **Done** — full suite green, behaviour unchanged |
| C | The API of §7 | **Done** — phase-seam tests green |
| D | The screens of §8, the PDF and the e-mail | **Done** — browser check of §12 passes |

## 12. Trying it, and how it was checked

**To see it: `pnpm db:demo:efr`.** It loads three small examples for customer Rahman Garments Ltd
(also part of `pnpm db:demo`). Booking codes read as example and booking: DEMO-EFR-1A is
example 1, booking A. Run it again to start over; `pnpm db:demo:efr:clear` removes it. Every
booking is received, with an approved schedule, an issued S/O and a finalised load plan, unless
the table says otherwise.

| Example | Bookings | What to do | What you see |
|---|---|---|---|
| 1 — the rule | DEMO-EFR-1A, -1B (EFR-501) | Shipment Advise - Sea → search `DEMO-EFR-1` → Open 1A → Save | One advise and one House BL covering both. Both list rows show it |
| 2 — the BL | DEMO-EFR-2A, -2B (EFR-601), advise already sent | BL Draft → search `DEMO-EFR-2` → Open 2A → Draft | One BL draft for both |
| 2 — extra | DEMO-EFR-2C (EFR-601) | Open it on Shipment Advise - Sea | Arrived after the send: cancel and reissue the advise to include it |
| 3 — special cases | DEMO-EFR-3A to -3G (EFR-701) | Open 3A on Shipment Advise - Sea | 3B *Same EFR* (typed ` efr-701 `) · 3C *Same EFR — check* (other exporter) · 3D *Kept apart* (later voyage) · 3E *Waiting* (no load plan) · 3F *Kept apart* (two EFRs) · 3G not listed (EFR-703) |

The Shipment Advise - Sea list says which bookings share an EFR before anything is opened:
*"Shares EFR-501 with DEMO-EFR-1B — one advise for all."*

A picture-by-picture version of this walkthrough was published as a separate guide page,
*Same EFR, One Advise*.

`pnpm db:demo`, `pnpm db:demo:sheet` and `pnpm db:demo:efr` clear advises and BLs made on demo
bookings. They stop, naming the advise, if it also covers a booking that is not demo data.

**Checked in a browser, 2026-10-02.** Headless Chrome against the running dev servers, with the
scenario above, plus DEMO-SHEET-BKG-5 given BKG-3's parties so it fully matches:

- the panel offers BKG-4, unticked, as *Same EFR — check*;
- ticking it adds the Booking column, with "Covers BKG-3, BKG-4";
- saving makes one advise covering both, and BKG-4 opens it;
- the send dialog's subject lists both bookings;
- the worklist rows say "…, with DEMO-SHEET-BKG-4" and "…, with DEMO-SHEET-BKG-3";
- BKG-5, once received under EFR-003, offers "Add DEMO-SHEET-BKG-5 to SA-…", and joins;
- no console errors.

The demo data was put back afterwards.
