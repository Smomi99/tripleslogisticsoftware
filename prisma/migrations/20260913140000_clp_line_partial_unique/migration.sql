-- One allocation per cargo line per container, AMONG LIVE ROWS.
--
-- Phase B created this index without the deleted_at clause, which makes a
-- released allocation go on occupying the slot: take a line out of container 2
-- and you can never put it back there, because the soft-deleted row still
-- holds the key. §4 rule 3 forbids hard deletes, so the index has to be the
-- part that knows the difference. port_tenant_id_port_code_key is scoped the
-- same way and for the same reason.
DROP INDEX IF EXISTS "clp_line_tenant_id_clp_id_cargo_line_key";

CREATE UNIQUE INDEX "clp_line_tenant_id_clp_id_cargo_line_key"
  ON "clp_line"("tenant_id", "clp_id", "shipment_cargo_line_id")
  WHERE "deleted_at" IS NULL;
