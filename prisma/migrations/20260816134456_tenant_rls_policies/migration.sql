-- Tenant isolation via PostgreSQL Row-Level Security (CLAUDE.md §7A rule 2).
--
-- RLS is the safety net, not the primary control. Application-level scoping
-- in the Prisma extension is layer one; these policies catch the query where
-- a developer forgot the where clause.
--
-- A table OWNER bypasses RLS unless FORCE ROW LEVEL SECURITY is set. That is
-- deliberate here: migrations and the seed run as the owner (ff_erp) and must
-- see every row. The API connects as ff_app, which owns nothing, so the
-- policies below actually bind. Getting this backwards makes RLS inert while
-- appearing to work — see DATABASE_URL_APP in .env.example.

-- =========================================================================
-- 1. Application role — owns nothing, so RLS applies to it
-- =========================================================================
-- Created without LOGIN and without a password: credentials are per
-- environment and never belong in a committed migration. For local dev run
--   pnpm db:app-role
-- which grants LOGIN with the dev password.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ff_app') THEN
    CREATE ROLE ff_app NOLOGIN;
  END IF;
END $$;

-- =========================================================================
-- 2. Privileges
-- =========================================================================
-- No DELETE anywhere. §4 rule 3 forbids hard deletes, so the application role
-- is simply not granted the privilege — a stray deleteMany fails at the
-- database rather than silently destroying history.
GRANT USAGE ON SCHEMA public TO ff_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ff_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ff_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ff_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ff_app;

-- Platform-only tables are not tenant traffic.
REVOKE ALL ON TABLE platform_user FROM ff_app;
-- _prisma_migrations is guarded because `prisma migrate dev` replays this file
-- against a shadow database where that table does not exist. An unguarded
-- REVOKE there aborts the whole migration.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
  ) THEN
    EXECUTE 'REVOKE ALL ON TABLE _prisma_migrations FROM ff_app';
  END IF;
END $$;
-- The permission registry is seeded from a code constant and read-only at runtime.
REVOKE INSERT, UPDATE ON TABLE permission FROM ff_app;

-- =========================================================================
-- 3. Current-tenant accessor
-- =========================================================================
-- Returns NULL when app.tenant_id is unset, so every policy below evaluates
-- to NULL and therefore denies. An unset tenant reads nothing; it never
-- falls back to reading everything.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS BIGINT
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::bigint $$;

-- =========================================================================
-- 4. Tenant-owned tables (25) — see only your own rows
-- =========================================================================
ALTER TABLE "agent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "agent_expert_area" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_expert_area"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "agent_network_member" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_network_member"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "agent_pic" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_pic"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "agent_port_coverage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_port_coverage"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "carrier_pic" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "carrier_pic"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "carrier_service_port" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "carrier_service_port"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "commodity_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commodity_item"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "cost_head" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cost_head"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "currency_rate_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "currency_rate_history"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "customer_pic" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_pic"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "employee" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "employee"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "employee_cv" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "employee_cv"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "employee_salary" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "employee_salary"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "industry_sector" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "industry_sector"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "role" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "role_permission" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role_permission"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "tenant_master_override" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_master_override"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "user_permission" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_permission"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "vendor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "vendor_pic" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_pic"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "vessel" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vessel"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- =========================================================================
-- 5. System-capable tables (8) — read system rows, write only your own
-- =========================================================================
-- USING admits system rows (tenant_id IS NULL) alongside the tenant's own.
-- WITH CHECK does not, so a tenant can never create or convert a row into a
-- system row visible to every other tenant (§7A rule 7).
ALTER TABLE "carrier" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "carrier"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "carrier_type" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "carrier_type"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "cost_unit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cost_unit"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "currency" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "currency"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "expert_area" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "expert_area"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "network" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "network"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "port" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "port"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "vendor_type" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_type"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- =========================================================================
-- 6. The tenant row itself
-- =========================================================================
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "tenant"
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- =========================================================================
-- 7. Tenant resolution accessor
-- =========================================================================
-- Chicken-and-egg: resolving a subdomain to a tenant has to read the tenant
-- table before app.tenant_id is known, which policy tenant_self forbids.
--
-- The fix is a SECURITY DEFINER function rather than a loosened policy. It
-- runs as the owner, so it bypasses RLS, but it is the only thing that can:
-- it takes one slug and returns only the id and status needed to establish a
-- session. Widening the tenant_self policy instead would expose every tenant
-- row to any unauthenticated request.
CREATE OR REPLACE FUNCTION app_resolve_tenant(p_slug TEXT)
  RETURNS TABLE (id BIGINT, status tenant_status)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
  AS $$
    SELECT t.id, t.status
    FROM tenant t
    WHERE t.slug = p_slug
      AND t.deleted_at IS NULL
  $$;

REVOKE ALL ON FUNCTION app_resolve_tenant(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_tenant(TEXT) TO ff_app;
