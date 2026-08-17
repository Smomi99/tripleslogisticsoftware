-- RLS for the §3.3 inquiry tables (CLAUDE.md §7A rule 2).
--
-- New tables do not inherit policies. Without this they would be readable
-- across tenants the moment the API touched them — RLS is deny-by-default only
-- once ENABLE ROW LEVEL SECURITY has been run on the table itself.
--
-- All five are tenant-owned: an inquiry is one company's sales pipeline, and
-- there is no such thing as a shared one. So USING admits nothing beyond the
-- caller's own tenant.
ALTER TABLE "sales_lead" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_lead"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "inquiry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "inquiry_volume" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_volume"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "inquiry_followup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_followup"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "inquiry_rate" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_rate"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
