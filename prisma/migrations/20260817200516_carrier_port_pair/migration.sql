-- CreateEnum
CREATE TYPE "RankSource" AS ENUM ('MANUAL', 'CALCULATED');

-- CreateTable
CREATE TABLE "carrier_port_pair" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "carrier_id" BIGINT NOT NULL,
    "pol_id" BIGINT NOT NULL,
    "pod_id" BIGINT NOT NULL,
    "low_price_position" DECIMAL(5,2),
    "service_position" DECIMAL(5,2),
    "rank_source" "RankSource" NOT NULL DEFAULT 'MANUAL',
    "remarks" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "carrier_port_pair_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carrier_port_pair_tenant_id_idx" ON "carrier_port_pair"("tenant_id");

-- CreateIndex
CREATE INDEX "carrier_port_pair_tenant_id_pol_id_pod_id_idx" ON "carrier_port_pair"("tenant_id", "pol_id", "pod_id");

-- CreateIndex
CREATE INDEX "carrier_port_pair_tenant_id_carrier_id_idx" ON "carrier_port_pair"("tenant_id", "carrier_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_port_pair_tenant_id_code_key" ON "carrier_port_pair"("tenant_id", "code");

-- AddForeignKey
ALTER TABLE "carrier_port_pair" ADD CONSTRAINT "carrier_port_pair_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_port_pair" ADD CONSTRAINT "carrier_port_pair_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_port_pair" ADD CONSTRAINT "carrier_port_pair_pol_id_fkey" FOREIGN KEY ("pol_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_port_pair" ADD CONSTRAINT "carrier_port_pair_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_port_pair" ADD CONSTRAINT "carrier_port_pair_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_port_pair" ADD CONSTRAINT "carrier_port_pair_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CR-001 §3 constraints Prisma cannot express in schema.prisma.
--
-- Both are invisible to `migrate diff`, which is why they survive rather than
-- being dropped by the next generated migration: Prisma models neither CHECK
-- constraints nor partial indexes, so it never proposes removing them. The same
-- appendix pattern carries freight_rate's overlap exclusion.
-- ---------------------------------------------------------------------------

-- A lane from a port to itself is not a lane. Validated client-side too, but
-- the database is what makes it true.
ALTER TABLE "carrier_port_pair"
  ADD CONSTRAINT "carrier_port_pair_pol_not_pod" CHECK ("pol_id" <> "pod_id");

-- One live pair per carrier per lane (CR-001 §4 rule 3). Partial, because a
-- soft-deleted row keeps its carrier and lane and would otherwise block the
-- workspace from ever recording that lane again — §4 rule 3 forbids the
-- hard delete that would clear it.
CREATE UNIQUE INDEX "carrier_port_pair_lane_key"
  ON "carrier_port_pair" ("tenant_id", "carrier_id", "pol_id", "pod_id")
  WHERE "deleted_at" IS NULL;
