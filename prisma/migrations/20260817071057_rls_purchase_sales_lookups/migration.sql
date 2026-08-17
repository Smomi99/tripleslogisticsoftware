-- RLS for the §3.1 lookups (CLAUDE.md §7A rule 2).
--
-- New tables do not inherit policies. Without this they would be readable
-- across tenants the moment the API touched them — RLS is deny-by-default only
-- once ENABLE ROW LEVEL SECURITY has been run on the table itself.
--
-- These are system-capable: USING admits shared rows (tenant_id IS NULL)
-- alongside the workspace's own; WITH CHECK does not, so a tenant can never
-- create or convert a row into one every other tenant sees (§7A rule 7).
ALTER TABLE "goods_type" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "goods_type"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "container_type" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "container_type"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "rate_tier" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rate_tier"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "tos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tos"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "inquiry_source" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_source"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Partial unique indexes for shared rows (CLAUDE.md §4 rule 9).
-- UNIQUE(tenant_id, code) does not constrain system rows, because Postgres
-- treats every NULL as distinct — any number of them could share a code.
CREATE UNIQUE INDEX "goods_type_code_system_key"      ON "goods_type"      ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "container_type_code_system_key"  ON "container_type"  ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "rate_tier_code_system_key"       ON "rate_tier"       ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "tos_code_system_key"             ON "tos"             ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "inquiry_source_code_system_key"  ON "inquiry_source"  ("code") WHERE "tenant_id" IS NULL;
