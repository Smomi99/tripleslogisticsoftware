-- CLP Phase A — container capacity, and the per-carton unit values.
--
-- Hand-written rather than from `migrate diff`, which wants to drop a dozen
-- indexes on unrelated tables and strip defaults across the schema. That is
-- pre-existing drift between schema.prisma and the live database; carrying it
-- into production on an unrelated feature is how an afternoon's change takes a
-- site down.

-- ------------------------------------------------------ 1. what a box holds
-- MODULE_CLP.md §3.1. The CLP refuses a plan that goes over either limit, so
-- these are the numbers that decide whether cargo physically fits.
--
-- Nullable, not NOT NULL. The four seeded sizes are filled in below, but a
-- workspace may have added its own size before this column existed, and a
-- NOT NULL column would fail the migration on a row that cannot be seen from
-- here. §4.2 reads a missing limit as "capacity not set" and says so, rather
-- than treating it as unlimited.
ALTER TABLE "container_size"
  ADD COLUMN "max_volume_cbm" NUMERIC(10,2),
  ADD COLUMN "max_weight_kg"  NUMERIC(12,2),
  ADD COLUMN "tare_weight_kg" NUMERIC(12,2);

COMMENT ON COLUMN "container_size"."max_volume_cbm" IS 'MODULE_CLP.md §3.1 — volume the box holds; the CLP blocks above this.';
COMMENT ON COLUMN "container_size"."max_weight_kg" IS 'MODULE_CLP.md §3.1 — payload limit; over this is a port safety matter.';
COMMENT ON COLUMN "container_size"."tare_weight_kg" IS 'The empty container''s own weight. Not seeded — no values supplied.';

-- The client's table. Applied by code so a workspace's own sizes are untouched
-- and the shared rows are filled wherever this migration runs.
UPDATE "container_size" SET "max_volume_cbm" = 28, "max_weight_kg" = 26000
  WHERE "code" = '20STD' AND "max_volume_cbm" IS NULL AND "deleted_at" IS NULL;
UPDATE "container_size" SET "max_volume_cbm" = 65, "max_weight_kg" = 26000
  WHERE "code" = '40STD' AND "max_volume_cbm" IS NULL AND "deleted_at" IS NULL;
UPDATE "container_size" SET "max_volume_cbm" = 72, "max_weight_kg" = 26000
  WHERE "code" = '40HC'  AND "max_volume_cbm" IS NULL AND "deleted_at" IS NULL;
UPDATE "container_size" SET "max_volume_cbm" = 80, "max_weight_kg" = 30000
  WHERE "code" = '45FT'  AND "max_volume_cbm" IS NULL AND "deleted_at" IS NULL;

-- ----------------------------------------------- 2. what one carton weighs
-- MODULE_CLP.md §2.3, a change request against MODULE_BOOKING_CARGO.md §4.1.
--
-- The CLP splits cargo by the carton and calculates everything else from it,
-- so a split is exact by construction rather than by ratio arithmetic in
-- application code. Six decimals because the client's own PO-003 is 5,000
-- pieces across 300 cartons — 16.666667 — and the module's remainder rule
-- needs the parts to sum back to the whole.
--
-- Booking data entry does not change: the user still types totals and these
-- derive from them.
ALTER TABLE "shipment_cargo_line"
  ADD COLUMN "pcs_per_carton" NUMERIC(18,6)
    GENERATED ALWAYS AS ("pcs_qty"::numeric / NULLIF("ctn_qty", 0)::numeric) STORED,
  ADD COLUMN "net_weight_per_carton" NUMERIC(18,6)
    GENERATED ALWAYS AS ("net_weight_kg" / NULLIF("ctn_qty", 0)::numeric) STORED,
  ADD COLUMN "gross_weight_per_carton" NUMERIC(18,6)
    GENERATED ALWAYS AS ("gross_weight_kg" / NULLIF("ctn_qty", 0)::numeric) STORED;

-- Not volume_cbm / ctn_qty, which the spec writes and Postgres refuses:
-- "a generated column cannot reference another generated column". This is the
-- carton's own volume, which is the same number — volume_cbm is exactly this
-- multiplied by the carton count. chargeable_wt_kg on this table already works
-- around the identical restriction by repeating its source expression.
ALTER TABLE "shipment_cargo_line"
  ADD COLUMN "cbm_per_carton" NUMERIC(18,6)
    GENERATED ALWAYS AS (
      ("carton_length_cm" * "carton_width_cm" * "carton_height_cm") / 1000000
    ) STORED;

COMMENT ON COLUMN "shipment_cargo_line"."cbm_per_carton" IS
  'One carton''s volume. volume_cbm is this times ctn_qty; expressed directly because a generated column cannot read another.';
