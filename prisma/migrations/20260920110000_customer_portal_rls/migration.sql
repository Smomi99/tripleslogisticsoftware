-- ===========================================================================
-- CR-004 step 3 — what a customer session may reach
-- ===========================================================================
--
-- An allow-list, written the way 20260823090000_agent_rls wrote the agent's:
-- nothing is reachable until it is named here. Steps 1 and 2 already made every
-- staff policy deny a customer session, so this file only opens doors.
--
-- Order matters for the same reason it did there: RLS applies inside a policy's
-- own subqueries, so a policy that reaches through `shipment` needs `shipment`
-- open to the customer first, or it would find nothing and the feature would
-- fail closed while looking like a bug.
-- ===========================================================================

-- 1. Their own company record and their own people.
CREATE POLICY customer_read ON "customer" FOR SELECT
  USING (tenant_id = app_current_tenant() AND id = app_current_customer());

CREATE POLICY customer_read ON "customer_pic" FOR SELECT
  USING (tenant_id = app_current_tenant() AND customer_id = app_current_customer());

-- 2. Their own bookings, and nothing about anybody else's.
CREATE POLICY customer_read ON "shipment" FOR SELECT
  USING (tenant_id = app_current_tenant() AND customer_id = app_current_customer());

-- 3. The advise on one of their bookings — read only. This is where the BL
--    number comes from (MODULE_DOCUMENTATION §3.3), so the draft form cannot
--    open without it. The customer may not write one: the advise is the
--    forwarder's statement of what was shipped.
CREATE POLICY customer_read ON "shipment_advise" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "shipment_advise".shipment_id
         AND s.tenant_id = "shipment_advise".tenant_id
    )
  );

-- 4. Their own BL draft, read and write (§2.4's `Save & Submit`).
--
-- WITH CHECK is what stops a customer creating a draft against another
-- customer's booking: the USING clause alone would let the row be written and
-- only hide it afterwards, which is a row in the forwarder's queue with the
-- wrong company's cargo on it.
CREATE POLICY customer_rw ON "bl_draft" FOR ALL
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "bl_draft".shipment_id AND s.tenant_id = "bl_draft".tenant_id
    )
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "bl_draft".shipment_id AND s.tenant_id = "bl_draft".tenant_id
    )
  );

-- 5. The container block of their own draft — read only.
--
-- The customer does not type container and seal numbers; the forwarder stuffed
-- the box and fills that block in. Deliberately NOT opening `clp`: a
-- consolidated container carries several companies' cargo, and its totals are
-- nobody else's business. See the note in the module spec.
CREATE POLICY customer_read ON "bl_draft_container" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "bl_draft" d
       WHERE d.id = "bl_draft_container".bl_draft_id
         AND d.tenant_id = "bl_draft_container".tenant_id
    )
  );

-- 6. Their own templates — the customer sheet has `Make Templet` too (B60).
--    Scoped to their own customer id: the workspace-wide ones (customer_id
--    NULL) are the forwarder's and stay invisible.
CREATE POLICY customer_rw ON "bl_template" FOR ALL
  USING (tenant_id = app_current_tenant() AND customer_id = app_current_customer())
  WITH CHECK (tenant_id = app_current_tenant() AND customer_id = app_current_customer());

-- 7. The two lookups the BL form renders. Short on purpose: every extra table
--    is surface, and this list is the whole of what an outside company reads.
--
--    NOT opened, and worth stating so the absence is deliberate rather than
--    forgotten: user, employee, agent, vendor, carrier, vessel, quotation,
--    inquiry, every rate table, clp, clp_line, cargo_receipt, shipping_order,
--    audit_log, tenant, and every settings table.
CREATE POLICY customer_read ON "port" FOR SELECT
  USING (
    (tenant_id IS NULL OR tenant_id = app_current_tenant())
    AND app_current_customer() IS NOT NULL
  );

CREATE POLICY customer_read ON "mode" FOR SELECT
  USING (
    (tenant_id IS NULL OR tenant_id = app_current_tenant())
    AND app_current_customer() IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- The column boundary
-- ---------------------------------------------------------------------------
-- RLS is row-level. A customer may read their own shipment row, and
-- created_by, updated_by and quotation_id sit ON that row — the forwarder's
-- staff and the commercial trail behind the booking. Hiding the user table
-- does not hide a salesman's id if the foreign key travels.
--
-- security_invoker = true is load-bearing, exactly as it is on agent_inquiry_v:
-- without it the view runs with its OWNER's privileges, and the owner bypasses
-- RLS entirely — the view would hand every customer every booking in the
-- workspace. The explicit predicate below is a second belt on the same
-- trousers.
CREATE VIEW "customer_shipment_v" WITH (security_invoker = true) AS
  SELECT
    s.id,
    s.tenant_id,
    s.code,
    s.shipment_type,
    s.status,
    s.exporter_name,
    s.importer_name,
    s.pol_id,
    s.pod_id,
    s.etd,
    s.eta,
    s.goods_handover_date,
    s.created_at
  FROM "shipment" s
  WHERE s.deleted_at IS NULL
    AND s.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND s.customer_id = app_current_customer();

-- Omitted on purpose: customer_id (they are the customer), quotation_id,
-- carrier_id, created_by, updated_by, cancel_reason and short_close_reason.
-- The last two are the forwarder's own words about a shipment that went wrong.

GRANT SELECT ON "customer_shipment_v" TO ff_app;
