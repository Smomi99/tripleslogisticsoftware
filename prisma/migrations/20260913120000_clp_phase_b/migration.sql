-- CLP Phase B — the load plan and its allocation lines (MODULE_CLP.md §3.2).
--
-- Hand-written rather than from `migrate diff`, which wants to drop a dozen
-- indexes on unrelated tables; that is pre-existing drift and carrying it into
-- production on an unrelated feature is how an afternoon's change takes a site
-- down.
--
-- No allocation logic here. §2.1's conservation rule spans rows, so no CHECK
-- can hold it — it belongs in Phase C's allocate() under FOR UPDATE.

CREATE TYPE "clp_status" AS ENUM ('DRAFT', 'FINAL', 'CANCELLED');

-- ------------------------------------------------------------------ the plan
CREATE TABLE "clp" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "series_year" INTEGER NOT NULL,
    "clp_seq" INTEGER NOT NULL,

    "shipment_id" BIGINT NOT NULL,
    "shipping_order_id" BIGINT,
    "container_size_id" BIGINT NOT NULL,
    "carrier_id" BIGINT NOT NULL,

    "container_no" TEXT,
    "seal_no" TEXT,
    "load_datetime" TIMESTAMPTZ(6),
    "loaded_by" TEXT,

    "supervisor_employee_id" BIGINT,
    "tally_man_name" TEXT,

    "status" "clp_status" NOT NULL DEFAULT 'DRAFT',
    "finalised_by" BIGINT,
    "finalised_at" TIMESTAMPTZ(6),
    "cancelled_by" BIGINT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,

    "capacity_override_by" BIGINT,
    "capacity_override_reason" TEXT,

    "stuffing_started_at" TIMESTAMPTZ(6),

    "total_ctn_qty" INTEGER NOT NULL DEFAULT 0,
    "total_pcs_qty" INTEGER,
    "total_net_weight_kg" NUMERIC(18,3),
    "total_gross_weight_kg" NUMERIC(18,3),
    "total_volume_cbm" NUMERIC(18,4),
    "volume_utilisation" NUMERIC(5,4),
    "weight_utilisation" NUMERIC(5,4),

    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "clp_pkey" PRIMARY KEY ("id")
);

COMMENT ON COLUMN "clp"."clp_seq" IS 'MODULE_CLP.md §4.5 — "CLP No : 1" within the shipment. Not the document number; that is code.';
COMMENT ON COLUMN "clp"."stuffing_started_at" IS '§4.3 — a FINAL plan cannot be cancelled once stuffing has begun. Set by the Stuffing module.';
COMMENT ON COLUMN "clp"."is_active" IS '§4 rule 2 convention only. The CLP lifecycle is status; nothing toggles this.';

-- A container is the first, second, third of its shipment — never the zeroth.
ALTER TABLE "clp" ADD CONSTRAINT "clp_seq_ck" CHECK ("clp_seq" > 0);

-- §4.3's gate, in the database. A finalised plan with no container number is a
-- page the warehouse cannot work to, and there is no edit path back.
ALTER TABLE "clp" ADD CONSTRAINT "clp_final_ck" CHECK (
  "status" <> 'FINAL' OR (
    "container_no" IS NOT NULL AND btrim("container_no") <> ''
    AND "seal_no" IS NOT NULL AND btrim("seal_no") <> ''
    AND "load_datetime" IS NOT NULL
    AND "finalised_at" IS NOT NULL
    AND "finalised_by" IS NOT NULL
  )
);

-- Confirmed 2026-09-13: every cancellation carries a reason, not only one from
-- FINAL. The row cannot say what it was before, and a cancelled container plan
-- with no reason is a gap nobody can close later.
ALTER TABLE "clp" ADD CONSTRAINT "clp_cancel_ck" CHECK (
  "status" <> 'CANCELLED' OR (
    "cancelled_at" IS NOT NULL
    AND "cancelled_by" IS NOT NULL
    AND "cancel_reason" IS NOT NULL AND btrim("cancel_reason") <> ''
  )
);

-- §4.2: an override is a person and a reason, or it is neither.
ALTER TABLE "clp" ADD CONSTRAINT "clp_override_ck" CHECK (
  ("capacity_override_by" IS NULL AND "capacity_override_reason" IS NULL)
  OR ("capacity_override_by" IS NOT NULL
      AND "capacity_override_reason" IS NOT NULL
      AND btrim("capacity_override_reason") <> '')
);

ALTER TABLE "clp" ADD CONSTRAINT "clp_totals_ck" CHECK (
  "total_ctn_qty" >= 0
  AND ("total_pcs_qty" IS NULL OR "total_pcs_qty" >= 0)
  AND ("total_net_weight_kg" IS NULL OR "total_net_weight_kg" >= 0)
  AND ("total_gross_weight_kg" IS NULL OR "total_gross_weight_kg" >= 0)
  AND ("total_volume_cbm" IS NULL OR "total_volume_cbm" >= 0)
  AND ("volume_utilisation" IS NULL OR "volume_utilisation" >= 0)
  AND ("weight_utilisation" IS NULL OR "weight_utilisation" >= 0)
);

CREATE UNIQUE INDEX "clp_tenant_id_code_key" ON "clp"("tenant_id", "code");
CREATE UNIQUE INDEX "clp_tenant_id_id_key" ON "clp"("tenant_id", "id");
-- One sequence number per shipment, across every status: a cancelled plan
-- keeps its number and the replacement takes the next one (§4.3).
CREATE UNIQUE INDEX "clp_tenant_id_shipment_id_clp_seq_key" ON "clp"("tenant_id", "shipment_id", "clp_seq");
CREATE INDEX "clp_tenant_id_idx" ON "clp"("tenant_id");
CREATE INDEX "clp_tenant_id_shipment_id_status_idx" ON "clp"("tenant_id", "shipment_id", "status");
CREATE INDEX "clp_container_size_id_idx" ON "clp"("container_size_id");
CREATE INDEX "clp_carrier_id_idx" ON "clp"("carrier_id");

-- Tenant-owned parents get composite FKs (§4 rule 10); system-capable ones
-- cannot, because their tenant_id may be NULL, and get the guard below.
ALTER TABLE "clp" ADD CONSTRAINT "clp_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_tenant_id_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_tenant_id_shipping_order_id_fkey"
  FOREIGN KEY ("tenant_id", "shipping_order_id") REFERENCES "shipping_order"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_tenant_id_supervisor_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "supervisor_employee_id") REFERENCES "employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_container_size_id_fkey"
  FOREIGN KEY ("container_size_id") REFERENCES "container_size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_carrier_id_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_finalised_by_fkey"
  FOREIGN KEY ("finalised_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_cancelled_by_fkey"
  FOREIGN KEY ("cancelled_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_capacity_override_by_fkey"
  FOREIGN KEY ("capacity_override_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------- the allocations
CREATE TABLE "clp_line" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "clp_id" BIGINT NOT NULL,

    "shipment_cargo_line_id" BIGINT NOT NULL,
    "shipment_po_id" BIGINT NOT NULL,

    "po_no" TEXT NOT NULL,
    "item_code" TEXT NOT NULL,
    "sku" TEXT,
    "carton_length_cm" NUMERIC(10,3),
    "carton_width_cm" NUMERIC(10,3),
    "carton_height_cm" NUMERIC(10,3),

    "ctn_qty" INTEGER NOT NULL,
    "pcs_qty" INTEGER,
    "net_weight_kg" NUMERIC(18,3),
    "gross_weight_kg" NUMERIC(18,3),
    "volume_cbm" NUMERIC(18,4),

    "is_split" BOOLEAN NOT NULL DEFAULT false,
    "is_final_allocation" BOOLEAN NOT NULL DEFAULT false,

    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "clp_line_pkey" PRIMARY KEY ("id")
);

COMMENT ON COLUMN "clp_line"."ctn_qty" IS 'MODULE_CLP.md §2.3 — the only quantity a user types. The rest is calculated.';
COMMENT ON COLUMN "clp_line"."is_final_allocation" IS '§2.3 — carries the rounding remainder so the parts of a line sum back to the whole.';
COMMENT ON COLUMN "clp_line"."carton_length_cm" IS 'Snapshot in CENTIMETRES for the printed document; the cargo line may change after FINAL.';

-- Allocating nothing is not an allocation. §3.2 states it and the conservation
-- rule in Phase C depends on it: a zero row would occupy the unique index
-- below and block the real allocation.
ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_ctn_qty_ck" CHECK ("ctn_qty" > 0);

ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_measure_ck" CHECK (
  ("pcs_qty" IS NULL OR "pcs_qty" >= 0)
  AND ("net_weight_kg" IS NULL OR "net_weight_kg" >= 0)
  AND ("gross_weight_kg" IS NULL OR "gross_weight_kg" >= 0)
  AND ("volume_cbm" IS NULL OR "volume_cbm" >= 0)
);

ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_carton_ck" CHECK (
  ("carton_length_cm" IS NULL OR "carton_length_cm" > 0)
  AND ("carton_width_cm" IS NULL OR "carton_width_cm" > 0)
  AND ("carton_height_cm" IS NULL OR "carton_height_cm" > 0)
);

CREATE UNIQUE INDEX "clp_line_tenant_id_id_key" ON "clp_line"("tenant_id", "id");
-- One row per cargo line per container. Two allocations of the same line into
-- the same box is one allocation with a bigger number.
CREATE UNIQUE INDEX "clp_line_tenant_id_clp_id_cargo_line_key"
  ON "clp_line"("tenant_id", "clp_id", "shipment_cargo_line_id");
CREATE INDEX "clp_line_tenant_id_idx" ON "clp_line"("tenant_id");
CREATE INDEX "clp_line_clp_id_idx" ON "clp_line"("clp_id");
CREATE INDEX "clp_line_shipment_cargo_line_id_idx" ON "clp_line"("shipment_cargo_line_id");
CREATE INDEX "clp_line_shipment_po_id_idx" ON "clp_line"("shipment_po_id");

ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_tenant_id_clp_id_fkey"
  FOREIGN KEY ("tenant_id", "clp_id") REFERENCES "clp"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_tenant_id_cargo_line_fkey"
  FOREIGN KEY ("tenant_id", "shipment_cargo_line_id") REFERENCES "shipment_cargo_line"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_tenant_id_shipment_po_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_po_id") REFERENCES "shipment_po"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_line" ADD CONSTRAINT "clp_line_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------ tenancy
ALTER TABLE "clp" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clp"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "clp_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clp_line"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "clp" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "clp_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "clp_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "clp_line_id_seq" TO ff_app;

CREATE TRIGGER "clp_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "clp"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "clp_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "clp_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- §4 rule 10. container_size and carrier are system-capable, so the foreign
-- key alone cannot say whose row it is — a plain FK would accept another
-- workspace's private container size quite happily.
CREATE TRIGGER clp_container_size_id_tenant_guard
  BEFORE INSERT OR UPDATE OF container_size_id ON clp
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');
CREATE TRIGGER clp_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON clp
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
