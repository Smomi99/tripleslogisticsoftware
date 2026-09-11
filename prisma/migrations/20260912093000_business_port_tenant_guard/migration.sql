-- §4 rule 10 for the new lane table.
--
-- pol_id and pod_id point at port, which is system-capable (§7A rule 7), so
-- the foreign key alone cannot say whose port it is — a plain FK would accept
-- another workspace's private port row quite happily. The trigger is what
-- makes the reference tenant-safe, the same way carrier_port_pair's own lane
-- columns are guarded.
--
-- Separate from the migration that created the table because that one had
-- already been applied here; editing an applied migration changes its checksum
-- and the next deploy refuses to run. CREATE OR REPLACE so this is a no-op
-- where the triggers were already put on by hand.
CREATE OR REPLACE TRIGGER commodity_business_port_pol_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pol_id ON commodity_business_port
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pol_id');

CREATE OR REPLACE TRIGGER commodity_business_port_pod_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pod_id ON commodity_business_port
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pod_id');
