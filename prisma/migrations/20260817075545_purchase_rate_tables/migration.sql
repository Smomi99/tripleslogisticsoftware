-- CreateEnum
CREATE TYPE "purchase_source_type" AS ENUM ('CARRIER', 'VENDOR', 'AGENT');

-- CreateEnum
CREATE TYPE "rate_status" AS ENUM ('DRAFT', 'PUBLISHED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "profit_type" AS ENUM ('FLAT', 'PERCENT');

-- CreateEnum
CREATE TYPE "charge_side" AS ENUM ('POL', 'POD');

-- CreateTable
CREATE TABLE "freight_rate" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "mode" "rate_mode" NOT NULL,
    "pol_id" BIGINT NOT NULL,
    "pod_id" BIGINT NOT NULL,
    "carrier_id" BIGINT NOT NULL,
    "goods_type_id" BIGINT NOT NULL,
    "purchase_source_type" "purchase_source_type" NOT NULL,
    "purchase_carrier_id" BIGINT,
    "purchase_vendor_id" BIGINT,
    "purchase_agent_id" BIGINT,
    "currency_id" BIGINT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "transit_days" INTEGER,
    "remarks" TEXT,
    "status" "rate_status" NOT NULL DEFAULT 'DRAFT',
    "superseded_by_id" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "freight_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freight_rate_line" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "rate_id" BIGINT NOT NULL,
    "tier_id" BIGINT NOT NULL,
    "buy_price" DECIMAL(18,4) NOT NULL,
    "profit_type" "profit_type" NOT NULL DEFAULT 'FLAT',
    "profit_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sell_price" DECIMAL(18,4),
    "min_charge" DECIMAL(18,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "freight_rate_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_local_charge" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "rate_id" BIGINT NOT NULL,
    "cost_head_id" BIGINT NOT NULL,
    "side" "charge_side" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "cost_unit_id" BIGINT,
    "remarks" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "rate_local_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_profit_log" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "rate_line_id" BIGINT NOT NULL,
    "old_profit_type" "profit_type",
    "old_profit_value" DECIMAL(18,4),
    "new_profit_type" "profit_type" NOT NULL,
    "new_profit_value" DECIMAL(18,4) NOT NULL,
    "reason" TEXT,
    "changed_by" BIGINT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_profit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "freight_rate_tenant_id_idx" ON "freight_rate"("tenant_id");

-- CreateIndex
CREATE INDEX "freight_rate_tenant_id_mode_pol_id_pod_id_valid_to_idx" ON "freight_rate"("tenant_id", "mode", "pol_id", "pod_id", "valid_to");

-- CreateIndex
CREATE INDEX "freight_rate_tenant_id_status_valid_to_idx" ON "freight_rate"("tenant_id", "status", "valid_to");

-- CreateIndex
CREATE INDEX "freight_rate_carrier_id_idx" ON "freight_rate"("carrier_id");

-- CreateIndex
CREATE INDEX "freight_rate_goods_type_id_idx" ON "freight_rate"("goods_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "freight_rate_tenant_id_code_key" ON "freight_rate"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "freight_rate_tenant_id_id_key" ON "freight_rate"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "freight_rate_line_tenant_id_idx" ON "freight_rate_line"("tenant_id");

-- CreateIndex
CREATE INDEX "freight_rate_line_rate_id_idx" ON "freight_rate_line"("rate_id");

-- CreateIndex
CREATE INDEX "freight_rate_line_tier_id_idx" ON "freight_rate_line"("tier_id");

-- CreateIndex
CREATE UNIQUE INDEX "freight_rate_line_tenant_id_rate_id_tier_id_key" ON "freight_rate_line"("tenant_id", "rate_id", "tier_id");

-- CreateIndex
CREATE UNIQUE INDEX "freight_rate_line_tenant_id_id_key" ON "freight_rate_line"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "rate_local_charge_tenant_id_idx" ON "rate_local_charge"("tenant_id");

-- CreateIndex
CREATE INDEX "rate_local_charge_rate_id_idx" ON "rate_local_charge"("rate_id");

-- CreateIndex
CREATE INDEX "rate_local_charge_cost_head_id_idx" ON "rate_local_charge"("cost_head_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_local_charge_tenant_id_rate_id_cost_head_id_side_key" ON "rate_local_charge"("tenant_id", "rate_id", "cost_head_id", "side");

-- CreateIndex
CREATE INDEX "rate_profit_log_tenant_id_idx" ON "rate_profit_log"("tenant_id");

-- CreateIndex
CREATE INDEX "rate_profit_log_rate_line_id_idx" ON "rate_profit_log"("rate_line_id");

-- CreateIndex
CREATE INDEX "rate_profit_log_changed_at_idx" ON "rate_profit_log"("changed_at");

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_pol_id_fkey" FOREIGN KEY ("pol_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_goods_type_id_fkey" FOREIGN KEY ("goods_type_id") REFERENCES "goods_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_purchase_carrier_id_fkey" FOREIGN KEY ("purchase_carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_tenant_id_purchase_vendor_id_fkey" FOREIGN KEY ("tenant_id", "purchase_vendor_id") REFERENCES "vendor"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_tenant_id_purchase_agent_id_fkey" FOREIGN KEY ("tenant_id", "purchase_agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_tenant_id_superseded_by_id_fkey" FOREIGN KEY ("tenant_id", "superseded_by_id") REFERENCES "freight_rate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate_line" ADD CONSTRAINT "freight_rate_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate_line" ADD CONSTRAINT "freight_rate_line_tenant_id_rate_id_fkey" FOREIGN KEY ("tenant_id", "rate_id") REFERENCES "freight_rate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate_line" ADD CONSTRAINT "freight_rate_line_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "rate_tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate_line" ADD CONSTRAINT "freight_rate_line_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_rate_line" ADD CONSTRAINT "freight_rate_line_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_tenant_id_rate_id_fkey" FOREIGN KEY ("tenant_id", "rate_id") REFERENCES "freight_rate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_tenant_id_cost_head_id_fkey" FOREIGN KEY ("tenant_id", "cost_head_id") REFERENCES "cost_head"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_cost_unit_id_fkey" FOREIGN KEY ("cost_unit_id") REFERENCES "cost_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_profit_log" ADD CONSTRAINT "rate_profit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_profit_log" ADD CONSTRAINT "rate_profit_log_tenant_id_rate_line_id_fkey" FOREIGN KEY ("tenant_id", "rate_line_id") REFERENCES "freight_rate_line"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_profit_log" ADD CONSTRAINT "rate_profit_log_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- APPENDIX — what the Prisma schema cannot express
--
-- Keep this block in sync when these tables change. Everything here is checked
-- by the database, not by application code, because every one of these rules
-- protects money.
-- ===========================================================================

-- -------------------------------------------------------------------------
-- 1. freight_rate_line.sell_price — GENERATED ALWAYS (module spec §4 rule 4)
-- -------------------------------------------------------------------------
-- "Sell price = buy + profit, computed by the database. Never in the
-- frontend, never in the API." Prisma emitted an ordinary column; replace it
-- with a real generated one so no code path can post an inconsistent margin.
ALTER TABLE "freight_rate_line" DROP COLUMN "sell_price";
ALTER TABLE "freight_rate_line" ADD COLUMN "sell_price" DECIMAL(18,4)
  GENERATED ALWAYS AS (
    CASE WHEN "profit_type" = 'FLAT'
         THEN "buy_price" + "profit_value"
         ELSE "buy_price" * (1 + "profit_value" / 100)
    END
  ) STORED;

-- -------------------------------------------------------------------------
-- 2. Validity window must not run backwards (module spec §3.2)
-- -------------------------------------------------------------------------
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_validity_ck"
  CHECK ("valid_to" >= "valid_from");

-- -------------------------------------------------------------------------
-- 3. "Purchase via" names exactly one master (§9 Q3)
-- -------------------------------------------------------------------------
-- The spec's polymorphic purchase_source_id cannot carry a foreign key, so
-- this is three typed columns instead. That only holds as a design if the
-- database refuses any row where the type and the populated column disagree.
ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_purchase_source_ck"
  CHECK (
    ("purchase_source_type" = 'CARRIER'
      AND "purchase_carrier_id" IS NOT NULL
      AND "purchase_vendor_id"  IS NULL
      AND "purchase_agent_id"   IS NULL)
    OR
    ("purchase_source_type" = 'VENDOR'
      AND "purchase_vendor_id"  IS NOT NULL
      AND "purchase_carrier_id" IS NULL
      AND "purchase_agent_id"   IS NULL)
    OR
    ("purchase_source_type" = 'AGENT'
      AND "purchase_agent_id"   IS NOT NULL
      AND "purchase_carrier_id" IS NULL
      AND "purchase_vendor_id"  IS NULL)
  );

-- -------------------------------------------------------------------------
-- 4. No two published rates for the same lane overlap (§4 rule 8)
-- -------------------------------------------------------------------------
-- "One active rate per (tenant, mode, pol, pod, carrier, goods type,
-- purchase source) with overlapping validity."
--
-- Scoped to PUBLISHED: several drafts for one lane are legitimate — the
-- pricing team is comparing options — and the collision is worth reporting at
-- the moment of publishing, which is exactly when this fires.
--
-- The enum columns are indexed directly rather than cast to text: casting an
-- enum is only STABLE (labels can be renamed), and an index expression must be
-- IMMUTABLE. btree_gist has handled enum types natively since Postgres 9.6.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "freight_rate" ADD CONSTRAINT "freight_rate_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "mode" WITH =,
    "pol_id" WITH =,
    "pod_id" WITH =,
    "carrier_id" WITH =,
    "goods_type_id" WITH =,
    "purchase_source_type" WITH =,
    (COALESCE("purchase_carrier_id", "purchase_vendor_id", "purchase_agent_id")) WITH =,
    daterange("valid_from", "valid_to", '[]') WITH &&
  )
  WHERE ("status" = 'PUBLISHED' AND "deleted_at" IS NULL);
