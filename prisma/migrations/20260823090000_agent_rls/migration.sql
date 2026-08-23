-- Phase 3 of the agent portal: the layer that has to hold when the application
-- layer is wrong.
--
-- Phase 2 decided which door a credential opens. This decides what is reachable
-- once through it, in the one place a forgotten `where` cannot undo.

-- ---------------------------------------------------------------------------
-- 1. A second GUC
-- ---------------------------------------------------------------------------
-- Set transaction-locally by withAgent(), beside app.tenant_id. A staff session
-- never sets it, so it reads NULL for them — which is what makes step 2 a
-- no-op for every existing query.
CREATE OR REPLACE FUNCTION app_current_agent() RETURNS BIGINT
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULLIF(current_setting('app.agent_id', true), '')::bigint $$;

-- ---------------------------------------------------------------------------
-- 2. Every existing policy becomes staff-only
-- ---------------------------------------------------------------------------
-- Rewritten from the catalogue rather than listed by hand: 56 policies in two
-- different shapes (tenant-owned, and system-capable which also admits
-- tenant_id IS NULL), and a hand-written list would be wrong the day a table is
-- added. Each keeps its own predicate and gains one conjunct.
--
-- Backward compatible by construction. app_current_agent() IS NULL is true for
-- every staff session, so the predicate reduces to exactly what it was. The
-- agreed gate is that all 467 existing tests still pass; if they do not, this
-- is wrong somewhere and we stop.
--
-- The effect for an agent session is: deny everything. Access is then opened
-- one table at a time in step 3, which is the only way to be sure of what an
-- outside company can reach — an allow-list you can read in one screen.
DO $do$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('tenant_isolation', 'tenant_self')
  LOOP
    IF p.with_check IS NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I USING (%s AND app_current_agent() IS NULL)',
        p.policyname, p.tablename, p.qual);
    ELSE
      EXECUTE format(
        'ALTER POLICY %I ON %I USING (%s AND app_current_agent() IS NULL)
           WITH CHECK (%s AND app_current_agent() IS NULL)',
        p.policyname, p.tablename, p.qual, p.with_check);
    END IF;
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- 3. The openings
-- ---------------------------------------------------------------------------
-- Order matters here, and the reason is easy to miss: RLS applies inside a
-- policy's own subqueries. The EXISTS in the inquiry policy runs as ff_app and
-- is itself filtered by inquiry_party's policies. If inquiry_party stayed
-- closed to agents, that EXISTS would find nothing, every inquiry would be
-- invisible, and the feature would fail closed while looking like a bug.

-- 3.1 The rows that say this agent was selected.
CREATE POLICY agent_read ON "inquiry_party" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND agent_id = app_current_agent()
  );

-- 3.2 Decision 5: being explicitly selected IS the authorization boundary.
-- There is no "all open inquiries on your lane" — an agent sees an inquiry
-- because someone chose to send it to them, and for no other reason.
CREATE POLICY agent_read ON "inquiry" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "inquiry_party" ip
      WHERE ip.inquiry_id = "inquiry".id
        AND ip.tenant_id = "inquiry".tenant_id
        AND ip.agent_id = app_current_agent()
    )
  );

-- 3.3 Children inherit the parent's rule rather than restating it. The inner
-- SELECT is itself filtered by 3.2, so there is one predicate to get right
-- instead of one per child table.
CREATE POLICY agent_read ON "inquiry_volume" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "inquiry" i WHERE i.id = "inquiry_volume".inquiry_id)
  );

-- 3.4 Their own record and their own people.
CREATE POLICY agent_read ON "agent" FOR SELECT
  USING (tenant_id = app_current_tenant() AND id = app_current_agent());
CREATE POLICY agent_read ON "agent_pic" FOR SELECT
  USING (tenant_id = app_current_tenant() AND agent_id = app_current_agent());

-- 3.5 Their own quotes, read and write. WITH CHECK is what stops an agent
-- writing a quote in another agent's name — the USING clause alone would let
-- the row be created and only hide it afterwards.
CREATE POLICY agent_rw ON "agent_quote" FOR ALL
  USING (tenant_id = app_current_tenant() AND agent_id = app_current_agent())
  WITH CHECK (tenant_id = app_current_tenant() AND agent_id = app_current_agent());

-- 3.6 Reference data, read-only. A lane cannot be rendered without it and none
-- of it is confidential. Deliberately short: every extra table is surface, and
-- the list below is the whole of what an outside company can read.
--
-- NOT opened, and worth stating so the absence is deliberate rather than
-- forgotten: customer, freight_rate, freight_rate_line, rate_local_charge,
-- inquiry_rate, user, employee, vendor, carrier, audit_log, tenant, and every
-- settings table.
CREATE POLICY agent_read ON "port" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
CREATE POLICY agent_read ON "container_type" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
CREATE POLICY agent_read ON "currency" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
CREATE POLICY agent_read ON "tos" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
-- commodity_item is tenant-owned, not system-capable.
CREATE POLICY agent_read ON "commodity_item" FOR SELECT
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. The column boundary (approved recommendation A)
-- ---------------------------------------------------------------------------
-- RLS is row-level. An agent may read an inquiry row, and customer_id sits ON
-- that row — as does target_price on inquiry_volume. Hiding the customer table
-- does not hide the customer's identity if the foreign key travels.
--
-- A column-level REVOKE cannot help: ff_app is the same role staff use, so
-- revoking inquiry.customer_id from it would break every staff query too. The
-- boundary is therefore a view, and the portal reads only these.
--
-- security_invoker = true is load-bearing. Without it a view runs with its
-- OWNER's privileges, and this view's owner is the table owner, who bypasses
-- RLS entirely — the view would hand every agent every inquiry in the
-- workspace. The explicit agent predicate below is a second belt on the same
-- trousers: if the invoker setting were ever lost, the view still filters.

CREATE VIEW "agent_inquiry_v" WITH (security_invoker = true) AS
  SELECT
    i.id,
    i.tenant_id,
    i.code,
    i.series_year,
    i.inquiry_date,
    i.shipment_type,
    i.movement_type,
    i.loading_type,
    i.pol_id,
    i.pod_id,
    i.place_of_receipt,
    i.commodity_item_id,
    i.hs_code,
    i.tos_id,
    i.mode_id,
    i.expected_shipment_date,
    i.valid_to,
    -- Free text the forwarder's own staff type. See the note in the Phase 3
    -- commit: this is the one field through which a customer name could reach
    -- an agent, and no database rule can prevent that.
    i.remarks,
    i.status,
    i.created_at
  FROM "inquiry" i
  WHERE i.deleted_at IS NULL
    AND i.tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "inquiry_party" ip
      WHERE ip.inquiry_id = i.id
        AND ip.tenant_id = i.tenant_id
        AND ip.agent_id = app_current_agent()
    );

-- Omitted on purpose: customer_id, currency_id, salesman_id, source_id,
-- notify_emails, created_by, updated_by. The first is decision 2; the last two
-- would name the forwarder's staff to an outside company.

CREATE VIEW "agent_inquiry_volume_v" WITH (security_invoker = true) AS
  SELECT
    v.id,
    v.tenant_id,
    v.inquiry_id,
    v.volume_kind,
    v.container_type_id,
    v.container_type_note,
    v.quantity,
    v.cbm,
    v.weight_kg
  FROM "inquiry_volume" v
  WHERE v.deleted_at IS NULL
    AND v.tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "inquiry" i
      WHERE i.id = v.inquiry_id
        AND i.tenant_id = v.tenant_id
        AND EXISTS (
          SELECT 1 FROM "inquiry_party" ip
          WHERE ip.inquiry_id = i.id
            AND ip.tenant_id = i.tenant_id
            AND ip.agent_id = app_current_agent()
        )
    );

-- target_price is the whole reason this view exists rather than a plain read of
-- inquiry_volume: decision 2 hides what the customer is willing to pay, and
-- that number lives on the volume row.

GRANT SELECT ON "agent_inquiry_v" TO ff_app;
GRANT SELECT ON "agent_inquiry_volume_v" TO ff_app;
