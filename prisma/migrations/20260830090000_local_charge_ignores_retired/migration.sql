-- A retired local charge should not block its own replacement.
--
-- §4 rule 3 is soft delete: removing a charge sets deleted_at and leaves the
-- row. Both unique indexes counted those rows, so a cost head removed from a
-- rate could never be added back to it — the second attempt collided with the
-- retired first and surfaced as a 500 the operator could do nothing about.
--
-- Both indexes become partial. Nothing is dropped that a live row depends on:
-- the new indexes are strictly weaker, so any data that satisfied the old ones
-- satisfies these.
DROP INDEX IF EXISTS "rate_local_charge_tenant_id_rate_id_cost_head_id_side_containe_";
DROP INDEX IF EXISTS "rate_local_charge_any_container_key";

CREATE UNIQUE INDEX "rate_local_charge_tenant_id_rate_id_cost_head_id_side_containe_"
  ON "rate_local_charge" ("tenant_id", "rate_id", "cost_head_id", "side", "container_size_id")
  WHERE "deleted_at" IS NULL;

-- Postgres treats every NULL as distinct, so the index above would allow any
-- number of "applies to any size" lines for one head and side. This keeps it to
-- one — among the live rows.
CREATE UNIQUE INDEX "rate_local_charge_any_container_key"
  ON "rate_local_charge" ("tenant_id", "rate_id", "cost_head_id", "side")
  WHERE "container_size_id" IS NULL AND "deleted_at" IS NULL;
