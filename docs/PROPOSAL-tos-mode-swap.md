# PROPOSAL — making `tos` the canonical home of the 11 Incoterms

> **Status: approved and applied**, 2026-08-24, as
> `prisma/migrations/20260825090000_tos_mode_swap`. The migration file is
> generated from the SQL block below, so the two cannot disagree. Two corrections
> were made during implementation and are marked in place: the view definition in
> §4 (it had been copied from the Phase 3 migration, which still exposed
> `remarks`) and the sort-order claim in §3.

---

## 1. What is actually there today

Both tables exist, both are seeded, and **the contents are the wrong way round**
relative to the module spec.

| table | rows | shared? | used by |
|---|---|---|---|
| `tos` | 7 — `CY/CY`, `CY/CFS`, `CFS/CY`, `CFS/CFS`, `CY/DOOR`, `DOOR/CY`, `DOOR/DOOR` | all `tenant_id NULL`, all active | **3 inquiries** |
| `mode` | 11 — `EXW FCA FAS FOB CFR CIF CPT CIP DPU DAP DDP` | all `tenant_id NULL`, all active | **0 inquiries** |

Two facts do most of the work in this proposal:

1. **`mode_id` has never been used.** Seven inquiries exist; none sets it. The
   New Inquiry form has no Mode field at all — only TOS.
2. **Only two foreign keys point at either table**, both from `inquiry`.
   Nothing in Purchase, Quotation, Rates or CRM touches them.

The schema already knows the mismatch. `inquiry.mode_id` carries this comment:

```prisma
/// The client's "Mode" — an Incoterm. See the Mode model.
modeId BigInt? @map("mode_id")
```

And the two settings screens say so out loud:

- `/setting/tos` — **"TOS"** · *"Terms of shipment — where the carrier takes the cargo and where it hands it back."*
- `/setting/mode` — **"Modes"** · *"Incoterms — which party carries cost and risk over each leg of the journey."*

So the earlier spec put the Incoterms under Mode. The new spec (§3) puts them
under TOS. The data is right; the labels are wrong.

---

## 2. Three readings, and why only one survives

**(a) Reseed `tos` with Incoterms and leave `mode` alone** — the literal reading of
§3. Result: the same 11 Incoterms exist in two tables at once, and the 3 inquiries
holding `CFS/CY` now display a non-Incoterm inside a field defined to contain an
Incoterm. Rejected.

**(b) Drop Mode; `tos` becomes the only term list.** Contradicts the new spec
itself: §4.4 gives `quotation` both `tos_id` **and** `mode`, and §6.5 lists TOS
and Mode as separate header fields. It also throws away the CY/CY family with
nowhere to put it. Rejected.

**(c) Swap what the two tables are called.** The Incoterms become `tos`; the
CY/CY family becomes `mode`. **Recommended** — and the reason is that it moves no
data whatsoever. See below.

---

## 3. Why the swap is a rename and not a migration of data

The 3 inquiries that carry a TOS value carry `CFS/CY`, `CFS/CFS` and `CY/CFS`.
Under the new definitions those are Mode values, not TOS values. So:

```
BEFORE                                    AFTER (names only)
table "tos"  → CY/CY family               table "mode" → CY/CY family
table "mode" → 11 Incoterms               table "tos"  → 11 Incoterms

inquiry.tos_id  → CFS/CY  (3 rows)        inquiry.mode_id → CFS/CY  (3 rows)
inquiry.mode_id → null    (7 rows)        inquiry.tos_id  → null    (7 rows)
```

Every row keeps its primary key. Every foreign key keeps pointing at the same
physical row — Postgres resolves foreign keys by object identity, not by name, so
renaming a table does not disturb them. **No `UPDATE` runs against any business
table.** The three inquiries end up saying "Mode: CFS/CY", which is what the
operator actually chose, filed under the name the client now uses for it.

There is a useful accident in the structure, too: `mode` has a `sort_order`
column and `tos` does not, so after the swap the column lands on the Incoterms —
the list that actually needs one, since EXW…DDP is a sequence rather than an
alphabet.

**Corrected after implementation.** This section originally said the Incoterms
"keep their sort order". They never had one: the seed created them through the
shared code-and-name path and left `sort_order` at its default, so all eleven
rows are `0`. The column is now in the right place and the query reads it, but
until the values are set the list still falls back to alphabetical order — which
is exactly how it displayed before the swap, so nothing regressed. Populating
1…11 is an `UPDATE` on eleven shared lookup rows and was deliberately left out
of this migration, which writes no rows at all.

---

## 4. The proposed migration

Suggested name: `prisma/migrations/20260825090000_tos_mode_swap/migration.sql`.

Two things force a temporary name. Index and sequence names are unique per
*schema*, not per table, so `tos_pkey` cannot be created while the other
`tos_pkey` still exists. Constraint names are unique per table, and both
inquiry foreign keys live on `inquiry`. Hence the three-pass shape.

```sql
-- TOS and Mode exchange names.
--
-- The module spec (§3) makes TOS the Incoterms. The database already holds the
-- Incoterms — under `mode` — and holds the CY/CY family under `tos`. The values
-- are right and the labels are wrong, so this migration renames and moves
-- nothing: no UPDATE runs against any business table, every row keeps its id,
-- and every foreign key keeps pointing at the row it already pointed at.
--
-- The three inquiries carrying a TOS value carry CFS/CY, CFS/CFS and CY/CFS.
-- Those are Mode values under the new definitions, and after this they are
-- filed as such — which is what the operator picked, under the name the client
-- now uses for it.

-- ---------------------------------------------------------------------------
-- Pass 1 — park the CY/CY table out of the way
-- ---------------------------------------------------------------------------
ALTER TABLE "tos" RENAME TO "swap_tmp";
ALTER SEQUENCE "tos_id_seq" RENAME TO "swap_tmp_id_seq";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_pkey"            TO "swap_tmp_pkey";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_tenant_id_fkey"  TO "swap_tmp_tenant_id_fkey";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_created_by_fkey" TO "swap_tmp_created_by_fkey";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_updated_by_fkey" TO "swap_tmp_updated_by_fkey";
ALTER INDEX "tos_code_system_key"    RENAME TO "swap_tmp_code_system_key";
ALTER INDEX "tos_tenant_id_code_key" RENAME TO "swap_tmp_tenant_id_code_key";
ALTER INDEX "tos_tenant_id_idx"      RENAME TO "swap_tmp_tenant_id_idx";
-- audit.test.ts asserts a trigger named <table>_audit on every tenant table,
-- so these renames are load-bearing rather than cosmetic.
ALTER TRIGGER "tos_audit" ON "swap_tmp" RENAME TO "swap_tmp_audit";

-- ---------------------------------------------------------------------------
-- Pass 2 — the Incoterms become TOS
-- ---------------------------------------------------------------------------
ALTER TABLE "mode" RENAME TO "tos";
ALTER SEQUENCE "mode_id_seq" RENAME TO "tos_id_seq";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_pkey"            TO "tos_pkey";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_tenant_id_fkey"  TO "tos_tenant_id_fkey";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_created_by_fkey" TO "tos_created_by_fkey";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_updated_by_fkey" TO "tos_updated_by_fkey";
ALTER INDEX "mode_code_system_key"    RENAME TO "tos_code_system_key";
ALTER INDEX "mode_tenant_id_code_key" RENAME TO "tos_tenant_id_code_key";
ALTER INDEX "mode_tenant_id_idx"      RENAME TO "tos_tenant_id_idx";
ALTER TRIGGER "mode_audit" ON "tos" RENAME TO "tos_audit";

-- ---------------------------------------------------------------------------
-- Pass 3 — the CY/CY family becomes Mode
-- ---------------------------------------------------------------------------
ALTER TABLE "swap_tmp" RENAME TO "mode";
ALTER SEQUENCE "swap_tmp_id_seq" RENAME TO "mode_id_seq";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_pkey"            TO "mode_pkey";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_tenant_id_fkey"  TO "mode_tenant_id_fkey";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_created_by_fkey" TO "mode_created_by_fkey";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_updated_by_fkey" TO "mode_updated_by_fkey";
ALTER INDEX "swap_tmp_code_system_key"    RENAME TO "mode_code_system_key";
ALTER INDEX "swap_tmp_tenant_id_code_key" RENAME TO "mode_tenant_id_code_key";
ALTER INDEX "swap_tmp_tenant_id_idx"      RENAME TO "mode_tenant_id_idx";
ALTER TRIGGER "swap_tmp_audit" ON "mode" RENAME TO "mode_audit";

-- ---------------------------------------------------------------------------
-- Pass 4 — the two inquiry columns exchange names with them
-- ---------------------------------------------------------------------------
-- The foreign keys are NOT dropped. Postgres resolves them by object identity,
-- so each one already points at the table it should; only the labels move.
ALTER TABLE "inquiry" RENAME COLUMN "tos_id" TO "swap_tmp_id";
ALTER TABLE "inquiry" RENAME CONSTRAINT "inquiry_tos_id_fkey" TO "inquiry_swap_tmp_id_fkey";

ALTER TABLE "inquiry" RENAME COLUMN "mode_id" TO "tos_id";
ALTER TABLE "inquiry" RENAME CONSTRAINT "inquiry_mode_id_fkey" TO "inquiry_tos_id_fkey";

ALTER TABLE "inquiry" RENAME COLUMN "swap_tmp_id" TO "mode_id";
ALTER TABLE "inquiry" RENAME CONSTRAINT "inquiry_swap_tmp_id_fkey" TO "inquiry_mode_id_fkey";

-- The same-tenant guards are dropped and recreated rather than renamed: their
-- arguments name the parent table and column, and ALTER TRIGGER … RENAME
-- changes the label without touching what the trigger was created with. A
-- renamed guard would assert against the wrong list and fail closed on the
-- first save.
DROP TRIGGER "inquiry_tos_id_tenant_guard" ON "inquiry";
DROP TRIGGER "inquiry_mode_id_tenant_guard" ON "inquiry";
CREATE TRIGGER "inquiry_tos_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('tos', 'tos_id');
CREATE TRIGGER "inquiry_mode_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('mode', 'mode_id');

-- ---------------------------------------------------------------------------
-- Pass 5 — the agent view
-- ---------------------------------------------------------------------------
-- agent_inquiry_v selects both columns. RENAME COLUMN rewrites a dependent
-- view's internal reference but keeps its OUTPUT column name, so the view would
-- go on publishing the old names against the new meanings — silent, and visible
-- only as a wrong label on an agent's screen. This is the third time that trap
-- has been sprung in this schema; see the note in 20260824180000.
--
-- security_invoker stays load-bearing: without it the view runs as its owner,
-- who bypasses RLS, and hands every agent every inquiry in the workspace.
DROP VIEW "agent_inquiry_v";

CREATE VIEW "agent_inquiry_v" WITH (security_invoker = true) AS
  SELECT
    i.id, i.tenant_id, i.code, i.series_year, i.inquiry_date,
    i.shipment_type, i.movement_type, i.loading_type,
    i.pol_id, i.pod_id, i.place_of_receipt,
    i.commodity_item_id, i.hs_code,
    i.tos_id, i.mode_id,
    i.expected_shipment_date, i.valid_to,
    -- remarks is NOT here. 20260823140000 took it out: it is free text the
    -- forwarder's own staff type, and it was the one field through which a
    -- customer's name could still reach an agent. Recreating this view from the
    -- Phase 3 definition would quietly put it back, which is what
    -- agent-rls.test.ts caught.
    i.status, i.created_at
  FROM "inquiry" i
  WHERE i.deleted_at IS NULL
    AND i.tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "inquiry_party" ip
      WHERE ip.inquiry_id = i.id
        AND ip.tenant_id = i.tenant_id
        AND ip.agent_id = app_current_agent()
    );

-- Omitted on purpose, unchanged from before: customer_id, currency_id,
-- salesman_id, source_id, notify_emails, created_by, updated_by.
GRANT SELECT ON "agent_inquiry_v" TO ff_app;
-- ALTER DEFAULT PRIVILEGES covers views, so a freshly created view arrives
-- writable and the read-only REVOKE from 20260823150000 has to be restated.
REVOKE INSERT, UPDATE, DELETE ON "agent_inquiry_v" FROM ff_app;
```

**Nothing else in the database changes.** The row-level security policies on both
tables are named `tenant_isolation` and `agent_read` — identical on each — so they
travel with their tables and need no renaming.

---

## 5. What changes outside the database

| what | change | risk |
|---|---|---|
| `prisma/schema.prisma` | `model Tos` gains `sortOrder`; `model Mode` loses it. The two `@@map`s stay as they are — the models keep their names, the tables beneath them swapped. | none, mechanical |
| `packages/shared/src/inquiry.ts` | `tosId`/`modeId` and `tosName`/`modeName` exchange meaning. Field names unchanged. | none |
| `prisma/seed.ts` | `RATE_LOOKUPS.tos` and `.mode` exchange contents. | none |
| `/setting/tos` screen | keeps its title, now lists Incoterms. Description becomes the Incoterms wording. | none |
| `/setting/mode` screen | keeps its title, now lists CY/CY. Description becomes the terms-of-shipment wording. | none |
| Inquiry form | the existing **TOS** dropdown now offers Incoterms. A **Mode** dropdown is added — §6.5 wants both, and today there is no Mode field at all. | new field, Phase D work |
| Agent inquiry detail | the labels `Terms of service` / `Incoterm` exchange places. | none |
| Permissions | **no change.** `SETTING.TOS.*` still guards the screen called TOS; only the list it edits changes. | none |
| Tests | `inquiry.test.ts` and `rate-lookup.isolation.test.ts` reference both lookups. | mechanical |

The code swap needs the same three-pass discipline as the SQL — a blind
find-and-replace of `tosId`→`modeId` and `modeId`→`tosId` collapses both into one.
Rename through a temporary token, then verify with a full typecheck and the suite.

---

## 6. Backward compatibility

**Existing data.** Untouched. Three inquiries change which *field name* their value
appears under; no value is rewritten, deactivated or deleted. The other four
inquiries had neither field set and still have neither.

**API consumers.** The only consumer is our own web app, shipped from this repo.
There is no external or versioned API to keep compatible, and no mobile client.

**Reversal.** Run the same migration with the names inverted. Because nothing
moves, a wrong decision costs one more migration rather than any data — which is
the strongest argument for doing it this way rather than by reseeding.

**Deployment.** One transaction. Prisma wraps each migration in one, and every
statement here is transactional DDL, so a failure at any point rolls the whole
thing back — verified in Phase A when a bad `INSERT` rolled back a 60-statement
rename cleanly. The API must be redeployed with the matching code in the same
release: between the migration and the new build, `inquiry.tos_id` means something
different from what the running code believes. **This is not a zero-downtime
change** — for a single-VPS deployment with one workspace, a brief restart window
is the right trade.

---

## 7. What this presumes, and the cheap escape

The swap presumes **Mode = the CY/CY family**, which is open question 1 in the
module spec and which the client has not answered. The evidence is good but
circumstantial: §4.4 and §6.5 both want a TOS *and* a Mode; §3 says TOS is the
Incoterms; the CY/CY family is the only other shipping-term list in the product,
and it is what `tos` holds today.

If the client later says Mode is something else — CY/Door delivery basis,
direct-versus-transhipment, anything — the correction is small and does not
touch this migration: deactivate the 7 CY/CY rows in `mode`, seed the real values
beside them, and the 3 inquiries keep a historical value that still renders. That
is `is_active = false` on seven shared rows, which is a one-statement change.

The part that is **not** a presumption, and is worth doing regardless of the
answer, is that the Incoterms end up under `tos`. The spec states that outright.
