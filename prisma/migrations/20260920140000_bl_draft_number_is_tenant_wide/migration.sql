-- ===========================================================================
-- A BL draft number counts the workspace's drafts, not the caller's
-- ===========================================================================
--
-- docs/MODULE_DOCUMENTATION.md §2.4 lets a customer start their own BL draft.
-- The number came from MAX(code) over bl_draft — which, inside a customer
-- session, RLS narrows to that customer's own drafts. The first customer to
-- draft anything computed BLD-<year>-000001 while the forwarder had already
-- issued it, and the insert died on the unique constraint.
--
-- Found by having a customer actually submit one (demo:docs).
--
-- The general rule this is an instance of: **a per-tenant sequence computed
-- with MAX() is wrong in any session that cannot see every row of the table.**
-- Nothing else is affected today, because a BL draft is the only record an
-- external session creates — but anything added to /portal that carries a
-- business code needs the same treatment.
--
-- SECURITY DEFINER so the count is over the workspace, with the tenant passed
-- in rather than read from the session: the caller is the API, which resolved
-- it server-side. Same shape as app_claim_email_batch, which exists for the
-- same reason — a caller that cannot see the rows it must count.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_next_bl_draft_seq(p_tenant bigint, p_year integer)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
    SELECT COALESCE(MAX((regexp_replace(code, '^.*-', ''))::integer), 0) + 1
      FROM bl_draft
     WHERE tenant_id = p_tenant
       AND series_year = p_year
       AND code LIKE 'BLD-' || p_year::text || '-%'
  $$;

GRANT EXECUTE ON FUNCTION app_next_bl_draft_seq(bigint, integer) TO ff_app;
