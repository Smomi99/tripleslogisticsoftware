-- CR-002: a deleted row must stop reserving its natural key.
--
-- Soft delete leaves the row in place, so a plain UNIQUE(tenant_id, port_code)
-- keeps the code taken after the port is gone from every screen. Deleting a
-- mistyped "ZZDEL" and re-adding the correct one then fails against a row the
-- operator cannot see or reach — the sort of dead end that ends in a support
-- call rather than a workaround.
--
-- The business `code` (PL-001) deliberately does NOT get this treatment. It is
-- an identifier that may appear on a printed document, and handing a retired
-- one to a different port would make two records indistinguishable in an
-- archive.

DROP INDEX "port_tenant_id_port_code_key";

CREATE UNIQUE INDEX "port_tenant_id_port_code_key"
  ON "port" ("tenant_id", "port_code")
  WHERE "deleted_at" IS NULL;
