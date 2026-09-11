-- Business Port on Commodity Category, and whole-number purchase prices.
--
-- Written by hand rather than from `migrate diff`, which wanted to drop a
-- dozen indexes on unrelated tables and strip defaults off updated_at across
-- the schema. That is pre-existing drift between schema.prisma and the live
-- database; carrying it along on an unrelated feature — into production — is
-- how an afternoon's change takes a site down. Only the two things asked for
-- are here.

-- --------------------------------------------------------------- 1. lanes
-- The lanes a commodity category is traded on, as POL -> POD pairs. The rule
-- that a category fans in or fans out but never both spans rows, so no CHECK
-- can hold it and the route enforces it. What the database can hold is that
-- the same pair is never listed twice for one category.
CREATE TABLE "commodity_business_port" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "industry_sector_id" BIGINT NOT NULL,
    "pol_id" BIGINT NOT NULL,
    "pod_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "commodity_business_port_pkey" PRIMARY KEY ("id")
);

-- A port cannot be its own origin and destination.
ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_distinct_ck"
  CHECK ("pol_id" <> "pod_id");

CREATE INDEX "commodity_business_port_tenant_id_idx" ON "commodity_business_port"("tenant_id");
CREATE INDEX "commodity_business_port_industry_sector_id_idx" ON "commodity_business_port"("industry_sector_id");
CREATE INDEX "commodity_business_port_pol_id_idx" ON "commodity_business_port"("pol_id");
CREATE INDEX "commodity_business_port_pod_id_idx" ON "commodity_business_port"("pod_id");
CREATE UNIQUE INDEX "commodity_business_port_tenant_id_code_key" ON "commodity_business_port"("tenant_id", "code");
CREATE UNIQUE INDEX "commodity_business_port_tenant_id_industry_sector_id_pol_id_key"
  ON "commodity_business_port"("tenant_id", "industry_sector_id", "pol_id", "pod_id");

ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_tenant_id_industry_sector_id_fkey"
  FOREIGN KEY ("tenant_id", "industry_sector_id") REFERENCES "industry_sector"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_pol_id_fkey"
  FOREIGN KEY ("pol_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_pod_id_fkey"
  FOREIGN KEY ("pod_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_business_port" ADD CONSTRAINT "commodity_business_port_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commodity_business_port" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commodity_business_port"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "commodity_business_port" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "commodity_business_port_id_seq" TO ff_app;

CREATE TRIGGER "commodity_business_port_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "commodity_business_port"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- ------------------------------------------------- 2. whole-number prices
-- Purchase prices are round figures (client, 2026-09-12).
--
-- Buy price was already always whole — every one of the 26 lines on file is —
-- but a percentage margin turned it fractional on the way out: 24 of those 26
-- sell prices carried decimals nobody typed and nobody wanted to read. The
-- rounding belongs in the generated column rather than in a display helper,
-- so the figure that is stored, pulled onto a quotation and printed is one
-- number rather than three roundings of it.
--
-- Existing sell prices move to their rounded value. They are a price list,
-- not an issued document: a quotation snapshots its own price when the line
-- is pulled (§2.2), so nothing already quoted or sent changes.
ALTER TABLE "freight_rate_line" DROP COLUMN "sell_price";
ALTER TABLE "freight_rate_line" ADD COLUMN "sell_price" DECIMAL(18,4)
  GENERATED ALWAYS AS (
    ROUND(
      CASE WHEN "profit_type" = 'FLAT'
           THEN "buy_price" + "profit_value"
           ELSE "buy_price" * (1 + "profit_value" / 100)
      END
    )
  ) STORED;
