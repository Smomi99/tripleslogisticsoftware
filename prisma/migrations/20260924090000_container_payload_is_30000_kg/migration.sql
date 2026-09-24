-- ===========================================================================
-- A 20STD, 40STD and 40HC take 30,000 kg, not 26,000
-- ===========================================================================
--
-- docs/MODULE_CLP.md §3.1 seeded all three at 26,000 kg from the client's
-- table. Raised to 30,000 kg on 2026-09-24, after ticked POs weighing
-- 26,422 kg were refused a 20STD on the old figure. The 45FT already took
-- 30,000, so every shared size now does.
--
-- Only the shared rows, and only while they still hold the old figure:
--
--   - a workspace that customised its own size chose its own payload, and
--     that choice stands;
--   - a database built after 20260913090000 had no figures here to change;
--     seed.ts fills those in, at the new figures.
--
-- The audit trigger skips shared rows — there is no tenant to attribute them
-- to — so this file and §3.1 are the record of the change.
-- ===========================================================================

UPDATE "container_size" SET "max_weight_kg" = 30000
  WHERE "tenant_id" IS NULL
    AND "code" IN ('20STD', '40STD', '40HC')
    AND "max_weight_kg" = 26000
    AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Draft plans already on them
-- ---------------------------------------------------------------------------
-- weight_utilisation is stored, not derived at read time. A draft loaded
-- against 26,000 would go on saying so: the virtual container reads the new
-- limit live while the finalise dialog showed the old percentage, until some
-- line happened to change. Recomputed the way recomputeClp() does it — four
-- places, capped at the column's 9.9999.
--
-- Drafts only. A final or cancelled plan keeps the figures it was closed with,
-- as recomputeClp() already insists.
UPDATE "clp" c
   SET "weight_utilisation" = LEAST(ROUND(c."total_gross_weight_kg" / s."max_weight_kg", 4), 9.9999)
  FROM "container_size" s
 WHERE s."id" = c."container_size_id"
   AND s."tenant_id" IS NULL
   AND s."code" IN ('20STD', '40STD', '40HC')
   AND s."max_weight_kg" > 0
   AND c."status" = 'DRAFT'
   AND c."deleted_at" IS NULL
   AND c."total_gross_weight_kg" IS NOT NULL;
