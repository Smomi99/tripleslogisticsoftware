-- CreateEnum
CREATE TYPE "port_type" AS ENUM ('SEAPORT', 'AIRPORT');

-- CreateEnum
CREATE TYPE "cost_head_category" AS ENUM ('SERVICE', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "customer_type" AS ENUM ('IMPORTER', 'EXPORTER', 'TRADER');

-- CreateEnum
CREATE TYPE "business_area" AS ENUM ('INBOUND', 'OUTBOUND', 'BOTH');

-- CreateEnum
CREATE TYPE "agent_type" AS ENUM ('GENERAL', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "permission_effect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'PLATFORM_USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "tenant" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Dhaka',
    "currency_id" BIGINT,
    "status" "tenant_status" NOT NULL DEFAULT 'TRIAL',
    "trial_ends_at" TIMESTAMPTZ(6),
    "logo_file" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user" (
    "id" BIGSERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" BIGSERIAL NOT NULL,
    "module" VARCHAR(50) NOT NULL,
    "feature" VARCHAR(100) NOT NULL,
    "action" VARCHAR(30) NOT NULL,
    "key" VARCHAR(150) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_master_override" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "table_name" VARCHAR(63) NOT NULL,
    "record_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,

    CONSTRAINT "tenant_master_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "port" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "port_code" VARCHAR(20) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "type" "port_type" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "port_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(100) NOT NULL,
    "conversion" DECIMAL(18,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_rate_history" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "currency_rate_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_unit" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "cost_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_head" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "category" "cost_head_category" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "unit_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "cost_head_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_type" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "carrier_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type_id" BIGINT NOT NULL,
    "office_address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_pic" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "carrier_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "department" VARCHAR(100),
    "designation" VARCHAR(100),
    "tel_no" VARCHAR(50),
    "mobile_no" VARCHAR(50),
    "email" VARCHAR(255),
    "country" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "carrier_pic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_service_port" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "carrier_id" BIGINT NOT NULL,
    "port_id" BIGINT NOT NULL,
    "country" VARCHAR(100),
    "low_price_position" INTEGER,
    "service_position" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "carrier_service_port_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vessel" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "carrier_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vessel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_type" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vendor_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address" TEXT,
    "country" VARCHAR(100) NOT NULL,
    "service_description" TEXT,
    "vendor_type_id" BIGINT NOT NULL,
    "bank_details" TEXT,
    "tin_no" VARCHAR(50),
    "vat_no" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_pic" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "vendor_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "department" VARCHAR(100),
    "designation" VARCHAR(100),
    "mobile" VARCHAR(50),
    "email" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vendor_pic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industry_sector" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "industry_sector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commodity_item" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "industry_sector_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "hs_code" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "commodity_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "address" TEXT,
    "customer_type" "customer_type" NOT NULL,
    "business_area" "business_area" NOT NULL,
    "industry_sector_id" BIGINT NOT NULL,
    "ex_sea_volume_teu_month" DECIMAL(18,4),
    "ex_air_volume_kg_month" DECIMAL(18,4),
    "im_sea_volume_teu_month" DECIMAL(18,4),
    "im_air_volume_kg_month" DECIMAL(18,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_pic" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "department" VARCHAR(100),
    "designation" VARCHAR(100),
    "mobile" VARCHAR(50),
    "email" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_pic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_area" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "expert_area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network" (
    "tenant_id" BIGINT,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "network_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "address" TEXT,
    "agent_type" "agent_type" NOT NULL,
    "agreement_file" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_pic" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "department" VARCHAR(100),
    "designation" VARCHAR(100),
    "mobile" VARCHAR(50),
    "email" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_pic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_expert_area" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "expert_area_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,

    CONSTRAINT "agent_expert_area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_port_coverage" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "port_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,

    CONSTRAINT "agent_port_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_network_member" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "network_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,

    CONSTRAINT "agent_network_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "department" VARCHAR(100),
    "designation" VARCHAR(100),
    "joining_date" DATE,
    "office_mobile" VARCHAR(50),
    "personal_email" VARCHAR(255),
    "qualification" TEXT,
    "service_contract_file" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_cv" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "employee_id" BIGINT NOT NULL,
    "present_address" TEXT,
    "permanent_address" TEXT,
    "qualification" TEXT,
    "father_name" VARCHAR(200),
    "mother_name" VARCHAR(200),
    "sibling_name" VARCHAR(200),
    "sibling_mobile" VARCHAR(50),
    "date_of_birth" DATE,
    "reference_1" TEXT,
    "reference_2" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_cv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salary" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "employee_id" BIGINT NOT NULL,
    "basic_salary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "home_rent" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "medical" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "mobile_bill" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "insurance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "incentive" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "gross_salary" DECIMAL(18,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_salary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "role_id" BIGINT NOT NULL,
    "permission_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" BIGINT,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "employee_id" BIGINT,
    "username" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role_id" BIGINT,
    "is_superadmin" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permission" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "permission_id" BIGINT NOT NULL,
    "effect" "permission_effect" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,

    CONSTRAINT "user_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "table_name" VARCHAR(63) NOT NULL,
    "record_id" BIGINT NOT NULL,
    "action" "audit_action" NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL DEFAULT 'USER',
    "changed_by" BIGINT,
    "old_values" JSONB,
    "new_values" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_slug_idx" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_status_idx" ON "tenant"("status");

-- CreateIndex
CREATE INDEX "tenant_currency_id_idx" ON "tenant"("currency_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE INDEX "permission_module_idx" ON "permission"("module");

-- CreateIndex
CREATE INDEX "permission_feature_idx" ON "permission"("feature");

-- CreateIndex
CREATE INDEX "tenant_master_override_tenant_id_idx" ON "tenant_master_override"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_master_override_tenant_id_table_name_record_id_key" ON "tenant_master_override"("tenant_id", "table_name", "record_id");

-- CreateIndex
CREATE INDEX "port_tenant_id_idx" ON "port"("tenant_id");

-- CreateIndex
CREATE INDEX "port_country_idx" ON "port"("country");

-- CreateIndex
CREATE INDEX "port_type_idx" ON "port"("type");

-- CreateIndex
CREATE INDEX "port_name_idx" ON "port"("name");

-- CreateIndex
CREATE UNIQUE INDEX "port_tenant_id_code_key" ON "port"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "port_tenant_id_port_code_key" ON "port"("tenant_id", "port_code");

-- CreateIndex
CREATE INDEX "currency_tenant_id_idx" ON "currency"("tenant_id");

-- CreateIndex
CREATE INDEX "currency_currency_idx" ON "currency"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "currency_tenant_id_code_key" ON "currency"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "currency_rate_history_tenant_id_idx" ON "currency_rate_history"("tenant_id");

-- CreateIndex
CREATE INDEX "currency_rate_history_currency_id_idx" ON "currency_rate_history"("currency_id");

-- CreateIndex
CREATE INDEX "currency_rate_history_tenant_id_currency_id_effective_from_idx" ON "currency_rate_history"("tenant_id", "currency_id", "effective_from");

-- CreateIndex
CREATE INDEX "cost_unit_tenant_id_idx" ON "cost_unit"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_unit_tenant_id_code_key" ON "cost_unit"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "cost_head_tenant_id_idx" ON "cost_head"("tenant_id");

-- CreateIndex
CREATE INDEX "cost_head_unit_id_idx" ON "cost_head"("unit_id");

-- CreateIndex
CREATE INDEX "cost_head_category_idx" ON "cost_head"("category");

-- CreateIndex
CREATE INDEX "cost_head_name_idx" ON "cost_head"("name");

-- CreateIndex
CREATE UNIQUE INDEX "cost_head_tenant_id_code_key" ON "cost_head"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "cost_head_tenant_id_id_key" ON "cost_head"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "carrier_type_tenant_id_idx" ON "carrier_type"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_type_tenant_id_code_key" ON "carrier_type"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "carrier_tenant_id_idx" ON "carrier"("tenant_id");

-- CreateIndex
CREATE INDEX "carrier_type_id_idx" ON "carrier"("type_id");

-- CreateIndex
CREATE INDEX "carrier_name_idx" ON "carrier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_tenant_id_code_key" ON "carrier"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "carrier_pic_tenant_id_idx" ON "carrier_pic"("tenant_id");

-- CreateIndex
CREATE INDEX "carrier_pic_carrier_id_idx" ON "carrier_pic"("carrier_id");

-- CreateIndex
CREATE INDEX "carrier_pic_name_idx" ON "carrier_pic"("name");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_pic_tenant_id_code_key" ON "carrier_pic"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "carrier_service_port_tenant_id_idx" ON "carrier_service_port"("tenant_id");

-- CreateIndex
CREATE INDEX "carrier_service_port_carrier_id_idx" ON "carrier_service_port"("carrier_id");

-- CreateIndex
CREATE INDEX "carrier_service_port_port_id_idx" ON "carrier_service_port"("port_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_service_port_tenant_id_code_key" ON "carrier_service_port"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_service_port_tenant_id_carrier_id_port_id_key" ON "carrier_service_port"("tenant_id", "carrier_id", "port_id");

-- CreateIndex
CREATE INDEX "vessel_tenant_id_idx" ON "vessel"("tenant_id");

-- CreateIndex
CREATE INDEX "vessel_carrier_id_idx" ON "vessel"("carrier_id");

-- CreateIndex
CREATE INDEX "vessel_name_idx" ON "vessel"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vessel_tenant_id_code_key" ON "vessel"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "vendor_type_tenant_id_idx" ON "vendor_type"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_type_tenant_id_code_key" ON "vendor_type"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "vendor_tenant_id_idx" ON "vendor"("tenant_id");

-- CreateIndex
CREATE INDEX "vendor_vendor_type_id_idx" ON "vendor"("vendor_type_id");

-- CreateIndex
CREATE INDEX "vendor_name_idx" ON "vendor"("name");

-- CreateIndex
CREATE INDEX "vendor_country_idx" ON "vendor"("country");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_tenant_id_code_key" ON "vendor"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_tenant_id_id_key" ON "vendor"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "vendor_pic_tenant_id_idx" ON "vendor_pic"("tenant_id");

-- CreateIndex
CREATE INDEX "vendor_pic_vendor_id_idx" ON "vendor_pic"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_pic_name_idx" ON "vendor_pic"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_pic_tenant_id_code_key" ON "vendor_pic"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "industry_sector_tenant_id_idx" ON "industry_sector"("tenant_id");

-- CreateIndex
CREATE INDEX "industry_sector_name_idx" ON "industry_sector"("name");

-- CreateIndex
CREATE UNIQUE INDEX "industry_sector_tenant_id_code_key" ON "industry_sector"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "industry_sector_tenant_id_id_key" ON "industry_sector"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "commodity_item_tenant_id_idx" ON "commodity_item"("tenant_id");

-- CreateIndex
CREATE INDEX "commodity_item_industry_sector_id_idx" ON "commodity_item"("industry_sector_id");

-- CreateIndex
CREATE INDEX "commodity_item_name_idx" ON "commodity_item"("name");

-- CreateIndex
CREATE INDEX "commodity_item_hs_code_idx" ON "commodity_item"("hs_code");

-- CreateIndex
CREATE UNIQUE INDEX "commodity_item_tenant_id_code_key" ON "commodity_item"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "customer_tenant_id_idx" ON "customer"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_industry_sector_id_idx" ON "customer"("industry_sector_id");

-- CreateIndex
CREATE INDEX "customer_name_idx" ON "customer"("name");

-- CreateIndex
CREATE INDEX "customer_country_idx" ON "customer"("country");

-- CreateIndex
CREATE INDEX "customer_customer_type_idx" ON "customer"("customer_type");

-- CreateIndex
CREATE INDEX "customer_business_area_idx" ON "customer"("business_area");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_code_key" ON "customer"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_id_key" ON "customer"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "customer_pic_tenant_id_idx" ON "customer_pic"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_pic_customer_id_idx" ON "customer_pic"("customer_id");

-- CreateIndex
CREATE INDEX "customer_pic_name_idx" ON "customer_pic"("name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_pic_tenant_id_code_key" ON "customer_pic"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "expert_area_tenant_id_idx" ON "expert_area"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "expert_area_tenant_id_code_key" ON "expert_area"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "network_tenant_id_idx" ON "network"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "network_tenant_id_code_key" ON "network"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "agent_tenant_id_idx" ON "agent"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_name_idx" ON "agent"("name");

-- CreateIndex
CREATE INDEX "agent_country_idx" ON "agent"("country");

-- CreateIndex
CREATE INDEX "agent_agent_type_idx" ON "agent"("agent_type");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tenant_id_code_key" ON "agent"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tenant_id_id_key" ON "agent"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "agent_pic_tenant_id_idx" ON "agent_pic"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_pic_agent_id_idx" ON "agent_pic"("agent_id");

-- CreateIndex
CREATE INDEX "agent_pic_name_idx" ON "agent_pic"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_pic_tenant_id_code_key" ON "agent_pic"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "agent_expert_area_tenant_id_idx" ON "agent_expert_area"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_expert_area_agent_id_idx" ON "agent_expert_area"("agent_id");

-- CreateIndex
CREATE INDEX "agent_expert_area_expert_area_id_idx" ON "agent_expert_area"("expert_area_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_expert_area_tenant_id_agent_id_expert_area_id_key" ON "agent_expert_area"("tenant_id", "agent_id", "expert_area_id");

-- CreateIndex
CREATE INDEX "agent_port_coverage_tenant_id_idx" ON "agent_port_coverage"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_port_coverage_agent_id_idx" ON "agent_port_coverage"("agent_id");

-- CreateIndex
CREATE INDEX "agent_port_coverage_port_id_idx" ON "agent_port_coverage"("port_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_port_coverage_tenant_id_agent_id_port_id_key" ON "agent_port_coverage"("tenant_id", "agent_id", "port_id");

-- CreateIndex
CREATE INDEX "agent_network_member_tenant_id_idx" ON "agent_network_member"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_network_member_agent_id_idx" ON "agent_network_member"("agent_id");

-- CreateIndex
CREATE INDEX "agent_network_member_network_id_idx" ON "agent_network_member"("network_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_network_member_tenant_id_agent_id_network_id_key" ON "agent_network_member"("tenant_id", "agent_id", "network_id");

-- CreateIndex
CREATE INDEX "employee_tenant_id_idx" ON "employee"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_name_idx" ON "employee"("name");

-- CreateIndex
CREATE INDEX "employee_department_idx" ON "employee"("department");

-- CreateIndex
CREATE UNIQUE INDEX "employee_tenant_id_code_key" ON "employee"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_tenant_id_id_key" ON "employee"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "employee_cv_tenant_id_idx" ON "employee_cv"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_cv_tenant_id_employee_id_key" ON "employee_cv"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "employee_salary_tenant_id_idx" ON "employee_salary"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_salary_tenant_id_employee_id_key" ON "employee_salary"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "role_tenant_id_idx" ON "role"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_code_key" ON "role"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_name_key" ON "role"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_id_key" ON "role"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "role_permission_tenant_id_idx" ON "role_permission"("tenant_id");

-- CreateIndex
CREATE INDEX "role_permission_role_id_idx" ON "role_permission"("role_id");

-- CreateIndex
CREATE INDEX "role_permission_permission_id_idx" ON "role_permission"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_tenant_id_role_id_permission_id_key" ON "role_permission"("tenant_id", "role_id", "permission_id");

-- CreateIndex
CREATE INDEX "user_tenant_id_idx" ON "user"("tenant_id");

-- CreateIndex
CREATE INDEX "user_employee_id_idx" ON "user"("employee_id");

-- CreateIndex
CREATE INDEX "user_role_id_idx" ON "user"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_username_key" ON "user"("tenant_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_email_key" ON "user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_code_key" ON "user"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_id_key" ON "user"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "user_permission_tenant_id_idx" ON "user_permission"("tenant_id");

-- CreateIndex
CREATE INDEX "user_permission_user_id_idx" ON "user_permission"("user_id");

-- CreateIndex
CREATE INDEX "user_permission_permission_id_idx" ON "user_permission"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_permission_tenant_id_user_id_permission_id_key" ON "user_permission"("tenant_id", "user_id", "permission_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_table_name_record_id_idx" ON "audit_log"("tenant_id", "table_name", "record_id");

-- CreateIndex
CREATE INDEX "audit_log_changed_by_idx" ON "audit_log"("changed_by");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- AddForeignKey
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_master_override" ADD CONSTRAINT "tenant_master_override_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "port" ADD CONSTRAINT "port_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency" ADD CONSTRAINT "currency_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency_rate_history" ADD CONSTRAINT "currency_rate_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency_rate_history" ADD CONSTRAINT "currency_rate_history_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_unit" ADD CONSTRAINT "cost_unit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_head" ADD CONSTRAINT "cost_head_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_head" ADD CONSTRAINT "cost_head_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "cost_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_type" ADD CONSTRAINT "carrier_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "carrier_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_pic" ADD CONSTRAINT "carrier_pic_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_pic" ADD CONSTRAINT "carrier_pic_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_service_port" ADD CONSTRAINT "carrier_service_port_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_service_port" ADD CONSTRAINT "carrier_service_port_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_service_port" ADD CONSTRAINT "carrier_service_port_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessel" ADD CONSTRAINT "vessel_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessel" ADD CONSTRAINT "vessel_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_type" ADD CONSTRAINT "vendor_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_pic" ADD CONSTRAINT "vendor_pic_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_pic" ADD CONSTRAINT "vendor_pic_tenant_id_vendor_id_fkey" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendor"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "industry_sector" ADD CONSTRAINT "industry_sector_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commodity_item" ADD CONSTRAINT "commodity_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commodity_item" ADD CONSTRAINT "commodity_item_tenant_id_industry_sector_id_fkey" FOREIGN KEY ("tenant_id", "industry_sector_id") REFERENCES "industry_sector"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_tenant_id_industry_sector_id_fkey" FOREIGN KEY ("tenant_id", "industry_sector_id") REFERENCES "industry_sector"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_pic" ADD CONSTRAINT "customer_pic_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_pic" ADD CONSTRAINT "customer_pic_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_area" ADD CONSTRAINT "expert_area_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network" ADD CONSTRAINT "network_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pic" ADD CONSTRAINT "agent_pic_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pic" ADD CONSTRAINT "agent_pic_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_expert_area" ADD CONSTRAINT "agent_expert_area_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_expert_area" ADD CONSTRAINT "agent_expert_area_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_expert_area" ADD CONSTRAINT "agent_expert_area_expert_area_id_fkey" FOREIGN KEY ("expert_area_id") REFERENCES "expert_area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_port_coverage" ADD CONSTRAINT "agent_port_coverage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_port_coverage" ADD CONSTRAINT "agent_port_coverage_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_port_coverage" ADD CONSTRAINT "agent_port_coverage_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_network_member" ADD CONSTRAINT "agent_network_member_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_network_member" ADD CONSTRAINT "agent_network_member_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_network_member" ADD CONSTRAINT "agent_network_member_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "network"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_cv" ADD CONSTRAINT "employee_cv_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_cv" ADD CONSTRAINT "employee_cv_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "role"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "role"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN APPENDIX
-- Constraints and indexes the Prisma schema cannot express. Documented in
-- prisma/schema.prisma under "WHAT THIS SCHEMA DELIBERATELY DOES NOT MODEL".
-- Keep this block in sync when those tables change.
-- ===========================================================================

-- -------------------------------------------------------------------------
-- 1. employee_salary.gross_salary — GENERATED ALWAYS (CLAUDE.md §6)
-- -------------------------------------------------------------------------
-- §6: "gross_salary (GENERATED — auto sum, never stored by hand)".
-- Prisma emitted it as an ordinary column; replace it with a real generated
-- one so no code path can ever write an inconsistent total.
ALTER TABLE "employee_salary" DROP COLUMN "gross_salary";
ALTER TABLE "employee_salary" ADD COLUMN "gross_salary" DECIMAL(18,4)
  GENERATED ALWAYS AS (
    "basic_salary" + "home_rent" + "medical" + "mobile_bill" + "insurance" + "incentive"
  ) STORED;

-- -------------------------------------------------------------------------
-- 2. created_by / updated_by foreign keys (CLAUDE.md §4 rule 5)
-- -------------------------------------------------------------------------
-- Modelling these as Prisma relations would need ~60 back-relation fields on
-- User, so the constraints are declared here instead. Single-column by
-- design: a system row (tenant_id IS NULL) has no tenant to composite with.
ALTER TABLE "tenant_master_override" ADD CONSTRAINT "tenant_master_override_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "port" ADD CONSTRAINT "port_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "currency" ADD CONSTRAINT "currency_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "currency_rate_history" ADD CONSTRAINT "currency_rate_history_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cost_unit" ADD CONSTRAINT "cost_unit_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cost_head" ADD CONSTRAINT "cost_head_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_type" ADD CONSTRAINT "carrier_type_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pic" ADD CONSTRAINT "carrier_pic_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_service_port" ADD CONSTRAINT "carrier_service_port_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vessel" ADD CONSTRAINT "vessel_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_type" ADD CONSTRAINT "vendor_type_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_pic" ADD CONSTRAINT "vendor_pic_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "industry_sector" ADD CONSTRAINT "industry_sector_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_item" ADD CONSTRAINT "commodity_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_pic" ADD CONSTRAINT "customer_pic_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_area" ADD CONSTRAINT "expert_area_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "network" ADD CONSTRAINT "network_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent" ADD CONSTRAINT "agent_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_pic" ADD CONSTRAINT "agent_pic_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_expert_area" ADD CONSTRAINT "agent_expert_area_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_port_coverage" ADD CONSTRAINT "agent_port_coverage_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_network_member" ADD CONSTRAINT "agent_network_member_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee" ADD CONSTRAINT "employee_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_cv" ADD CONSTRAINT "employee_cv_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role" ADD CONSTRAINT "role_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user" ADD CONSTRAINT "user_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tenant_master_override" ADD CONSTRAINT "tenant_master_override_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "port" ADD CONSTRAINT "port_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "currency" ADD CONSTRAINT "currency_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "currency_rate_history" ADD CONSTRAINT "currency_rate_history_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cost_unit" ADD CONSTRAINT "cost_unit_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cost_head" ADD CONSTRAINT "cost_head_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_type" ADD CONSTRAINT "carrier_type_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pic" ADD CONSTRAINT "carrier_pic_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_service_port" ADD CONSTRAINT "carrier_service_port_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vessel" ADD CONSTRAINT "vessel_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_type" ADD CONSTRAINT "vendor_type_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_pic" ADD CONSTRAINT "vendor_pic_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "industry_sector" ADD CONSTRAINT "industry_sector_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commodity_item" ADD CONSTRAINT "commodity_item_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer" ADD CONSTRAINT "customer_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_pic" ADD CONSTRAINT "customer_pic_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_area" ADD CONSTRAINT "expert_area_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "network" ADD CONSTRAINT "network_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent" ADD CONSTRAINT "agent_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_pic" ADD CONSTRAINT "agent_pic_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee" ADD CONSTRAINT "employee_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_cv" ADD CONSTRAINT "employee_cv_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role" ADD CONSTRAINT "role_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user" ADD CONSTRAINT "user_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -------------------------------------------------------------------------
-- 3. Partial unique indexes for system rows (CLAUDE.md §4 rule 9)
-- -------------------------------------------------------------------------
-- UNIQUE(tenant_id, code) does NOT constrain system rows: Postgres treats
-- every NULL as distinct, so any number of them could share a code. These
-- partial indexes close that hole on the 8 system-capable tables.
CREATE UNIQUE INDEX "port_code_system_key" ON "port" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "currency_code_system_key" ON "currency" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "cost_unit_code_system_key" ON "cost_unit" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "carrier_type_code_system_key" ON "carrier_type" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "carrier_code_system_key" ON "carrier" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "vendor_type_code_system_key" ON "vendor_type" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "expert_area_code_system_key" ON "expert_area" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "network_code_system_key" ON "network" ("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "port_port_code_system_key" ON "port" ("port_code") WHERE "tenant_id" IS NULL;

-- -------------------------------------------------------------------------
-- 4. GIN full-text indexes on searched names (CLAUDE.md §4 rule 8)
-- -------------------------------------------------------------------------
-- The 'simple' configuration is deliberate: these are proper nouns
-- (Maersk, Chattogram) and English stemming would corrupt them.
CREATE INDEX "port_name_search_idx" ON "port" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "cost_head_name_search_idx" ON "cost_head" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "carrier_name_search_idx" ON "carrier" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "carrier_pic_name_search_idx" ON "carrier_pic" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "vessel_name_search_idx" ON "vessel" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "vendor_name_search_idx" ON "vendor" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "vendor_pic_name_search_idx" ON "vendor_pic" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "industry_sector_name_search_idx" ON "industry_sector" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "commodity_item_name_search_idx" ON "commodity_item" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "customer_name_search_idx" ON "customer" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "customer_pic_name_search_idx" ON "customer_pic" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "agent_name_search_idx" ON "agent" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "agent_pic_name_search_idx" ON "agent_pic" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "employee_name_search_idx" ON "employee" USING GIN (to_tsvector('simple', "name"));
