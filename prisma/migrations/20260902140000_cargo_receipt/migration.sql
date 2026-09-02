-- MODULE_BOOKING_CARGO.md §4.4 — what actually arrived at the warehouse.
--
-- §2.4 is the rule that makes this table necessary rather than an update to the
-- booking: "booked quantity, shipping-order quantity, and received quantity are
-- three different numbers on the same PO line, and the gap between them is the
-- business. Never overwrite the booked figure with the received one."
--
-- §5.5 rule 4: a booking may have SEVERAL receipts over time, each numbered and
-- kept. So the receipt is a document in its own right, with a sequence, and the
-- balance is derived by summing them rather than stored anywhere.
--
-- §5.4 rule 3: shipping_order_id is nullable, because an inbound shipment
-- skipped the document entirely and its cargo still arrives.

CREATE TYPE "cargo_receipt_status" AS ENUM ('DRAFT', 'CONFIRMED');
CREATE TYPE "receipt_line_status" AS ENUM ('ACCEPTED', 'DECLINED');

CREATE TABLE "cargo_receipt" (
  "tenant_id"         BIGINT NOT NULL,
  "id"                BIGSERIAL PRIMARY KEY,
  -- CR-2026-000001, the yearly series every document here uses.
  "code"              VARCHAR(32) NOT NULL,
  "series_year"       INTEGER NOT NULL,
  "shipment_id"       BIGINT NOT NULL,
  -- Null when the S/O was skipped (§5.4 rule 3).
  "shipping_order_id" BIGINT,
  "receive_date"      DATE NOT NULL,
  "unload_location"   TEXT,
  -- The client's own field, on their wireframe. Meaning unstated; free text.
  "efr_no"            TEXT,
  -- §5.5 rule 4: 1st, 2nd, 3rd receipt against this booking.
  "receipt_seq"       INTEGER NOT NULL,
  "status"            "cargo_receipt_status" NOT NULL DEFAULT 'DRAFT',
  "received_by"       BIGINT,
  "confirmed_at"      TIMESTAMPTZ(6),
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  "created_by"        BIGINT,
  "updated_by"        BIGINT,
  "deleted_at"        TIMESTAMPTZ(6),

  CONSTRAINT "cargo_receipt_seq_ck" CHECK ("receipt_seq" >= 1),
  -- A confirmed receipt was confirmed at a moment, by somebody.
  CONSTRAINT "cargo_receipt_confirmed_ck" CHECK (
    "status" <> 'CONFIRMED' OR ("confirmed_at" IS NOT NULL AND "received_by" IS NOT NULL)
  )
);

ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_shipping_order_id_fkey"
  FOREIGN KEY ("tenant_id", "shipping_order_id") REFERENCES "shipping_order"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_received_by_fkey"
  FOREIGN KEY ("received_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "cargo_receipt_tenant_id_id_key" ON "cargo_receipt" ("tenant_id", "id");
CREATE UNIQUE INDEX "cargo_receipt_tenant_id_code_key"
  ON "cargo_receipt" ("tenant_id", "code") WHERE "deleted_at" IS NULL;
-- §5.5 rule 4: the sequence is the receipt's identity on this booking, so two
-- cannot claim to be the second one.
CREATE UNIQUE INDEX "cargo_receipt_seq_key"
  ON "cargo_receipt" ("tenant_id", "shipment_id", "receipt_seq") WHERE "deleted_at" IS NULL;
-- Only one receipt may be open at a time. Two half-typed ones against the same
-- booking is a receiver's mistake, not a workflow.
CREATE UNIQUE INDEX "cargo_receipt_one_draft_key"
  ON "cargo_receipt" ("tenant_id", "shipment_id")
  WHERE "deleted_at" IS NULL AND "status" = 'DRAFT';
CREATE INDEX "cargo_receipt_tenant_id_idx" ON "cargo_receipt" ("tenant_id");
CREATE INDEX "cargo_receipt_shipment_id_idx" ON "cargo_receipt" ("shipment_id");
CREATE INDEX "cargo_receipt_shipping_order_id_idx" ON "cargo_receipt" ("shipping_order_id");
CREATE INDEX "cargo_receipt_status_idx" ON "cargo_receipt" ("status");

-- ------------------------------------------------------- cargo_receipt_line
CREATE TABLE "cargo_receipt_line" (
  "tenant_id"                BIGINT NOT NULL,
  "id"                       BIGSERIAL PRIMARY KEY,
  "cargo_receipt_id"         BIGINT NOT NULL,
  "shipment_cargo_line_id"   BIGINT NOT NULL,
  "received_ctn_qty"         INTEGER NOT NULL,
  "received_pcs_qty"         INTEGER,
  "received_net_weight_kg"   NUMERIC(18,3),
  "received_gross_weight_kg" NUMERIC(18,3),
  -- Re-measured at the warehouse: §5.5 rule 1 says the received figures may
  -- differ from the booked ones, and cartons are measured again on arrival.
  -- Centimetres, like the booking (§9 Q2).
  "carton_length_cm"         NUMERIC(10,3),
  "carton_width_cm"          NUMERIC(10,3),
  "carton_height_cm"         NUMERIC(10,3),
  -- §5.5 rule 2: accepted or declined one line at a time, with a reason.
  "line_status"              "receipt_line_status" NOT NULL DEFAULT 'ACCEPTED',
  "decline_reason"           TEXT,
  "remarks"                  TEXT,
  -- §5.5 rule 6: "Never let received exceed booked without an explicit override
  -- and a reason." The override is recorded on the line that used it.
  "over_receipt_reason"      TEXT,
  "is_active"                BOOLEAN NOT NULL DEFAULT true,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(6) NOT NULL,
  "created_by"               BIGINT,
  "updated_by"               BIGINT,
  "deleted_at"               TIMESTAMPTZ(6),

  CONSTRAINT "cargo_receipt_line_qty_ck" CHECK ("received_ctn_qty" >= 0),
  CONSTRAINT "cargo_receipt_line_pcs_ck"
    CHECK ("received_pcs_qty" IS NULL OR "received_pcs_qty" >= 0),
  -- §5.5 rule 2: a declined line says why. A rejection with no reason is one
  -- nobody downstream can act on, the same rule §5.3 applies to a PO.
  CONSTRAINT "cargo_receipt_line_decline_ck" CHECK (
    "line_status" <> 'DECLINED'
    OR ("decline_reason" IS NOT NULL AND btrim("decline_reason") <> '')
  ),
  CONSTRAINT "cargo_receipt_line_carton_ck" CHECK (
    ("carton_length_cm" IS NULL OR "carton_length_cm" > 0)
    AND ("carton_width_cm" IS NULL OR "carton_width_cm" > 0)
    AND ("carton_height_cm" IS NULL OR "carton_height_cm" > 0)
  )
);

ALTER TABLE "cargo_receipt_line" ADD CONSTRAINT "cargo_receipt_line_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt_line" ADD CONSTRAINT "cargo_receipt_line_cargo_receipt_id_fkey"
  FOREIGN KEY ("tenant_id", "cargo_receipt_id") REFERENCES "cargo_receipt"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt_line" ADD CONSTRAINT "cargo_receipt_line_shipment_cargo_line_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_cargo_line_id") REFERENCES "shipment_cargo_line"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt_line" ADD CONSTRAINT "cargo_receipt_line_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_receipt_line" ADD CONSTRAINT "cargo_receipt_line_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "cargo_receipt_line_tenant_id_id_key"
  ON "cargo_receipt_line" ("tenant_id", "id");
-- One row per booked line per receipt. Counting the same cargo twice on one
-- receipt is exactly the arithmetic error §8 says becomes a billing dispute.
CREATE UNIQUE INDEX "cargo_receipt_line_unique_key"
  ON "cargo_receipt_line" ("tenant_id", "cargo_receipt_id", "shipment_cargo_line_id")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "cargo_receipt_line_tenant_id_idx" ON "cargo_receipt_line" ("tenant_id");
CREATE INDEX "cargo_receipt_line_receipt_id_idx" ON "cargo_receipt_line" ("cargo_receipt_id");
CREATE INDEX "cargo_receipt_line_cargo_line_id_idx"
  ON "cargo_receipt_line" ("shipment_cargo_line_id");

-- ------------------------------------------------------- the §2.3 arithmetic
-- Prisma emits it as an ordinary column; replace it with the generated one, the
-- same expression shipment_cargo_line uses. The received volume is measured on
-- arrival and must be computed the same way the booked one was, or the two
-- columns sitting side by side on §6.7's grid would not be comparable.
ALTER TABLE "cargo_receipt_line" DROP COLUMN IF EXISTS "received_volume_cbm";
ALTER TABLE "cargo_receipt_line" ADD COLUMN "received_volume_cbm" NUMERIC(18,4)
  GENERATED ALWAYS AS (
    ("carton_length_cm" * "carton_width_cm" * "carton_height_cm" * "received_ctn_qty") / 1000000
  ) STORED;

-- ------------------------------------------------------------------ tenancy
ALTER TABLE "cargo_receipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cargo_receipt"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "cargo_receipt_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cargo_receipt_line"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "cargo_receipt" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "cargo_receipt_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "cargo_receipt_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "cargo_receipt_line_id_seq" TO ff_app;

CREATE TRIGGER "cargo_receipt_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "cargo_receipt"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "cargo_receipt_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "cargo_receipt_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
