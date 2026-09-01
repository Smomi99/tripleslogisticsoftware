-- MODULE_BOOKING_CARGO.md §4.1 — the shipment file, its POs and its cargo.
--
-- §2.1 is why this table is called `shipment` and not `booking`: it is where a
-- quotation becomes an operation, and eleven later modules (CLP, stuffing,
-- shipment advise, BL, finance…) will foreign-key into it. Creating a separate
-- `shipment` table later and bridging it onto `booking` would mean reconciling
-- two identities across a dozen tables.
--
-- §2.2 is why the PO is a table rather than a column on the cargo line: it is
-- the unit of approval ("Single PO can be approved / Multiple can be approved",
-- §5.3) and later the unit of part delivery. A text column could be neither.
--
-- §2.3 is why volume and chargeable weight are generated columns. Chargeable
-- weight decides what the airline bills; computed in three places it will
-- eventually disagree in three places, and the customer finds that before we do.
--
-- Staff-only for now. Portal reach (§7's PORTAL.BOOKING) lands with the screens.

-- ------------------------------------------------------------------- enums
CREATE TYPE "shipment_status" AS ENUM (
  'BOOKING_RECEIVED',
  'VESSEL_PROPOSED',
  'APPROVED_FOR_SHIPMENT',
  'REJECTED',
  'SO_ISSUED',
  'SO_SKIPPED',
  'PART_RECEIVED',
  'CARGO_RECEIVED',
  'SHORT_CLOSED',
  'CANCELLED'
);

CREATE TYPE "po_approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- ---------------------------------------------------------------- shipment
CREATE TABLE "shipment" (
  "tenant_id"           BIGINT NOT NULL,
  "id"                  BIGSERIAL PRIMARY KEY,
  "code"                VARCHAR(32) NOT NULL,
  "series_year"         INTEGER NOT NULL,
  "quotation_id"        BIGINT NOT NULL,
  "shipment_type"       "shipment_type" NOT NULL,
  "customer_id"         BIGINT NOT NULL,
  "exporter_name"       TEXT,
  "exporter_address"    TEXT,
  "importer_name"       TEXT,
  "importer_address"    TEXT,
  "goods_type_id"       BIGINT,
  "place_of_receipt"    TEXT,
  "loading_type"        "loading_type",
  "tos_id"              BIGINT,
  "mode_id"             BIGINT,
  "carrier_id"          BIGINT NOT NULL,
  "pol_id"              BIGINT NOT NULL,
  "pod_id"              BIGINT NOT NULL,
  "etd"                 DATE,
  "eta"                 DATE,
  "goods_handover_date" DATE,
  "transit_type"        "transit_type",
  "warehouse_cfs"       TEXT,
  "status"              "shipment_status" NOT NULL DEFAULT 'BOOKING_RECEIVED',
  "submitted_by"        BIGINT,
  "submitted_at"        TIMESTAMPTZ(6),
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  "created_by"          BIGINT,
  "updated_by"          BIGINT,
  "deleted_at"          TIMESTAMPTZ(6),

  -- A shipment that arrives before it leaves is a typo, not a schedule.
  CONSTRAINT "shipment_etd_eta_ck" CHECK ("eta" IS NULL OR "etd" IS NULL OR "eta" >= "etd"),
  -- §7 splits CREATE from SUBMIT, so the two submission columns move together
  -- or the record cannot say who submitted it.
  CONSTRAINT "shipment_submitted_ck"
    CHECK (("submitted_at" IS NULL) = ("submitted_by" IS NULL))
);

ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- §5.2 rule 1: deliberately NOT unique. One quotation with several exporters
-- yields several bookings.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_quotation_id_fkey"
  FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_customer_id_fkey"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_submitted_by_fkey"
  FOREIGN KEY ("submitted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Port, carrier, goods type, TOS and mode are system-capable (§7A rule 7): a
-- shared row carries tenant_id NULL, so a composite FK cannot express the
-- relationship. The trigger is the same-tenant guard instead.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_pol_id_fkey"
  FOREIGN KEY ("pol_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_pol_id_tenant_guard" BEFORE INSERT OR UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pol_id');
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_pod_id_fkey"
  FOREIGN KEY ("pod_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_pod_id_tenant_guard" BEFORE INSERT OR UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pod_id');
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_carrier_id_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_carrier_id_tenant_guard" BEFORE INSERT OR UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_goods_type_id_fkey"
  FOREIGN KEY ("goods_type_id") REFERENCES "goods_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_goods_type_id_tenant_guard" BEFORE INSERT OR UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('goods_type', 'goods_type_id');
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tos_id_fkey"
  FOREIGN KEY ("tos_id") REFERENCES "tos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_tos_id_tenant_guard" BEFORE INSERT OR UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('tos', 'tos_id');
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_mode_id_fkey"
  FOREIGN KEY ("mode_id") REFERENCES "mode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_mode_id_tenant_guard" BEFORE INSERT OR UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('mode', 'mode_id');

CREATE UNIQUE INDEX "shipment_tenant_id_id_key" ON "shipment" ("tenant_id", "id");
-- Partial on deleted_at: soft delete means a retired booking would otherwise
-- hold its number against the one replacing it (the bug
-- 20260830090000_local_charge_ignores_retired had to undo).
CREATE UNIQUE INDEX "shipment_tenant_id_code_key"
  ON "shipment" ("tenant_id", "code") WHERE "deleted_at" IS NULL;
CREATE INDEX "shipment_tenant_id_idx" ON "shipment" ("tenant_id");
CREATE INDEX "shipment_tenant_id_status_idx" ON "shipment" ("tenant_id", "status");
CREATE INDEX "shipment_tenant_id_quotation_id_idx" ON "shipment" ("tenant_id", "quotation_id");
CREATE INDEX "shipment_customer_id_idx" ON "shipment" ("customer_id");
CREATE INDEX "shipment_carrier_id_idx" ON "shipment" ("carrier_id");
-- §6.2's Search box runs over the booking number.
CREATE INDEX "shipment_code_trgm_idx" ON "shipment" USING GIN (
  to_tsvector('simple', "code")
);

-- ------------------------------------------------------- shipment_commodity
CREATE TABLE "shipment_commodity" (
  "tenant_id"         BIGINT NOT NULL,
  "id"                BIGSERIAL PRIMARY KEY,
  "shipment_id"       BIGINT NOT NULL,
  "commodity_item_id" BIGINT NOT NULL,
  "hs_code"           VARCHAR(50),
  "is_active"         BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE "shipment_commodity" ADD CONSTRAINT "shipment_commodity_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_commodity" ADD CONSTRAINT "shipment_commodity_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_commodity" ADD CONSTRAINT "shipment_commodity_commodity_item_id_fkey"
  FOREIGN KEY ("tenant_id", "commodity_item_id") REFERENCES "commodity_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "shipment_commodity_tenant_id_id_key" ON "shipment_commodity" ("tenant_id", "id");
CREATE UNIQUE INDEX "shipment_commodity_unique_key"
  ON "shipment_commodity" ("tenant_id", "shipment_id", "commodity_item_id");
CREATE INDEX "shipment_commodity_tenant_id_idx" ON "shipment_commodity" ("tenant_id");
CREATE INDEX "shipment_commodity_shipment_id_idx" ON "shipment_commodity" ("shipment_id");

-- -------------------------------------------------------------- shipment_po
CREATE TABLE "shipment_po" (
  "tenant_id"          BIGINT NOT NULL,
  "id"                 BIGSERIAL PRIMARY KEY,
  "shipment_id"        BIGINT NOT NULL,
  "po_no"              VARCHAR(100) NOT NULL,
  "approval_status"    "po_approval_status" NOT NULL DEFAULT 'PENDING',
  "approved_by"        BIGINT,
  "approved_at"        TIMESTAMPTZ(6),
  "rejection_comments" TEXT,
  "is_active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,
  "created_by"         BIGINT,
  "updated_by"         BIGINT,
  "deleted_at"         TIMESTAMPTZ(6),

  -- §5.3: "Rejection requires a comment, shown back to the C/S team." The rule
  -- lives here as well as in the route, because a PO rejected with no reason is
  -- a decision the customer cannot act on and the C/S team cannot answer.
  CONSTRAINT "shipment_po_rejection_ck"
    CHECK ("approval_status" <> 'REJECTED'
           OR ("rejection_comments" IS NOT NULL AND btrim("rejection_comments") <> '')),
  -- A decision has a decider and a time, or it has neither.
  CONSTRAINT "shipment_po_decision_ck"
    CHECK ("approval_status" = 'PENDING'
           OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL))
);

ALTER TABLE "shipment_po" ADD CONSTRAINT "shipment_po_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_po" ADD CONSTRAINT "shipment_po_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_po" ADD CONSTRAINT "shipment_po_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_po" ADD CONSTRAINT "shipment_po_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_po" ADD CONSTRAINT "shipment_po_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "shipment_po_tenant_id_id_key" ON "shipment_po" ("tenant_id", "id");
-- §4.1 asks for UNIQUE(tenant_id, shipment_id, po_no). Partial on deleted_at,
-- for the same reason the shipment code index is: a PO removed by mistake must
-- not hold its own number hostage.
CREATE UNIQUE INDEX "shipment_po_unique_key"
  ON "shipment_po" ("tenant_id", "shipment_id", "po_no") WHERE "deleted_at" IS NULL;
CREATE INDEX "shipment_po_tenant_id_idx" ON "shipment_po" ("tenant_id");
CREATE INDEX "shipment_po_shipment_id_idx" ON "shipment_po" ("shipment_id");
CREATE INDEX "shipment_po_approval_status_idx" ON "shipment_po" ("approval_status");

-- ------------------------------------------------------ shipment_cargo_line
CREATE TABLE "shipment_cargo_line" (
  "tenant_id"        BIGINT NOT NULL,
  "id"               BIGSERIAL PRIMARY KEY,
  "shipment_id"      BIGINT NOT NULL,
  "shipment_po_id"   BIGINT NOT NULL,
  "item_code"        VARCHAR(100) NOT NULL,
  "sku"              VARCHAR(100),
  -- §2.4: the BOOKED quantity. Never overwritten by what the shipping order
  -- authorised or by what arrived — those are so_ctn_qty below and
  -- cargo_receipt_line later, and the gap between the three is the business.
  "ctn_qty"          INTEGER NOT NULL,
  "pcs_qty"          INTEGER,
  "net_weight_kg"    NUMERIC(18,3),
  "gross_weight_kg"  NUMERIC(18,3),
  -- CENTIMETRES, confirmed by the client on 2026-09-02 (§9 Q2). The unit is in
  -- the column name on purpose: it is the one number that, read in the wrong
  -- unit, is wrong by a factor of a million.
  "carton_length_cm" NUMERIC(10,3),
  "carton_width_cm"  NUMERIC(10,3),
  "carton_height_cm" NUMERIC(10,3),
  -- The client's "DC" column. Free text until they say what it means
  -- (MODULE_BOOKING_CARGO.md §9 Q1, still open).
  "dc"               TEXT,
  "so_ctn_qty"       INTEGER,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  "created_by"       BIGINT,
  "updated_by"       BIGINT,
  "deleted_at"       TIMESTAMPTZ(6),

  -- Quantities and measurements are counts of real things.
  CONSTRAINT "shipment_cargo_line_ctn_qty_ck" CHECK ("ctn_qty" > 0),
  CONSTRAINT "shipment_cargo_line_pcs_qty_ck" CHECK ("pcs_qty" IS NULL OR "pcs_qty" > 0),
  CONSTRAINT "shipment_cargo_line_so_ctn_qty_ck"
    CHECK ("so_ctn_qty" IS NULL OR "so_ctn_qty" >= 0),
  CONSTRAINT "shipment_cargo_line_weight_ck"
    CHECK (("net_weight_kg" IS NULL OR "net_weight_kg" >= 0)
       AND ("gross_weight_kg" IS NULL OR "gross_weight_kg" >= 0)),
  -- A zero dimension silently zeroes the CBM and therefore the chargeable
  -- weight, which is the quiet version of the error §2.3 is about.
  CONSTRAINT "shipment_cargo_line_carton_ck"
    CHECK (("carton_length_cm" IS NULL OR "carton_length_cm" > 0)
       AND ("carton_width_cm"  IS NULL OR "carton_width_cm"  > 0)
       AND ("carton_height_cm" IS NULL OR "carton_height_cm" > 0))
);

ALTER TABLE "shipment_cargo_line" ADD CONSTRAINT "shipment_cargo_line_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_cargo_line" ADD CONSTRAINT "shipment_cargo_line_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_cargo_line" ADD CONSTRAINT "shipment_cargo_line_shipment_po_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_po_id") REFERENCES "shipment_po"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_cargo_line" ADD CONSTRAINT "shipment_cargo_line_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_cargo_line" ADD CONSTRAINT "shipment_cargo_line_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "shipment_cargo_line_tenant_id_id_key" ON "shipment_cargo_line" ("tenant_id", "id");
CREATE INDEX "shipment_cargo_line_tenant_id_idx" ON "shipment_cargo_line" ("tenant_id");
CREATE INDEX "shipment_cargo_line_shipment_id_idx" ON "shipment_cargo_line" ("shipment_id");
CREATE INDEX "shipment_cargo_line_shipment_po_id_idx" ON "shipment_cargo_line" ("shipment_po_id");

-- ------------------------------------------------------ the §2.3 arithmetic
-- Prisma emits these as ordinary columns (@default(dbgenerated())); replace
-- them with real generated ones, the way employee_salary.gross_salary is done,
-- so that no code path can ever write an inconsistent figure.
--
--   volume_cbm       = (L * W * H * ctn_qty) / 1000000        cm³ → m³
--   chargeable_wt_kg = GREATEST(gross_weight_kg, volume_cbm * 167)      IATA
--
-- Two details that are not obvious and are load-bearing:
--
--  * chargeable_wt_kg repeats the volume expression instead of referencing
--    volume_cbm, because Postgres forbids a generated column from reading
--    another generated column. It repeats it ROUNDED to the same 4 decimals
--    volume_cbm stores — at full precision the two disagreed in the last
--    decimals, and a chargeable weight an operator cannot reproduce from the
--    CBM on the same row is exactly the disagreement §2.3 is written against.
--
--  * GREATEST ignores NULLs in Postgres. So a line weighed but not measured
--    still bills its weight, and one measured but not weighed still bills its
--    volumetric figure, rather than both collapsing to NULL.
--
-- Computed on sea lines too; §2.3 says only the Air screens display it.
ALTER TABLE "shipment_cargo_line" DROP COLUMN IF EXISTS "volume_cbm";
ALTER TABLE "shipment_cargo_line" ADD COLUMN "volume_cbm" NUMERIC(18,4)
  GENERATED ALWAYS AS (
    ("carton_length_cm" * "carton_width_cm" * "carton_height_cm" * "ctn_qty") / 1000000
  ) STORED;

ALTER TABLE "shipment_cargo_line" DROP COLUMN IF EXISTS "chargeable_wt_kg";
ALTER TABLE "shipment_cargo_line" ADD COLUMN "chargeable_wt_kg" NUMERIC(18,3)
  GENERATED ALWAYS AS (
    GREATEST(
      "gross_weight_kg",
      round(
        ("carton_length_cm" * "carton_width_cm" * "carton_height_cm" * "ctn_qty") / 1000000,
        4
      ) * 167
    )
  ) STORED;

-- ------------------------------------------------------------------ tenancy
-- Staff-only, all four. `app_current_agent() IS NULL` is what keeps an agent
-- out: §7 says an agent never sees the customer's identity, and a shipment row
-- carries the customer, the exporter and the importer together.
-- PORTAL.BOOKING reach for customer users lands with the screens that need it.
ALTER TABLE "shipment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "shipment_commodity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment_commodity"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "shipment_po" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment_po"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "shipment_cargo_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment_cargo_line"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

-- The Phase 2 ALTER DEFAULT PRIVILEGES already granted SELECT, INSERT and
-- UPDATE on every table created since, so these add nothing and are here for
-- the reader. What does bite is DELETE: §4 rule 3 is soft delete only, and no
-- grant of it exists anywhere.
GRANT SELECT, INSERT, UPDATE ON TABLE "shipment" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "shipment_commodity" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_commodity_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "shipment_po" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_po_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "shipment_cargo_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_cargo_line_id_seq" TO ff_app;

-- -------------------------------------------------------------------- audit
-- §4 rule 7. §5.1 also requires it by name: "every transition writes to
-- audit_log with actor and timestamp", and the status column lives here.
CREATE TRIGGER "shipment_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "shipment_commodity_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment_commodity"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "shipment_po_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment_po"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "shipment_cargo_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment_cargo_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
