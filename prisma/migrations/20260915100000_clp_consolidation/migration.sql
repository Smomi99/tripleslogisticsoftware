-- CR-002 — a CLP belongs to many bookings (docs/CR-002-clp-consolidation.md).
--
-- Hand-written, like every other CLP migration, because `migrate diff` still
-- wants to drop a dozen indexes on unrelated tables.
--
-- ADDITIVE ON PURPOSE. This arrives after Phases A-H, against a live table
-- holding finalised plans whose printed documents have been signed on a
-- warehouse floor. So:
--
--   * clp.shipment_id is KEPT, not dropped. New code stops writing it and
--     reads participation from clp_booking instead; the column goes in a
--     later release once the new path has run in production. Until then every
--     historical row stays readable by the code that wrote it, which is what
--     a rollback needs.
--   * every existing clp is backfilled into clp_booking in this same
--     migration. A release that adds the table without the backfill leaves
--     production unable to say which booking a finalised container belongs
--     to.
--   * the backfill is idempotent (ON CONFLICT DO NOTHING), so re-running it
--     is safe.
--   * no existing row's figures are touched. consolidation_type defaults to
--     SINGLE, which is exactly what every existing plan is.
--
-- Deliberately NOT added, though CR-002 §2 describes them: pol_id, pod_id and
-- schedule_id on clp. The lane and the sailing are derivable from the
-- participating bookings, and a denormalised copy is a second version of the
-- truth that drifts. schedule_id is the rule the CR got wrong -- shipment_
-- schedule is per shipment, so two bookings on one sailing never share an id.
-- Sailing identity is shipment_schedule_leg.(vessel_id, voyage_no), computed.

-- ---------------------------------------------------------------- the types
CREATE TYPE "clp_consolidation" AS ENUM ('SINGLE', 'FCL_QUOTATION', 'LCL_CONSOLIDATION');

-- Which measurement governs an LCL charge. Stored rather than re-derived, so
-- that a row keeps the rule that was actually in force when it was billed.
CREATE TYPE "billing_basis" AS ENUM ('BOOKED', 'ACTUAL');

-- How a shared container's cost was split. MANUAL means somebody typed the
-- numbers rather than accepting a computed split.
CREATE TYPE "cost_allocation_basis" AS ENUM ('CBM', 'WEIGHT', 'MANUAL');

-- ------------------------------------------------- which bookings are in it
CREATE TABLE "clp_booking" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "clp_id" BIGINT NOT NULL,
    "shipment_id" BIGINT NOT NULL,
    "shipping_order_id" BIGINT,

    -- CR-002 §9. The split that the chosen basis produced, kept even when a
    -- supervisor overrides it, so "what would it have been" survives.
    "default_cost_amount" NUMERIC(18,4),
    "allocated_cost_amount" NUMERIC(18,4),
    "cost_overridden_by" BIGINT,
    "cost_overridden_at" TIMESTAMPTZ(6),
    "cost_override_reason" TEXT,

    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "clp_booking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clp_booking_tenant_id_clp_id_shipment_id_key"
  ON "clp_booking"("tenant_id", "clp_id", "shipment_id");
CREATE UNIQUE INDEX "clp_booking_tenant_id_id_key" ON "clp_booking"("tenant_id", "id");
CREATE INDEX "clp_booking_tenant_id_idx" ON "clp_booking"("tenant_id");
CREATE INDEX "clp_booking_clp_id_idx" ON "clp_booking"("clp_id");
CREATE INDEX "clp_booking_shipment_id_idx" ON "clp_booking"("shipment_id");

ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_tenant_id_clp_id_fkey"
  FOREIGN KEY ("tenant_id", "clp_id") REFERENCES "clp"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_tenant_id_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_tenant_id_shipping_order_id_fkey"
  FOREIGN KEY ("tenant_id", "shipping_order_id") REFERENCES "shipping_order"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_cost_overridden_by_fkey"
  FOREIGN KEY ("cost_overridden_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An override has to say who and why, the same shape as clp_override_ck.
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_override_ck" CHECK (
  ("cost_overridden_by" IS NULL AND "cost_overridden_at" IS NULL AND "cost_override_reason" IS NULL)
  OR ("cost_overridden_by" IS NOT NULL AND "cost_overridden_at" IS NOT NULL
      AND "cost_override_reason" IS NOT NULL AND btrim("cost_override_reason") <> '')
);
ALTER TABLE "clp_booking" ADD CONSTRAINT "clp_booking_cost_ck" CHECK (
  ("default_cost_amount" IS NULL OR "default_cost_amount" >= 0)
  AND ("allocated_cost_amount" IS NULL OR "allocated_cost_amount" >= 0)
);

-- ------------------------------------------------ consolidation on the plan
ALTER TABLE "clp"
  ADD COLUMN "consolidation_type" "clp_consolidation" NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN "quotation_id" BIGINT,
  -- CR-002 §8: chosen by an operator, never derived from one receipt. A
  -- booking can have three deliveries at three different CFS.
  ADD COLUMN "final_cfs_location" TEXT,
  -- §9: the ACTUAL cost of this box, typed by an operator. Not buy_price and
  -- not the sum of the quoted sells -- those are reference figures and a
  -- different number.
  ADD COLUMN "actual_container_cost" NUMERIC(18,4),
  ADD COLUMN "cost_currency_id" BIGINT,
  ADD COLUMN "cost_allocation_basis" "cost_allocation_basis";

ALTER TABLE "clp" ADD CONSTRAINT "clp_tenant_id_quotation_id_fkey"
  FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clp" ADD CONSTRAINT "clp_cost_currency_id_fkey"
  FOREIGN KEY ("cost_currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CLAUDE.md §4 rule 6: an amount never travels without its currency.
ALTER TABLE "clp" ADD CONSTRAINT "clp_cost_ck" CHECK (
  ("actual_container_cost" IS NULL AND "cost_currency_id" IS NULL)
  OR ("actual_container_cost" IS NOT NULL AND "actual_container_cost" >= 0
      AND "cost_currency_id" IS NOT NULL)
);

-- ------------------------------------------------------- numbering can move
-- A consolidated container has no position "within a booking", so clp_seq
-- stops applying to it. Existing rows keep theirs untouched.
ALTER TABLE "clp" ALTER COLUMN "clp_seq" DROP NOT NULL;
ALTER TABLE "clp" DROP CONSTRAINT IF EXISTS "clp_seq_ck";
ALTER TABLE "clp" ADD CONSTRAINT "clp_seq_ck" CHECK ("clp_seq" IS NULL OR "clp_seq" > 0);

-- The old unique index cannot hold a NULL seq meaningfully; make it partial so
-- single-booking plans keep their guarantee and consolidated ones are exempt.
DROP INDEX IF EXISTS "clp_tenant_id_shipment_id_clp_seq_key";
CREATE UNIQUE INDEX "clp_tenant_id_shipment_id_clp_seq_key"
  ON "clp"("tenant_id", "shipment_id", "clp_seq")
  WHERE "clp_seq" IS NOT NULL AND "shipment_id" IS NOT NULL;

-- --------------------------------------------- LCL: which CBM gets billed
-- Booked and actual already exist and are already separate:
--   booked  shipment_cargo_line.volume_cbm        GENERATED
--   actual  cargo_receipt_line.received_volume_cbm GENERATED from the
--           RECEIPT's own carton dimensions
-- so no measurement column is added here -- that would duplicate a generated
-- column. What is stored is the DECISION: which of the two governs the
-- charge. Kept per row so that a rule change later does not silently rewrite
-- what was billed.
ALTER TABLE "cargo_receipt_line"
  ADD COLUMN "billing_basis" "billing_basis" NOT NULL DEFAULT 'BOOKED';

COMMENT ON COLUMN "cargo_receipt_line"."billing_basis" IS
  'CR-002 §4: ACTUAL where the CFS re-measured the cartons, BOOKED otherwise. The measurements themselves live in received_volume_cbm and shipment_cargo_line.volume_cbm.';

-- Existing rows: ACTUAL wherever a measurement was in fact recorded.
UPDATE "cargo_receipt_line"
   SET "billing_basis" = 'ACTUAL'
 WHERE "received_volume_cbm" IS NOT NULL;

-- ----------------------------------------------------------- the backfill
-- Every existing plan becomes a single-booking consolidation of itself.
-- ON CONFLICT makes a re-run a no-op.
INSERT INTO "clp_booking" (
  "tenant_id", "clp_id", "shipment_id", "shipping_order_id",
  "created_at", "updated_at", "created_by", "updated_by"
)
SELECT "tenant_id", "id", "shipment_id", "shipping_order_id",
       "created_at", "updated_at", "created_by", "updated_by"
  FROM "clp"
 WHERE "shipment_id" IS NOT NULL
ON CONFLICT ("tenant_id", "clp_id", "shipment_id") DO NOTHING;

-- ------------------------------------------------------ security and audit
ALTER TABLE "clp_booking" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clp_booking"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "clp_booking" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "clp_booking_id_seq" TO ff_app;

CREATE TRIGGER clp_booking_audit
  AFTER INSERT OR UPDATE OR DELETE ON "clp_booking"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- §4 rule 10 — currency is system-capable, so the foreign key alone cannot say
-- whose row it is. Caught by tenant-isolation.test.ts, which checks every
-- tenant-owned reference to a system-capable parent has a guard.
CREATE TRIGGER clp_cost_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF cost_currency_id ON clp
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'cost_currency_id');
