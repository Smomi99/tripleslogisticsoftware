-- ===========================================================================
-- Customer portal — the tabs on My Shipments (owner, 2026-11-26)
-- ===========================================================================
--
-- Inquiry · Quotation · Booking · Awaiting approval · Shipping Order ·
-- Cargo Receipt · Shipment Advise · BL · Invoice, each listing the signed-in
-- customer's own records of that kind. Read only: the customer approves
-- nothing here yet (the C/S team still works Shipment Approval), and prints
-- the documents the forwarder has already issued to them.
--
-- Written the way 20260920110000_customer_portal_rls was: an allow-list, one
-- table at a time, nothing reachable until it is named here. That migration
-- listed quotation, inquiry, shipping_order and cargo_receipt as closed on
-- purpose; this one opens them, each to the customer's own rows only, and
-- each only in the states a customer has been shown:
--
--   inquiry            their own, any state
--   quotation          their own, and only once SENT (never a draft)
--   shipping_order     their bookings', ISSUED or CANCELLED (not SKIPPED)
--   cargo_receipt      their bookings', CONFIRMED only (a draft is the CFS's
--                      work in progress)
--   cargo_receipt_line the lines of a receipt they can see
--   debit_invoice      their own, once ISSUED (never a draft)
--   shipment_schedule  their bookings' proposed and decided sailings
--   shipment_schedule_leg, shipment_po  the same bookings'
--
-- Still closed, and the absence is deliberate: quotation_line, quotation_cost
-- and every cost table (the PDF is rendered on the forwarder's side, see the
-- portal router), debit_invoice_line and debit_invoice_cost, carrier, vessel,
-- clp, clp_line, user, employee, agent, vendor, every rate table, audit_log.
--
-- The state gates sit in the POLICIES and are repeated in the views. A route
-- that forgot the view and read the table would still never see a draft.
--
-- Order matters for the reason it did in 20260920110000: RLS applies inside a
-- policy's own subqueries, so each policy below reaches through `shipment`,
-- which is already open to the customer for their own bookings.
-- ===========================================================================

-- ---------------------------------------------------------------- 1. rows

CREATE POLICY customer_read ON "inquiry" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND customer_id = app_current_customer()
  );

-- A draft is a price nobody has committed to. §5.3 rule 9 makes SENT the
-- moment the customer is shown one; sent_at is set on that same transition.
CREATE POLICY customer_read ON "quotation" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND customer_id = app_current_customer()
    AND status <> 'DRAFT'
    AND sent_at IS NOT NULL
  );

CREATE POLICY customer_read ON "shipment_schedule" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "shipment_schedule".shipment_id
         AND s.tenant_id = "shipment_schedule".tenant_id
    )
  );

CREATE POLICY customer_read ON "shipment_schedule_leg" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment_schedule" sc
       WHERE sc.id = "shipment_schedule_leg".schedule_id
         AND sc.tenant_id = "shipment_schedule_leg".tenant_id
    )
  );

CREATE POLICY customer_read ON "shipment_po" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "shipment_po".shipment_id
         AND s.tenant_id = "shipment_po".tenant_id
    )
  );

-- SKIPPED is an inbound booking that never needed one: no document exists.
CREATE POLICY customer_read ON "shipping_order" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND status IN ('ISSUED', 'CANCELLED')
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "shipping_order".shipment_id
         AND s.tenant_id = "shipping_order".tenant_id
    )
  );

CREATE POLICY customer_read ON "cargo_receipt" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND status = 'CONFIRMED'
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "cargo_receipt".shipment_id
         AND s.tenant_id = "cargo_receipt".tenant_id
    )
  );

CREATE POLICY customer_read ON "cargo_receipt_line" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "cargo_receipt" cr
       WHERE cr.id = "cargo_receipt_line".cargo_receipt_id
         AND cr.tenant_id = "cargo_receipt_line".tenant_id
    )
  );

-- Keyed on the invoice's own customer, not the booking's: an OTHER invoice may
-- name no booking at all (MODULE_ACCOUNTS).
CREATE POLICY customer_read ON "debit_invoice" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND customer_id = app_current_customer()
    AND status <> 'DRAFT'
    AND issued_at IS NOT NULL
  );

-- ------------------------------------------------------------- 2. columns
--
-- RLS is row-level. Each row opened above carries the forwarder's own columns
-- beside the customer's: the salesman, the quoted price behind an inquiry, the
-- frozen conversion rate, the cost total on an invoice, cancel reasons in the
-- forwarder's own words. The portal reads these views, never the tables, and
-- each view names exactly what a customer may see.
--
-- security_invoker = true is load-bearing, as on customer_shipment_v: without
-- it a view runs as its owner, who bypasses RLS, and would hand every customer
-- every row in the workspace. tenant-isolation.test.ts pins it on every view.
-- The explicit customer predicate in each WHERE is the second belt.

-- Inquiry. The forwarder's working states (RFQ sent to agents, priced from a
-- rate) are not the customer's business, so they read as one: in progress.
CREATE VIEW "customer_inquiry_v" WITH (security_invoker = true) AS
  SELECT
    i.id,
    i.tenant_id,
    i.code,
    i.inquiry_date,
    i.shipment_type,
    i.movement_type,
    i.loading_type,
    i.pol_id,
    i.pod_id,
    i.expected_shipment_date,
    i.valid_to,
    CASE i.status::text
      WHEN 'QUOTED' THEN 'QUOTED'
      WHEN 'WON' THEN 'CONFIRMED'
      WHEN 'LOST' THEN 'CLOSED'
      WHEN 'EXPIRED' THEN 'EXPIRED'
      WHEN 'CANCELLED' THEN 'CANCELLED'
      ELSE 'IN_PROGRESS'
    END AS status,
    i.created_at
  FROM "inquiry" i
  WHERE i.deleted_at IS NULL
    AND i.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND i.customer_id = app_current_customer();
-- Omitted: salesman_id, source_id, lead_id, won_agent_id, target_price,
-- quoted_price, awaiting_rate, notify_emails, remarks, weight_kg, currency_id.

-- Quotation. Every revision the customer was sent, superseded ones included:
-- §5.3 rule 8 — "a customer holding revision 1 must still be able to find the
-- thing they were sent". A revision still in draft is not here.
CREATE VIEW "customer_quotation_v" WITH (security_invoker = true) AS
  SELECT
    q.id,
    q.tenant_id,
    q.code,
    q.revision_no,
    inq.code AS inquiry_code,
    q.quotation_date,
    q.validity_date,
    q.shipment_type,
    q.movement_type,
    q.loading_type,
    q.pol_id,
    q.pod_id,
    q.etd,
    q.eta,
    q.status,
    q.sent_at
  FROM "quotation" q
  LEFT JOIN "inquiry" inq ON inq.id = q.inquiry_id AND inq.tenant_id = q.tenant_id
  WHERE q.deleted_at IS NULL
    AND q.status <> 'DRAFT'
    AND q.sent_at IS NOT NULL
    AND q.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND q.customer_id = app_current_customer();
-- Omitted: conversion_rate, local_currency_id, source_agent_quote_id, the
-- totals (the PDF prints them; the lines behind them stay closed), carrier_id,
-- first_vessel_id, sent_by, cancel_reason, cancelled_by, created_by, updated_by.

-- Awaiting approval: bookings whose proposed sailing waits on the customer.
-- MODULE_BOOKING_CARGO §6.6's queue, VESSEL_PROPOSED, read from their side.
CREATE VIEW "customer_approval_v" WITH (security_invoker = true) AS
  SELECT
    s.id,
    s.tenant_id,
    s.code,
    s.shipment_type,
    s.pol_id,
    s.pod_id,
    sc.transit_type,
    sc.cut_off_date,
    sc.proposed_at,
    first_leg.etd,
    first_leg.voyage_no,
    first_leg.flight_no,
    last_leg.eta,
    po.po_count,
    po.approved_count,
    po.rejected_count
  FROM "shipment" s
  JOIN "shipment_schedule" sc
    ON sc.shipment_id = s.id
   AND sc.tenant_id = s.tenant_id
   AND sc.status = 'PROPOSED'
   AND sc.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT l.etd, l.voyage_no, l.flight_no
      FROM "shipment_schedule_leg" l
     WHERE l.schedule_id = sc.id AND l.tenant_id = sc.tenant_id AND l.deleted_at IS NULL
     ORDER BY l.leg_no ASC
     LIMIT 1
  ) first_leg ON true
  LEFT JOIN LATERAL (
    SELECT l.eta
      FROM "shipment_schedule_leg" l
     WHERE l.schedule_id = sc.id AND l.tenant_id = sc.tenant_id AND l.deleted_at IS NULL
     ORDER BY l.leg_no DESC
     LIMIT 1
  ) last_leg ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS po_count,
           (count(*) FILTER (WHERE p.approval_status = 'APPROVED'))::int AS approved_count,
           (count(*) FILTER (WHERE p.approval_status = 'REJECTED'))::int AS rejected_count
      FROM "shipment_po" p
     WHERE p.shipment_id = s.id AND p.tenant_id = s.tenant_id AND p.deleted_at IS NULL
  ) po ON true
  WHERE s.deleted_at IS NULL
    AND s.status = 'VESSEL_PROPOSED'
    AND s.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND s.customer_id = app_current_customer();
-- Omitted: the carrier and vessel names (both tables stay closed), the
-- carrier's booking number and file, proposed_by, decided_by.

-- Shipping order. The vessel and flight are the snapshot taken at issue, so no
-- vessel table is opened to print them. Warehouse/CFS is where the customer
-- delivers the cargo, which is the point of the document.
CREATE VIEW "customer_shipping_order_v" WITH (security_invoker = true) AS
  SELECT
    so.id,
    so.tenant_id,
    so.code,
    so.shipment_id,
    s.code AS booking_code,
    s.shipment_type,
    s.pol_id,
    s.pod_id,
    so.issue_date,
    so.first_vessel_name,
    so.first_flight_no,
    so.cut_off,
    so.etd,
    so.eta,
    so.warehouse_cfs,
    so.status
  FROM "shipping_order" so
  JOIN "shipment" s ON s.id = so.shipment_id AND s.tenant_id = so.tenant_id
  WHERE so.deleted_at IS NULL
    AND so.status IN ('ISSUED', 'CANCELLED')
    AND so.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND s.customer_id = app_current_customer();
-- Omitted: qr_payload, issued_by, skip_reason, cancel_reason, pdf_file,
-- schedule_id, first_vessel_id.

-- Cargo receipt. Confirmed receipts, with the accepted lines summed: what the
-- warehouse took in. Declined lines and their reasons stay on the forwarder's
-- side; so do the correction trail and the billing basis.
CREATE VIEW "customer_cargo_receipt_v" WITH (security_invoker = true) AS
  SELECT
    cr.id,
    cr.tenant_id,
    cr.code,
    cr.shipment_id,
    s.code AS booking_code,
    s.shipment_type,
    cr.receipt_seq,
    cr.receive_date,
    cr.status,
    t.ctn_qty,
    t.pcs_qty,
    t.gross_weight_kg,
    t.volume_cbm
  FROM "cargo_receipt" cr
  JOIN "shipment" s ON s.id = cr.shipment_id AND s.tenant_id = cr.tenant_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(l.received_ctn_qty), 0)::int AS ctn_qty,
           sum(l.received_pcs_qty)::int AS pcs_qty,
           sum(l.received_gross_weight_kg) AS gross_weight_kg,
           sum(l.received_volume_cbm) AS volume_cbm
      FROM "cargo_receipt_line" l
     WHERE l.cargo_receipt_id = cr.id
       AND l.tenant_id = cr.tenant_id
       AND l.deleted_at IS NULL
       AND l.line_status = 'ACCEPTED'
  ) t ON true
  WHERE cr.deleted_at IS NULL
    AND cr.status = 'CONFIRMED'
    AND cr.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND s.customer_id = app_current_customer();
-- Omitted: unload_location, efr_no, received_by, correction_reason,
-- corrected_by, every line-level remark and decline reason.

-- Shipment advise. Only once it has gone to the customer (§3.8: a draft is not
-- an event the customer has seen). CR-005: one advise may cover several of the
-- customer's bookings; a cancelled one still lists what it covered.
CREATE VIEW "customer_advise_v" WITH (security_invoker = true) AS
  SELECT
    a.id,
    a.tenant_id,
    a.code,
    a.shipment_id,
    s.shipment_type,
    m.booking_codes,
    a.transit_type,
    a.pol_id,
    a.pod_id,
    a.etd,
    a.eta,
    a.house_bl_no,
    a.mbl_no,
    a.status,
    a.sent_at
  FROM "shipment_advise" a
  JOIN "shipment" s ON s.id = a.shipment_id AND s.tenant_id = a.tenant_id
  LEFT JOIN LATERAL (
    SELECT string_agg(bs.code, ', ' ORDER BY bs.id) AS booking_codes
      FROM "shipment_advise_booking" b
      JOIN "shipment" bs ON bs.id = b.shipment_id AND bs.tenant_id = b.tenant_id
     WHERE b.advise_id = a.id
       AND b.tenant_id = a.tenant_id
       AND b.deleted_at IS NULL
       AND (b.released_at IS NULL OR a.status = 'CANCELLED')
  ) m ON true
  WHERE a.deleted_at IS NULL
    AND a.status IN ('SENT', 'CANCELLED')
    AND a.sent_at IS NOT NULL
    AND a.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND s.customer_id = app_current_customer();
-- Omitted: sent_by, email_log_id, cancel_reason, cancelled_by, pdf_file,
-- carrier_id, first_vessel_id, schedule_id, the frozen totals.

-- BL. One row per bill: a sent, live advise numbers it (§3.3), and the BL
-- draft on that advise — the customer's or the forwarder's — carries where it
-- has got to. issued_at is BL Print's issue (§13).
CREATE VIEW "customer_bill_v" WITH (security_invoker = true) AS
  SELECT
    a.id,
    a.tenant_id,
    a.shipment_id,
    s.shipment_type,
    a.house_bl_no AS bl_no,
    m.booking_codes,
    a.pol_id,
    a.pod_id,
    d.status AS draft_status,
    d.issued_at
  FROM "shipment_advise" a
  JOIN "shipment" s ON s.id = a.shipment_id AND s.tenant_id = a.tenant_id
  LEFT JOIN LATERAL (
    SELECT string_agg(bs.code, ', ' ORDER BY bs.id) AS booking_codes
      FROM "shipment_advise_booking" b
      JOIN "shipment" bs ON bs.id = b.shipment_id AND bs.tenant_id = b.tenant_id
     WHERE b.advise_id = a.id
       AND b.tenant_id = a.tenant_id
       AND b.deleted_at IS NULL
       AND b.released_at IS NULL
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT bd.status, bd.issued_at
      FROM "bl_draft" bd
     WHERE bd.advise_id = a.id
       AND bd.tenant_id = a.tenant_id
       AND bd.deleted_at IS NULL
       AND bd.status <> 'CANCELLED'
     ORDER BY bd.id DESC
     LIMIT 1
  ) d ON true
  WHERE a.deleted_at IS NULL
    AND a.status = 'SENT'
    AND a.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND s.customer_id = app_current_customer();

-- Debit invoice. What they were billed, in the invoice's own currency.
CREATE VIEW "customer_invoice_v" WITH (security_invoker = true) AS
  SELECT
    di.id,
    di.tenant_id,
    di.code,
    di.kind,
    di.shipment_id,
    s.code AS booking_code,
    di.invoice_date,
    di.currency_code,
    di.total_amount,
    di.status,
    di.issued_at
  FROM "debit_invoice" di
  LEFT JOIN "shipment" s ON s.id = di.shipment_id AND s.tenant_id = di.tenant_id
  WHERE di.deleted_at IS NULL
    AND di.status <> 'DRAFT'
    AND di.issued_at IS NOT NULL
    AND di.tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND di.customer_id = app_current_customer();
-- Omitted: cost_total_base (the forwarder's margin), total_amount_base,
-- conversion_rate, quotation_id, bank_account_id, recipient_emails, issued_by,
-- sent_by, cancel_reason.

-- Read, and only read. ALTER DEFAULT PRIVILEGES grants INSERT and UPDATE on
-- "TABLES", which includes views, and the simple ones are auto-updatable — a
-- write path to the base tables over columns chosen for reading
-- (20260920120000 says the same of customer_shipment_v).
GRANT SELECT ON
  "customer_inquiry_v",
  "customer_quotation_v",
  "customer_approval_v",
  "customer_shipping_order_v",
  "customer_cargo_receipt_v",
  "customer_advise_v",
  "customer_bill_v",
  "customer_invoice_v"
TO ff_app;

REVOKE INSERT, UPDATE, DELETE ON
  "customer_inquiry_v",
  "customer_quotation_v",
  "customer_approval_v",
  "customer_shipping_order_v",
  "customer_cargo_receipt_v",
  "customer_advise_v",
  "customer_bill_v",
  "customer_invoice_v"
FROM ff_app;

-- ---------------------------------------------------------- 3. permissions
-- Shipped with the migration, as 20261117100000 did, so the deploy that adds
-- the tabs adds the rights that guard them. The seed upserts the same rows
-- from the same code constant.
INSERT INTO "permission" ("module", "feature", "action", "key", "updated_at")
VALUES
  ('CUSTOMER', 'CUSTOMER.INQUIRY', 'VIEW', 'CUSTOMER.INQUIRY.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.QUOTATION', 'VIEW', 'CUSTOMER.QUOTATION.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.QUOTATION', 'EXPORT_PDF', 'CUSTOMER.QUOTATION.EXPORT_PDF', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.APPROVAL', 'VIEW', 'CUSTOMER.APPROVAL.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.SHIPPING_ORDER', 'VIEW', 'CUSTOMER.SHIPPING_ORDER.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.SHIPPING_ORDER', 'EXPORT_PDF', 'CUSTOMER.SHIPPING_ORDER.EXPORT_PDF', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.CARGO_RECEIPT', 'VIEW', 'CUSTOMER.CARGO_RECEIPT.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.ADVISE', 'VIEW', 'CUSTOMER.ADVISE.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.ADVISE', 'EXPORT_PDF', 'CUSTOMER.ADVISE.EXPORT_PDF', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.INVOICE', 'VIEW', 'CUSTOMER.INVOICE.VIEW', CURRENT_TIMESTAMP),
  ('CUSTOMER', 'CUSTOMER.INVOICE', 'EXPORT_PDF', 'CUSTOMER.INVOICE.EXPORT_PDF', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- A role that already shows a customer their shipments shows them the new
-- tabs too, so existing customer logins see them on the day this ships. Each
-- tab can still be taken away on the Roles matrix, or per user with a DENY.
INSERT INTO "role_permission" ("tenant_id", "role_id", "permission_id", "created_at")
SELECT rp."tenant_id", rp."role_id", p."id", now()
  FROM "role_permission" rp
  JOIN "permission" sv ON sv."id" = rp."permission_id" AND sv."key" = 'CUSTOMER.SHIPMENT.VIEW'
  JOIN "permission" p ON p."key" IN (
    'CUSTOMER.INQUIRY.VIEW',
    'CUSTOMER.QUOTATION.VIEW',
    'CUSTOMER.QUOTATION.EXPORT_PDF',
    'CUSTOMER.APPROVAL.VIEW',
    'CUSTOMER.SHIPPING_ORDER.VIEW',
    'CUSTOMER.SHIPPING_ORDER.EXPORT_PDF',
    'CUSTOMER.CARGO_RECEIPT.VIEW',
    'CUSTOMER.ADVISE.VIEW',
    'CUSTOMER.ADVISE.EXPORT_PDF',
    'CUSTOMER.INVOICE.VIEW',
    'CUSTOMER.INVOICE.EXPORT_PDF'
  )
ON CONFLICT ("tenant_id", "role_id", "permission_id") DO NOTHING;

-- The same for a login given My Shipments directly rather than by role.
INSERT INTO "user_permission" ("tenant_id", "user_id", "permission_id", "effect", "created_at", "updated_at")
SELECT up."tenant_id", up."user_id", p."id", up."effect", now(), now()
  FROM "user_permission" up
  JOIN "permission" sv ON sv."id" = up."permission_id" AND sv."key" = 'CUSTOMER.SHIPMENT.VIEW'
  JOIN "permission" p ON p."key" IN (
    'CUSTOMER.INQUIRY.VIEW',
    'CUSTOMER.QUOTATION.VIEW',
    'CUSTOMER.QUOTATION.EXPORT_PDF',
    'CUSTOMER.APPROVAL.VIEW',
    'CUSTOMER.SHIPPING_ORDER.VIEW',
    'CUSTOMER.SHIPPING_ORDER.EXPORT_PDF',
    'CUSTOMER.CARGO_RECEIPT.VIEW',
    'CUSTOMER.ADVISE.VIEW',
    'CUSTOMER.ADVISE.EXPORT_PDF',
    'CUSTOMER.INVOICE.VIEW',
    'CUSTOMER.INVOICE.EXPORT_PDF'
  )
 WHERE up."effect" = 'ALLOW'
ON CONFLICT ("tenant_id", "user_id", "permission_id") DO NOTHING;
