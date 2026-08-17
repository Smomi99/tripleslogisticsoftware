-- RLS for the §3.2 rate tables (CLAUDE.md §7A rule 2).
--
-- New tables do not inherit policies. Without this they would be readable
-- across tenants the moment the API touched them — RLS is deny-by-default only
-- once ENABLE ROW LEVEL SECURITY has been run on the table itself.
--
-- Unlike the §3.1 lookups these are tenant-owned, not system-capable: a bought
-- rate is one forwarder's commercial position and there is no such thing as a
-- shared one. So USING admits nothing beyond the caller's own tenant.
--
-- Of everything in this schema, these four tables are where a cross-tenant read
-- would cost the most: freight_rate_line.buy_price is the margin on every lane
-- the company sells.
ALTER TABLE "freight_rate" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "freight_rate"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "freight_rate_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "freight_rate_line"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "rate_local_charge" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rate_local_charge"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "rate_profit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rate_profit_log"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- rate_profit_log answers "who moved this margin, and when" (§4 rule 6). A log
-- the application can rewrite answers nothing, so ff_app may append to it and
-- read it, and that is all. The UPDATE grant that ALTER DEFAULT PRIVILEGES
-- handed out when the table was created is taken back here.
REVOKE UPDATE ON TABLE rate_profit_log FROM ff_app;
