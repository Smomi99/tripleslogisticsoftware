-- The safety net for §4 rule 10, on every tenant-owned row that points at a
-- system-capable parent.
--
-- §4 rule 10 asks for composite tenant-safe foreign keys. Fourteen tables
-- cannot have one: their parent is system-capable (§7A rule 7), so a shared
-- port or carrier has tenant_id NULL and REFERENCES port(tenant_id, id) can
-- never resolve for exactly the rows that matter most. Those references are
-- therefore plain single-column FKs, and the database has had nothing to say
-- about whose port it is.
--
-- RLS does not cover this. Its policy tests the CHILD's tenant_id; a row whose
-- own tenant_id is correct passes even when its carrier_id names a competitor's
-- private carrier. The FK does not cover it either — referential checks run
-- with RLS bypassed, so the reference resolves happily.
--
-- Rule 10 allows "a checked constraint" as the alternative, which a subquery
-- CHECK cannot express. A trigger can. §4 rule 10 calls cross-tenant leakage
-- through a join "the single worst failure mode here", so this is the layer
-- that makes the claim true rather than merely intended.
--
-- The application already refuses these writes: the Prisma extension scopes
-- every parent lookup, so a route resolving another workspace's carrier gets
-- null and answers 404. That is layer one and stays layer one. This is the
-- layer that catches the route which forgets.

CREATE OR REPLACE FUNCTION app_assert_parent_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_table  CONSTANT text := TG_ARGV[0];
  fk_column     CONSTANT text := TG_ARGV[1];
  parent_id     bigint;
  parent_tenant bigint;
  parent_found  boolean;
BEGIN
  parent_id := (to_jsonb(NEW) ->> fk_column)::bigint;
  IF parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Deliberately NOT security definer. Running as the caller means RLS applies
  -- to this lookup, so a parent belonging to another tenant is invisible and
  -- comes back as no row at all. The foreign key already guarantees the row
  -- exists, so "not found" can only mean "not yours".
  EXECUTE format('SELECT tenant_id, true FROM %I WHERE id = $1', parent_table)
    INTO parent_tenant, parent_found
    USING parent_id;

  IF NOT COALESCE(parent_found, false) THEN
    RAISE EXCEPTION
      'cross-tenant reference: %.% = % is not visible to tenant %',
      TG_TABLE_NAME, fk_column, parent_id, NEW.tenant_id
      USING ERRCODE = '42501';
  END IF;

  -- Reached when RLS is bypassed — the owner running a migration or a seed.
  -- tenant_id IS NULL is a shared row and belongs to everyone.
  IF parent_tenant IS NOT NULL AND parent_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'cross-tenant reference: %.% = % belongs to tenant %, not tenant %',
      TG_TABLE_NAME, fk_column, parent_id, parent_tenant, NEW.tenant_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

GRANT EXECUTE ON FUNCTION app_assert_parent_tenant() TO ff_app;

-- One trigger per (child table, foreign key column). Generated from the
-- catalogue rather than hand-listed, so none was missed: every single-column FK
-- from a table with tenant_id NOT NULL to a table with tenant_id NULLABLE.
-- UPDATE OF <column> keeps it off the bulk updates that never touch the
-- reference, such as the nightly rate expiry.

CREATE TRIGGER agent_expert_area_expert_area_id_tenant_guard
  BEFORE INSERT OR UPDATE OF expert_area_id ON agent_expert_area
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('expert_area', 'expert_area_id');
CREATE TRIGGER agent_network_member_network_id_tenant_guard
  BEFORE INSERT OR UPDATE OF network_id ON agent_network_member
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('network', 'network_id');
CREATE TRIGGER agent_port_coverage_port_id_tenant_guard
  BEFORE INSERT OR UPDATE OF port_id ON agent_port_coverage
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'port_id');
CREATE TRIGGER carrier_pic_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON carrier_pic
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
CREATE TRIGGER carrier_port_pair_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON carrier_port_pair
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
CREATE TRIGGER carrier_port_pair_pod_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pod_id ON carrier_port_pair
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pod_id');
CREATE TRIGGER carrier_port_pair_pol_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pol_id ON carrier_port_pair
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pol_id');
CREATE TRIGGER carrier_service_port_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON carrier_service_port
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
CREATE TRIGGER carrier_service_port_port_id_tenant_guard
  BEFORE INSERT OR UPDATE OF port_id ON carrier_service_port
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'port_id');
CREATE TRIGGER cost_head_unit_id_tenant_guard
  BEFORE INSERT OR UPDATE OF unit_id ON cost_head
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('cost_unit', 'unit_id');
CREATE TRIGGER currency_rate_history_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON currency_rate_history
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');
CREATE TRIGGER freight_rate_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON freight_rate
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
CREATE TRIGGER freight_rate_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON freight_rate
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');
CREATE TRIGGER freight_rate_goods_type_id_tenant_guard
  BEFORE INSERT OR UPDATE OF goods_type_id ON freight_rate
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('goods_type', 'goods_type_id');
CREATE TRIGGER freight_rate_pod_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pod_id ON freight_rate
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pod_id');
CREATE TRIGGER freight_rate_pol_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pol_id ON freight_rate
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pol_id');
CREATE TRIGGER freight_rate_purchase_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF purchase_carrier_id ON freight_rate
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'purchase_carrier_id');
CREATE TRIGGER freight_rate_line_tier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF tier_id ON freight_rate_line
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('rate_tier', 'tier_id');
CREATE TRIGGER inquiry_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON inquiry
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');
CREATE TRIGGER inquiry_pod_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pod_id ON inquiry
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pod_id');
CREATE TRIGGER inquiry_pol_id_tenant_guard
  BEFORE INSERT OR UPDATE OF pol_id ON inquiry
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pol_id');
CREATE TRIGGER inquiry_source_id_tenant_guard
  BEFORE INSERT OR UPDATE OF source_id ON inquiry
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('inquiry_source', 'source_id');
CREATE TRIGGER inquiry_tos_id_tenant_guard
  BEFORE INSERT OR UPDATE OF tos_id ON inquiry
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('tos', 'tos_id');
CREATE TRIGGER inquiry_volume_container_type_id_tenant_guard
  BEFORE INSERT OR UPDATE OF container_type_id ON inquiry_volume
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_type', 'container_type_id');
CREATE TRIGGER rate_local_charge_cost_unit_id_tenant_guard
  BEFORE INSERT OR UPDATE OF cost_unit_id ON rate_local_charge
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('cost_unit', 'cost_unit_id');
CREATE TRIGGER rate_local_charge_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON rate_local_charge
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');
CREATE TRIGGER vendor_vendor_type_id_tenant_guard
  BEFORE INSERT OR UPDATE OF vendor_type_id ON vendor
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('vendor_type', 'vendor_type_id');
CREATE TRIGGER vessel_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON vessel
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
