-- inquiry.remarks leaves the agent's view.
--
-- Decision 2 hides the customer's identity and the target price from agents.
-- Those two are enforced structurally: agent_inquiry_v has no such column, so
-- no query can return one. remarks was the exception — free text the
-- forwarder's own staff type, through which a customer name could reach an
-- agent, and which no database rule can police.
--
-- Flagged at the end of Phase 3 as the one place where the guarantee was
-- advisory rather than structural. The client's answer: exclude it. So decision
-- 2 is now enforced the same way everywhere, and there is no field on this view
-- whose safety depends on what somebody typed.
--
-- The agent still writes their own remarks on a quote — agent_quote.remarks is
-- theirs, travels the other way, and is untouched.
--
-- A view's columns cannot be dropped by CREATE OR REPLACE, so it is rebuilt.
DROP VIEW "agent_inquiry_v";

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
-- notify_emails, remarks, created_by, updated_by.
GRANT SELECT ON "agent_inquiry_v" TO ff_app;
