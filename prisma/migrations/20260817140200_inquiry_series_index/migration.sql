-- The inquiry number is allocated by scanning the last code for a tenant and
-- year, so the index has to carry `code` as well — a two-column index on
-- (tenant_id, series_year) still forces a heap lookup per candidate row.

-- This migration originally read:
--     DROP INDEX "inquiry_tenant_id_series_year_idx";
--     ALTER INDEX "inquiry_series_lookup" RENAME TO "inquiry_tenant_id_series_year_code_idx";
-- which `prisma migrate dev` produced by diffing against a development
-- database where "inquiry_series_lookup" had been created by hand. Nothing in
-- the migration history ever created it, so replaying the chain onto an empty
-- database failed here with `relation "inquiry_series_lookup" does not exist`,
-- leaving a half-built schema. Rewritten to create the index outright, which
-- reaches the same final state from either starting point.

DROP INDEX IF EXISTS "inquiry_tenant_id_series_year_idx";
DROP INDEX IF EXISTS "inquiry_series_lookup";

CREATE INDEX IF NOT EXISTS "inquiry_tenant_id_series_year_code_idx"
  ON "inquiry" ("tenant_id", "series_year", "code");
