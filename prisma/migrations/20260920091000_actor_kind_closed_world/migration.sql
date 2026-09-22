-- ===========================================================================
-- CR-004 step 2 — an undeclared session is no longer staff
-- ===========================================================================
--
-- The flip. Apply only once every writer of a database session declares its
-- kind: withTenant(), withAgent(), withCustomer() and recordAudit(). Those are
-- the only three places in apps/api/src that call set_config — verified by
-- grep, and there is a test that fails if a fourth appears without a kind.
--
-- Separate from 20260920090000 on purpose. This is the file that can deny
-- staff access if the API is older than the database, and it reverts on its
-- own: re-run the bridge definition of app_is_staff() and everything is as it
-- was. No policy names a kind directly, so a rollback needs no policy changes.
-- ===========================================================================

-- No kind declared -> false -> app_staff_tenant() is NULL -> every staff
-- policy denies. COALESCE rather than leaving it NULL so the function answers
-- a boolean question with a boolean, and reads the same way in a test.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$ SELECT COALESCE(app_actor_kind() = 'STAFF', false) $$;

-- ---------------------------------------------------------------------------
-- The 16 system-capable policies
-- ---------------------------------------------------------------------------
-- These were deliberately left alone by 20260917090000 (their predicate cannot
-- be folded into one column comparison, and they are small lookup tables
-- reached by primary key). They therefore still carry the old
-- `AND app_current_agent() IS NULL` conjunct — which, unchanged, would let a
-- customer session read every tenant-private carrier, currency, port, cost
-- unit, expert area, network, vendor type and carrier type in the workspace.
--
-- Rewritten from the catalogue rather than listed by hand, as
-- 20260823090000_agent_rls and 20260917090000 both did: a hand-written list is
-- wrong the day a table is added. One boolean is swapped for another, so the
-- predicate has the same shape and the same selectivity as before.
DO $do$
DECLARE
  p record;
  old_using constant text :=
    '(((tenant_id IS NULL) OR (tenant_id = app_current_tenant())) AND (app_current_agent() IS NULL))';
  old_check constant text :=
    '((tenant_id = app_current_tenant()) AND (app_current_agent() IS NULL))';
  n integer := 0;
BEGIN
  FOR p IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'tenant_isolation'
      AND qual = old_using
      AND with_check IS NOT DISTINCT FROM old_check
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %I
         USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_is_staff())
         WITH CHECK (tenant_id = app_current_tenant() AND app_is_staff())',
      p.policyname, p.tablename);
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'Rewrote % system-capable policies to app_is_staff().', n;

  IF n <> 16 THEN
    RAISE EXCEPTION
      'Expected 16 system-capable policies in the pre-CR-004 shape, found %. Stopping rather than guessing.', n;
  END IF;

  -- Post-condition: nothing anywhere still infers staff from an absent agent
  -- id. The agent_read / agent_rw policies use IS NOT NULL and are untouched.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND (qual LIKE '%app_current_agent() IS NULL%'
           OR with_check LIKE '%app_current_agent() IS NULL%')
  ) THEN
    RAISE EXCEPTION 'A policy still infers staff from an absent agent id.';
  END IF;
END
$do$;
