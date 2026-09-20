-- ===========================================================================
-- CR-004 step 1 — the session declares what kind it is
-- ===========================================================================
--
-- No table, column, row or policy changes. This file only adds functions, and
-- redefines app_staff_tenant() in terms of one of them. Every session behaves
-- exactly as it does today.
--
-- The problem
-- -----------
-- app_staff_tenant() does not mean "this is a staff session". It means "this
-- is not an agent session":
--
--     SELECT CASE WHEN app_current_agent() IS NULL THEN app_current_tenant() END
--
-- That is an open-world assumption. It was correct while staff and agent were
-- the only two kinds of session, and it fails OPEN the moment there is a third.
--
-- Measured on the dev database before this migration: a session with
-- app.tenant_id set, app.agent_id empty and app.customer_id set — which is what
-- a customer session looks like — read 16 of 16 shipments, 10 of 10 customers,
-- 25 quotations and all 6 rows of "user" including their argon2 hashes. It was
-- byte-identical to a staff session.
--
-- The fix, in two steps
-- ---------------------
-- A session states its kind in app.actor_kind, and staff becomes a positive
-- claim rather than the absence of anything else. This file is step 1: the
-- BRIDGE, which still accepts an undeclared session on the old terms, so it can
-- be applied while an API that does not yet set the GUC is still running.
-- 20260920091000_actor_kind_closed_world flips that off.
--
-- Deploy order: the API image that sets app.actor_kind ships FIRST. Writing an
-- undeclared custom GUC against the old database is harmless, so there is no
-- window in which either half is alone and wrong.
-- ===========================================================================

-- Which kind of session this is. NULL when nobody has said.
CREATE OR REPLACE FUNCTION app_actor_kind() RETURNS text
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULLIF(current_setting('app.actor_kind', true), '') $$;

-- The customer this session belongs to. Mirrors app_current_agent(), and is
-- set by withCustomer() from the user row — never from a token or a request.
CREATE OR REPLACE FUNCTION app_current_customer() RETURNS BIGINT
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULLIF(current_setting('app.customer_id', true), '')::bigint $$;

-- The bridge. When a kind is declared it is believed; when none is, the old
-- rule applies unchanged. Backward compatible by construction.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$ SELECT CASE
                 WHEN app_actor_kind() IS NOT NULL THEN app_actor_kind() = 'STAFF'
                 ELSE app_current_agent() IS NULL AND app_current_customer() IS NULL
               END $$;

-- Delegates to app_is_staff(). The 64 tenant-owned policies and tenant_self are
-- NOT touched: they still read `tenant_id = app_staff_tenant()`, so the
-- single-comparison shape 20260917090000 introduced for the query planner is
-- preserved exactly, and this migration cannot regress a plan.
CREATE OR REPLACE FUNCTION app_staff_tenant() RETURNS BIGINT
  LANGUAGE sql
  STABLE
  AS $$ SELECT CASE WHEN app_is_staff() THEN app_current_tenant() END $$;

GRANT EXECUTE ON FUNCTION app_actor_kind() TO ff_app;
GRANT EXECUTE ON FUNCTION app_current_customer() TO ff_app;
GRANT EXECUTE ON FUNCTION app_is_staff() TO ff_app;
