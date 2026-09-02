-- MODULE_BOOKING_CARGO.md §4.3 — the shipping order.
--
-- §5.4 rule 2 is the rule that shapes the table: "Numbered on issue, never on
-- draft. Issuing is a one-way action; a mistake is cancelled and reissued with
-- a new number." So there is no DRAFT status and no nullable number — a row
-- exists because an S/O was issued, and correcting one means a second row.
--
-- §5.4 rule 3 is the other: inbound shipments skip the S/O entirely. A SKIPPED
-- row is still a row, because "we deliberately did not issue one, here is why"
-- is a fact the file needs to carry — and §4.4's cargo_receipt has to work with
-- a null shipping_order_id either way.

CREATE TYPE "shipping_order_status" AS ENUM ('ISSUED', 'SKIPPED', 'CANCELLED');

CREATE TABLE "shipping_order" (
  "tenant_id"        BIGINT NOT NULL,
  "id"               BIGSERIAL PRIMARY KEY,
  -- SO-2026-000001, the yearly series the booking and quotation also use.
  "code"             VARCHAR(32) NOT NULL,
  "series_year"      INTEGER NOT NULL,
  "shipment_id"      BIGINT NOT NULL,
  -- Null on a SKIPPED row: nothing was approved because nothing was proposed.
  "schedule_id"      BIGINT,
  "issue_date"       DATE,
  "issued_by"        BIGINT,
  -- §6.6 prints "First Vessel or Airlines". Snapshotted from the approved
  -- schedule's first leg rather than joined: §5.4 rule 2 makes an issued S/O a
  -- document, and a document that changes when the schedule does is not one.
  "first_vessel_id"  BIGINT,
  "first_vessel_name" TEXT,
  "first_flight_no"  TEXT,
  "cut_off"          TIMESTAMPTZ(6),
  "etd"              TIMESTAMPTZ(6),
  "eta"              TIMESTAMPTZ(6),
  "warehouse_cfs"    TEXT,
  -- §9 Q5, answered 2026-09-02: the compact offline payload, so a gate with no
  -- signal can still scan it. Stored rather than rebuilt, so the code on a
  -- printed page always matches the one the record holds.
  "qr_payload"       TEXT,
  "status"           "shipping_order_status" NOT NULL DEFAULT 'ISSUED',
  "skip_reason"      TEXT,
  "cancel_reason"    TEXT,
  "pdf_file"         TEXT,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  "created_by"       BIGINT,
  "updated_by"       BIGINT,
  "deleted_at"       TIMESTAMPTZ(6),

  -- §5.4 rule 3: a skip is a decision, and a decision with no reason is not one.
  CONSTRAINT "shipping_order_skip_ck" CHECK (
    "status" <> 'SKIPPED'
    OR ("skip_reason" IS NOT NULL AND btrim("skip_reason") <> '')
  ),
  -- Cancelling an issued document, likewise (§5.4 rule 2).
  CONSTRAINT "shipping_order_cancel_ck" CHECK (
    "status" <> 'CANCELLED'
    OR ("cancel_reason" IS NOT NULL AND btrim("cancel_reason") <> '')
  ),
  -- An issued S/O was issued by somebody, on a day. A skipped one never was.
  CONSTRAINT "shipping_order_issued_ck" CHECK (
    "status" <> 'ISSUED' OR ("issue_date" IS NOT NULL AND "issued_by" IS NOT NULL)
  ),
  CONSTRAINT "shipping_order_dates_ck"
    CHECK ("eta" IS NULL OR "etd" IS NULL OR "eta" >= "etd")
);

ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_schedule_id_fkey"
  FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "shipment_schedule"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_issued_by_fkey"
  FOREIGN KEY ("issued_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Vessel is system-capable (§7A rule 7): single column plus the guard.
ALTER TABLE "shipping_order" ADD CONSTRAINT "shipping_order_first_vessel_id_fkey"
  FOREIGN KEY ("first_vessel_id") REFERENCES "vessel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipping_order_first_vessel_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "shipping_order"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('vessel', 'first_vessel_id');

CREATE UNIQUE INDEX "shipping_order_tenant_id_id_key" ON "shipping_order" ("tenant_id", "id");
CREATE UNIQUE INDEX "shipping_order_tenant_id_code_key"
  ON "shipping_order" ("tenant_id", "code") WHERE "deleted_at" IS NULL;
-- §5.4 rule 2: one live document per booking. A cancelled one is kept forever;
-- two live ones would be two different instructions to the same warehouse.
CREATE UNIQUE INDEX "shipping_order_live_key"
  ON "shipping_order" ("tenant_id", "shipment_id")
  WHERE "deleted_at" IS NULL AND "status" IN ('ISSUED', 'SKIPPED');
CREATE INDEX "shipping_order_tenant_id_idx" ON "shipping_order" ("tenant_id");
CREATE INDEX "shipping_order_shipment_id_idx" ON "shipping_order" ("shipment_id");
CREATE INDEX "shipping_order_status_idx" ON "shipping_order" ("status");
CREATE INDEX "shipping_order_first_vessel_id_idx" ON "shipping_order" ("first_vessel_id");

-- ------------------------------------------------------------------ tenancy
ALTER TABLE "shipping_order" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipping_order"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "shipping_order" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipping_order_id_seq" TO ff_app;

CREATE TRIGGER "shipping_order_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipping_order"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
