-- ===========================================================================
-- Tenant policies the query planner can estimate
-- ===========================================================================
--
-- No table, column or row changes. Every tenant-owned policy keeps exactly
-- the rows it admits today; only the way the predicate is written changes.
--
-- The problem
-- -----------
-- 20260823090000_agent_rls made every policy read
--
--     tenant_id = app_current_tenant() AND app_current_agent() IS NULL
--
-- Postgres keeps a policy's predicate as ONE clause, so the second conjunct
-- is never hoisted out as a once-per-query check. It is estimated per row
-- instead, and an IS NULL over an expression with no statistics gets the
-- default selectivity of 0.5% — so every RLS-filtered table is planned as if
-- it held one row. Where a query filters through related tables (a booking
-- whose cargo line has a receipt line on a confirmed receipt), the planner
-- nests sequential scans inside each other on that belief.
--
-- Measured: GET /clp-bookings took 9.2 s with ~90 bookings — 24 million filter
-- evaluations for two rows — and failed on the 5 s transaction limit. Small
-- tables are the worst case, because a full scan of a one-page table looks
-- cheaper than an index lookup; a young production database is exactly that.
--
-- The fix
-- -------
-- Fold the agent check INTO the tenant comparison:
--
--     tenant_id = app_staff_tenant()
--
-- app_staff_tenant() is the tenant for a staff session and NULL for an agent
-- session, so the predicate admits the same rows in every case:
--
--   staff (app.agent_id unset or '')  -> tenant_id = <tenant>      same rows
--   agent (app.agent_id set)          -> tenant_id = NULL          no rows
--   no tenant set                     -> tenant_id = NULL          no rows
--
-- and WITH CHECK rejects NULL just as it rejected FALSE. A column compared
-- with one expression is something the planner has statistics for: in the
-- rolled-back proof at 400 received bookings the same query was estimated
-- at 104 rows against 143 real (was: 1) and ran on a hash join.
--
-- It is built from the existing functions, so it inlines to the same
-- current_setting reads and fails the same way on a malformed setting.
--
-- Not changed
-- -----------
--   * The 16 system-capable policies (ports, carriers, currencies...). Their
--     shared rows cannot be expressed as one column comparison, and they are
--     small lookup tables reached by primary key, not filtered through chains.
--   * Every agent_read / agent_rw / agent_write policy. The agent portal's
--     own access rules are untouched.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_staff_tenant() RETURNS BIGINT
  LANGUAGE sql
  STABLE
  AS $$ SELECT CASE WHEN app_current_agent() IS NULL THEN app_current_tenant() END $$;

-- Rewritten from the catalogue, as 20260823090000_agent_rls did, and only
-- where the predicate is exactly the tenant-owned shape — anything else is
-- left as it is rather than guessed at.
DO $do$
DECLARE
  p record;
  rewritten integer := 0;
  staff_only constant text := '((tenant_id = app_current_tenant()) AND (app_current_agent() IS NULL))';
  staff_self constant text := '((id = app_current_tenant()) AND (app_current_agent() IS NULL))';
BEGIN
  FOR p IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('tenant_isolation', 'tenant_self')
      AND qual IN (staff_only, staff_self)
  LOOP
    IF p.qual = staff_only AND p.with_check IS NOT DISTINCT FROM staff_only THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I USING (tenant_id = app_staff_tenant()) WITH CHECK (tenant_id = app_staff_tenant())',
        p.policyname, p.tablename);
    ELSIF p.qual = staff_self AND p.with_check IS NOT DISTINCT FROM staff_self THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I USING (id = app_staff_tenant()) WITH CHECK (id = app_staff_tenant())',
        p.policyname, p.tablename);
    ELSE
      RAISE EXCEPTION 'Policy %.% has the staff USING clause but an unexpected WITH CHECK (%) — not rewriting it blind.',
        p.tablename, p.policyname, p.with_check;
    END IF;
    rewritten := rewritten + 1;
  END LOOP;

  RAISE NOTICE 'Rewrote % tenant-owned policies to tenant_id = app_staff_tenant().', rewritten;

  -- Post-condition: nothing is left in the old tenant-owned shape.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND qual IN (staff_only, staff_self)
  ) THEN
    RAISE EXCEPTION 'A tenant-owned policy still uses the unestimable form.';
  END IF;
END
$do$;
