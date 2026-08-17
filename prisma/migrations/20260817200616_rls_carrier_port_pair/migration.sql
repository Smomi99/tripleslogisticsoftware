-- RLS for carrier_port_pair (CLAUDE.md §7A rule 2).
--
-- New tables do not inherit policies. Without this the table would be readable
-- across tenants the moment the API touched it — RLS is deny-by-default only
-- once ENABLE ROW LEVEL SECURITY has been run on the table itself.
--
-- Tenant-owned, like carrier_service_port: the carrier is shared, but one
-- forwarder's ranking of it is that forwarder's own commercial judgement and
-- must never be visible to a competitor on the same database.
ALTER TABLE "carrier_port_pair" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "carrier_port_pair"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
