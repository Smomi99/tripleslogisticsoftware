-- CreateEnum
CREATE TYPE "shipment_type" AS ENUM ('SEA', 'AIR');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "inquiry_status" AS ENUM ('OPEN', 'QUOTED', 'WON', 'LOST', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "volume_kind" AS ENUM ('FCL', 'LCL', 'AIR');

-- CreateEnum
CREATE TYPE "contact_mode" AS ENUM ('CALL', 'EMAIL', 'VISIT', 'WHATSAPP');

-- CreateTable
CREATE TABLE "sales_lead" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sales_lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "series_year" INTEGER NOT NULL,
    "inquiry_date" DATE NOT NULL,
    "source_id" BIGINT NOT NULL,
    "shipment_type" "shipment_type" NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "movement_type" "movement_type" NOT NULL,
    "pol_id" BIGINT NOT NULL,
    "pod_id" BIGINT NOT NULL,
    "place_of_receipt" TEXT,
    "commodity_item_id" BIGINT,
    "hs_code" VARCHAR(50),
    "tos_id" BIGINT,
    "target_price" DECIMAL(18,4),
    "currency_id" BIGINT,
    "expected_shipment_date" DATE,
    "valid_to" DATE,
    "weight_kg" DECIMAL(18,3),
    "remarks" TEXT,
    "salesman_id" BIGINT,
    "status" "inquiry_status" NOT NULL DEFAULT 'OPEN',
    "lead_id" BIGINT,
    "quoted_price" DECIMAL(18,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_volume" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "inquiry_id" BIGINT NOT NULL,
    "volume_kind" "volume_kind" NOT NULL,
    "container_type_id" BIGINT,
    "quantity" INTEGER,
    "cbm" DECIMAL(18,3),
    "weight_kg" DECIMAL(18,3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inquiry_volume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_followup" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "inquiry_id" BIGINT NOT NULL,
    "followup_date" DATE NOT NULL,
    "contact_mode" "contact_mode" NOT NULL,
    "contact_person" VARCHAR(200),
    "notes" TEXT,
    "next_followup_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inquiry_followup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_rate" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "inquiry_id" BIGINT NOT NULL,
    "rate_id" BIGINT NOT NULL,
    "rate_line_id" BIGINT NOT NULL,
    "quoted_price" DECIMAL(18,4) NOT NULL,
    "is_selected" BOOLEAN NOT NULL DEFAULT false,
    "added_by" BIGINT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inquiry_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_lead_tenant_id_idx" ON "sales_lead"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_lead_tenant_id_code_key" ON "sales_lead"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_lead_tenant_id_id_key" ON "sales_lead"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inquiry_tenant_id_idx" ON "inquiry"("tenant_id");

-- CreateIndex
CREATE INDEX "inquiry_tenant_id_status_inquiry_date_idx" ON "inquiry"("tenant_id", "status", "inquiry_date");

-- CreateIndex
CREATE INDEX "inquiry_tenant_id_salesman_id_idx" ON "inquiry"("tenant_id", "salesman_id");

-- CreateIndex
CREATE INDEX "inquiry_tenant_id_series_year_idx" ON "inquiry"("tenant_id", "series_year");

-- CreateIndex
CREATE INDEX "inquiry_customer_id_idx" ON "inquiry"("customer_id");

-- CreateIndex
CREATE INDEX "inquiry_pol_id_idx" ON "inquiry"("pol_id");

-- CreateIndex
CREATE INDEX "inquiry_pod_id_idx" ON "inquiry"("pod_id");

-- CreateIndex
CREATE UNIQUE INDEX "inquiry_tenant_id_code_key" ON "inquiry"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inquiry_tenant_id_id_key" ON "inquiry"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inquiry_volume_tenant_id_idx" ON "inquiry_volume"("tenant_id");

-- CreateIndex
CREATE INDEX "inquiry_volume_inquiry_id_idx" ON "inquiry_volume"("inquiry_id");

-- CreateIndex
CREATE INDEX "inquiry_followup_tenant_id_idx" ON "inquiry_followup"("tenant_id");

-- CreateIndex
CREATE INDEX "inquiry_followup_inquiry_id_idx" ON "inquiry_followup"("inquiry_id");

-- CreateIndex
CREATE INDEX "inquiry_followup_next_followup_date_idx" ON "inquiry_followup"("next_followup_date");

-- CreateIndex
CREATE INDEX "inquiry_rate_tenant_id_idx" ON "inquiry_rate"("tenant_id");

-- CreateIndex
CREATE INDEX "inquiry_rate_inquiry_id_idx" ON "inquiry_rate"("inquiry_id");

-- CreateIndex
CREATE INDEX "inquiry_rate_rate_id_idx" ON "inquiry_rate"("rate_id");

-- CreateIndex
CREATE UNIQUE INDEX "inquiry_rate_tenant_id_inquiry_id_rate_line_id_key" ON "inquiry_rate"("tenant_id", "inquiry_id", "rate_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "commodity_item_tenant_id_id_key" ON "commodity_item"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "sales_lead" ADD CONSTRAINT "sales_lead_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lead" ADD CONSTRAINT "sales_lead_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lead" ADD CONSTRAINT "sales_lead_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "inquiry_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_pol_id_fkey" FOREIGN KEY ("pol_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tos_id_fkey" FOREIGN KEY ("tos_id") REFERENCES "tos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tenant_id_commodity_item_id_fkey" FOREIGN KEY ("tenant_id", "commodity_item_id") REFERENCES "commodity_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tenant_id_salesman_id_fkey" FOREIGN KEY ("tenant_id", "salesman_id") REFERENCES "employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "sales_lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_volume" ADD CONSTRAINT "inquiry_volume_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_volume" ADD CONSTRAINT "inquiry_volume_tenant_id_inquiry_id_fkey" FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_volume" ADD CONSTRAINT "inquiry_volume_container_type_id_fkey" FOREIGN KEY ("container_type_id") REFERENCES "container_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_volume" ADD CONSTRAINT "inquiry_volume_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_volume" ADD CONSTRAINT "inquiry_volume_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_followup" ADD CONSTRAINT "inquiry_followup_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_followup" ADD CONSTRAINT "inquiry_followup_tenant_id_inquiry_id_fkey" FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_followup" ADD CONSTRAINT "inquiry_followup_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_followup" ADD CONSTRAINT "inquiry_followup_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_tenant_id_inquiry_id_fkey" FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_tenant_id_rate_id_fkey" FOREIGN KEY ("tenant_id", "rate_id") REFERENCES "freight_rate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_tenant_id_rate_line_id_fkey" FOREIGN KEY ("tenant_id", "rate_line_id") REFERENCES "freight_rate_line"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_rate" ADD CONSTRAINT "inquiry_rate_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
