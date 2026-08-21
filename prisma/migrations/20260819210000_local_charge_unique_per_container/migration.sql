-- A local charge is unique per cost head, side AND container size.
--
-- THC on a 20ft and THC on a 40ft are two legitimate lines on one rate. The
-- old key stopped at (rate, cost_head, side) and rejected the second one, which
-- is exactly what the new container_type_id column exists to allow.

DROP INDEX "rate_local_charge_tenant_id_rate_id_cost_head_id_side_key";

CREATE UNIQUE INDEX "rate_local_charge_tenant_id_rate_id_cost_head_id_side_containe_key"
  ON "rate_local_charge" ("tenant_id", "rate_id", "cost_head_id", "side", "container_type_id");

-- Postgres treats every NULL as distinct, so the index above would allow any
-- number of "applies to any size" lines for the same head and side. This keeps
-- there to exactly one.
CREATE UNIQUE INDEX "rate_local_charge_any_container_key"
  ON "rate_local_charge" ("tenant_id", "rate_id", "cost_head_id", "side")
  WHERE "container_type_id" IS NULL;
