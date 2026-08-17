-- CreateEnum
CREATE TYPE "rate_mode" AS ENUM ('SEA_FCL', 'SEA_LCL', 'AIR');

-- CreateEnum
CREATE TYPE "rate_tier_unit" AS ENUM ('CONTAINER', 'CBM', 'KG');

-- CreateTable
CREATE TABLE "goods_type" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "goods_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_type" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "teu_factor" DECIMAL(4,2) NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "container_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_tier" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "mode" "rate_mode" NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "unit" "rate_tier_unit" NOT NULL,
    "min_value" DECIMAL(18,3),
    "max_value" DECIMAL(18,3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "container_type_id" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "rate_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tos" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_source" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inquiry_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goods_type_tenant_id_idx" ON "goods_type"("tenant_id");

-- CreateIndex
CREATE INDEX "goods_type_name_idx" ON "goods_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "goods_type_tenant_id_code_key" ON "goods_type"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "container_type_tenant_id_idx" ON "container_type"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "container_type_tenant_id_code_key" ON "container_type"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "container_type_tenant_id_id_key" ON "container_type"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "rate_tier_tenant_id_idx" ON "rate_tier"("tenant_id");

-- CreateIndex
CREATE INDEX "rate_tier_mode_sort_order_idx" ON "rate_tier"("mode", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "rate_tier_tenant_id_code_key" ON "rate_tier"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "tos_tenant_id_idx" ON "tos"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tos_tenant_id_code_key" ON "tos"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "inquiry_source_tenant_id_idx" ON "inquiry_source"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inquiry_source_tenant_id_code_key" ON "inquiry_source"("tenant_id", "code");

-- AddForeignKey
ALTER TABLE "goods_type" ADD CONSTRAINT "goods_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_type" ADD CONSTRAINT "goods_type_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_type" ADD CONSTRAINT "goods_type_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_type" ADD CONSTRAINT "container_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_type" ADD CONSTRAINT "container_type_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_type" ADD CONSTRAINT "container_type_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_tier" ADD CONSTRAINT "rate_tier_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_tier" ADD CONSTRAINT "rate_tier_container_type_id_fkey" FOREIGN KEY ("container_type_id") REFERENCES "container_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_tier" ADD CONSTRAINT "rate_tier_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_tier" ADD CONSTRAINT "rate_tier_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tos" ADD CONSTRAINT "tos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tos" ADD CONSTRAINT "tos_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tos" ADD CONSTRAINT "tos_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_source" ADD CONSTRAINT "inquiry_source_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_source" ADD CONSTRAINT "inquiry_source_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_source" ADD CONSTRAINT "inquiry_source_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
