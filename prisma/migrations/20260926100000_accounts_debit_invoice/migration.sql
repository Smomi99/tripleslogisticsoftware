-- ===========================================================================
-- ACCOUNTS — Awaiting Freight Inv, Debit Invoice, Receivable-Payable list
-- docs/MODULE_ACCOUNTS.md §4 and §6
-- ===========================================================================
--
-- Five new tables and four enums:
--
--   debit_invoice             the debit note — FREIGHT from a booking on the
--                             awaiting list, OTHER from `Create New` (§3.2)
--   debit_invoice_line        its Selling Price grid
--   debit_invoice_cost        one "Buying from Carrier / Agent / Vendor" block
--   debit_invoice_cost_line   that block's grid
--   debit_invoice_receipt     "Receive"
--
-- Nothing existing is altered except the permission registry's Accounts rows,
-- renamed in place at the bottom (§6). No column is added to a live table and
-- nothing is dropped, so every row already in production satisfies this the
-- moment it runs.
--
-- The DDL below is `prisma migrate diff` between the committed schema and this
-- one, with the two line amounts turned into GENERATED columns — the same
-- arithmetic quotation_line and agent_quote_line do in the database rather
-- than in three places.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "debit_invoice_kind" AS ENUM ('FREIGHT', 'OTHER');

-- CreateEnum
CREATE TYPE "debit_invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "supplier_party_type" AS ENUM ('CARRIER', 'AGENT', 'VENDOR');

-- CreateEnum
CREATE TYPE "invoice_line_source" AS ENUM ('QUOTATION', 'LOAD_PLAN', 'MANUAL');

-- CreateTable
CREATE TABLE "debit_invoice" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "series_year" INTEGER NOT NULL,
    "kind" "debit_invoice_kind" NOT NULL DEFAULT 'FREIGHT',
    "shipment_id" BIGINT,
    "quotation_id" BIGINT,
    "customer_id" BIGINT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "currency_code" VARCHAR(10) NOT NULL,
    "conversion_rate" DECIMAL(18,10) NOT NULL,
    "total_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_amount_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cost_total_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "recipient_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "debit_invoice_status" NOT NULL DEFAULT 'DRAFT',
    "issued_at" TIMESTAMPTZ(6),
    "issued_by" BIGINT,
    "sent_at" TIMESTAMPTZ(6),
    "sent_by" BIGINT,
    "pdf_file" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" BIGINT,
    "cancel_reason" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debit_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_invoice_line" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "debit_invoice_id" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" "invoice_line_source" NOT NULL DEFAULT 'MANUAL',
    "cost_head_id" BIGINT NOT NULL,
    "cost_head_name" VARCHAR(200) NOT NULL,
    "container_size_id" BIGINT,
    "container_size_name" VARCHAR(100),
    "cost_unit_id" BIGINT,
    "unit_name" VARCHAR(100),
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4) GENERATED ALWAYS AS ("quantity" * "unit_price") STORED,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debit_invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_invoice_cost" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "debit_invoice_id" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "party_type" "supplier_party_type" NOT NULL,
    "carrier_id" BIGINT,
    "agent_id" BIGINT,
    "vendor_id" BIGINT,
    "supplier_invoice_no" VARCHAR(100),
    "supplier_invoice_file" VARCHAR(500),
    "currency_id" BIGINT NOT NULL,
    "currency_code" VARCHAR(10) NOT NULL,
    "conversion_rate" DECIMAL(18,10) NOT NULL,
    "total_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_amount_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debit_invoice_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_invoice_cost_line" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "debit_invoice_cost_id" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" "invoice_line_source" NOT NULL DEFAULT 'MANUAL',
    "cost_head_id" BIGINT NOT NULL,
    "cost_head_name" VARCHAR(200) NOT NULL,
    "container_size_id" BIGINT,
    "container_size_name" VARCHAR(100),
    "cost_unit_id" BIGINT,
    "unit_name" VARCHAR(100),
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4) GENERATED ALWAYS AS ("quantity" * "unit_price") STORED,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debit_invoice_cost_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_invoice_receipt" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "debit_invoice_id" BIGINT NOT NULL,
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "amount_base" DECIMAL(18,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debit_invoice_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "debit_invoice_tenant_id_idx" ON "debit_invoice"("tenant_id");

-- CreateIndex
CREATE INDEX "debit_invoice_tenant_id_status_idx" ON "debit_invoice"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "debit_invoice_tenant_id_shipment_id_idx" ON "debit_invoice"("tenant_id", "shipment_id");

-- CreateIndex
CREATE INDEX "debit_invoice_tenant_id_customer_id_idx" ON "debit_invoice"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "debit_invoice_quotation_id_idx" ON "debit_invoice"("quotation_id");

-- CreateIndex
CREATE INDEX "debit_invoice_currency_id_idx" ON "debit_invoice"("currency_id");

-- CreateIndex
CREATE INDEX "debit_invoice_issued_by_idx" ON "debit_invoice"("issued_by");

-- CreateIndex
CREATE INDEX "debit_invoice_sent_by_idx" ON "debit_invoice"("sent_by");

-- CreateIndex
CREATE INDEX "debit_invoice_cancelled_by_idx" ON "debit_invoice"("cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "debit_invoice_tenant_id_code_key" ON "debit_invoice"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "debit_invoice_tenant_id_id_key" ON "debit_invoice"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "debit_invoice_line_tenant_id_idx" ON "debit_invoice_line"("tenant_id");

-- CreateIndex
CREATE INDEX "debit_invoice_line_debit_invoice_id_idx" ON "debit_invoice_line"("debit_invoice_id");

-- CreateIndex
CREATE INDEX "debit_invoice_line_cost_head_id_idx" ON "debit_invoice_line"("cost_head_id");

-- CreateIndex
CREATE INDEX "debit_invoice_line_container_size_id_idx" ON "debit_invoice_line"("container_size_id");

-- CreateIndex
CREATE INDEX "debit_invoice_line_cost_unit_id_idx" ON "debit_invoice_line"("cost_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "debit_invoice_line_tenant_id_id_key" ON "debit_invoice_line"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_tenant_id_idx" ON "debit_invoice_cost"("tenant_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_debit_invoice_id_idx" ON "debit_invoice_cost"("debit_invoice_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_carrier_id_idx" ON "debit_invoice_cost"("carrier_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_agent_id_idx" ON "debit_invoice_cost"("agent_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_vendor_id_idx" ON "debit_invoice_cost"("vendor_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_currency_id_idx" ON "debit_invoice_cost"("currency_id");

-- CreateIndex
CREATE UNIQUE INDEX "debit_invoice_cost_tenant_id_id_key" ON "debit_invoice_cost"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_line_tenant_id_idx" ON "debit_invoice_cost_line"("tenant_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_line_debit_invoice_cost_id_idx" ON "debit_invoice_cost_line"("debit_invoice_cost_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_line_cost_head_id_idx" ON "debit_invoice_cost_line"("cost_head_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_line_container_size_id_idx" ON "debit_invoice_cost_line"("container_size_id");

-- CreateIndex
CREATE INDEX "debit_invoice_cost_line_cost_unit_id_idx" ON "debit_invoice_cost_line"("cost_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "debit_invoice_cost_line_tenant_id_id_key" ON "debit_invoice_cost_line"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "debit_invoice_receipt_tenant_id_idx" ON "debit_invoice_receipt"("tenant_id");

-- CreateIndex
CREATE INDEX "debit_invoice_receipt_debit_invoice_id_idx" ON "debit_invoice_receipt"("debit_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "debit_invoice_receipt_tenant_id_id_key" ON "debit_invoice_receipt"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_tenant_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_tenant_id_quotation_id_fkey" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_tenant_id_debit_invoice_id_fkey" FOREIGN KEY ("tenant_id", "debit_invoice_id") REFERENCES "debit_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_tenant_id_cost_head_id_fkey" FOREIGN KEY ("tenant_id", "cost_head_id") REFERENCES "cost_head"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_container_size_id_fkey" FOREIGN KEY ("container_size_id") REFERENCES "container_size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_cost_unit_id_fkey" FOREIGN KEY ("cost_unit_id") REFERENCES "cost_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_tenant_id_debit_invoice_id_fkey" FOREIGN KEY ("tenant_id", "debit_invoice_id") REFERENCES "debit_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_tenant_id_vendor_id_fkey" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendor"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_tenant_id_debit_invoice_cost_id_fkey" FOREIGN KEY ("tenant_id", "debit_invoice_cost_id") REFERENCES "debit_invoice_cost"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_tenant_id_cost_head_id_fkey" FOREIGN KEY ("tenant_id", "cost_head_id") REFERENCES "cost_head"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_container_size_id_fkey" FOREIGN KEY ("container_size_id") REFERENCES "container_size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_cost_unit_id_fkey" FOREIGN KEY ("cost_unit_id") REFERENCES "cost_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_receipt" ADD CONSTRAINT "debit_invoice_receipt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_receipt" ADD CONSTRAINT "debit_invoice_receipt_tenant_id_debit_invoice_id_fkey" FOREIGN KEY ("tenant_id", "debit_invoice_id") REFERENCES "debit_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_receipt" ADD CONSTRAINT "debit_invoice_receipt_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_invoice_receipt" ADD CONSTRAINT "debit_invoice_receipt_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ------------------------------------------------------------ the rules
-- §3.2: a freight invoice exists because a booking does.
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_freight_needs_shipment"
  CHECK ("kind" <> 'FREIGHT' OR "shipment_id" IS NOT NULL);

-- §3.7: cancelling says why, the way a cancelled booking and advise do.
ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_cancel_needs_reason"
  CHECK ("status" <> 'CANCELLED' OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) > 0));

ALTER TABLE "debit_invoice" ADD CONSTRAINT "debit_invoice_rate_positive"
  CHECK ("conversion_rate" > 0);

-- A block is owed to exactly the party its type names — a carrier block with
-- a vendor on it would post a payable to the wrong ledger.
ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_party_matches_type"
  CHECK (
    ("party_type" = 'CARRIER' AND "carrier_id" IS NOT NULL AND "agent_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'AGENT'   AND "agent_id"   IS NOT NULL AND "carrier_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'VENDOR'  AND "vendor_id"  IS NOT NULL AND "carrier_id" IS NULL AND "agent_id" IS NULL)
  );

ALTER TABLE "debit_invoice_cost" ADD CONSTRAINT "debit_invoice_cost_rate_positive"
  CHECK ("conversion_rate" > 0);

ALTER TABLE "debit_invoice_line" ADD CONSTRAINT "debit_invoice_line_quantity_non_negative"
  CHECK ("quantity" >= 0);
ALTER TABLE "debit_invoice_cost_line" ADD CONSTRAINT "debit_invoice_cost_line_quantity_non_negative"
  CHECK ("quantity" >= 0);

-- §5 rule 4: money in is a positive figure.
ALTER TABLE "debit_invoice_receipt" ADD CONSTRAINT "debit_invoice_receipt_amount_positive"
  CHECK ("amount" > 0);

-- ---------------------------------------------------------- natural keys
-- §3.2: one live freight invoice per booking. Partial, so a cancelled one
-- does not hold the booking forever — the booking goes back on the awaiting
-- list and is invoiced again.
CREATE UNIQUE INDEX "debit_invoice_tenant_id_shipment_id_live_freight_key"
  ON "debit_invoice" ("tenant_id", "shipment_id")
  WHERE "kind" = 'FREIGHT' AND "deleted_at" IS NULL AND "status" <> 'CANCELLED';

-- ------------------------------------------------------------------ tenancy
-- The single-comparison form (20260917090000): app_staff_tenant() is NULL for
-- any non-staff session, so these deny an agent and a customer alike. Nothing
-- here is opened to the portals.
ALTER TABLE "debit_invoice" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_invoice"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "debit_invoice_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_invoice_line"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "debit_invoice_cost" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_invoice_cost"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "debit_invoice_cost_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_invoice_cost_line"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "debit_invoice_receipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_invoice_receipt"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

-- No DELETE anywhere: a line removed from a grid is soft-deleted like every
-- other line in the product, so what an issued invoice once said stays on the
-- record (§4 rule 3).
GRANT SELECT, INSERT, UPDATE ON TABLE "debit_invoice" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "debit_invoice_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "debit_invoice_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "debit_invoice_line_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "debit_invoice_cost" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "debit_invoice_cost_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "debit_invoice_cost_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "debit_invoice_cost_line_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "debit_invoice_receipt" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "debit_invoice_receipt_id_seq" TO ff_app;

-- §4 rule 7: the audit trail is a trigger, so a write from any path is caught.
CREATE TRIGGER "debit_invoice_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "debit_invoice"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "debit_invoice_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "debit_invoice_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "debit_invoice_cost_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "debit_invoice_cost"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "debit_invoice_cost_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "debit_invoice_cost_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "debit_invoice_receipt_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "debit_invoice_receipt"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- §4 rule 10. Currency, carrier, container size and cost unit are
-- system-capable and reached by single-column keys, so the constraint alone
-- cannot say whose row it is — a plain FK would accept another workspace's
-- private carrier quite happily.
CREATE TRIGGER debit_invoice_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON debit_invoice
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');

CREATE TRIGGER debit_invoice_line_container_size_id_tenant_guard
  BEFORE INSERT OR UPDATE OF container_size_id ON debit_invoice_line
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');
CREATE TRIGGER debit_invoice_line_cost_unit_id_tenant_guard
  BEFORE INSERT OR UPDATE OF cost_unit_id ON debit_invoice_line
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('cost_unit', 'cost_unit_id');

CREATE TRIGGER debit_invoice_cost_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON debit_invoice_cost
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
CREATE TRIGGER debit_invoice_cost_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON debit_invoice_cost
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');

CREATE TRIGGER debit_invoice_cost_line_container_size_id_tenant_guard
  BEFORE INSERT OR UPDATE OF container_size_id ON debit_invoice_cost_line
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');
CREATE TRIGGER debit_invoice_cost_line_cost_unit_id_tenant_guard
  BEFORE INSERT OR UPDATE OF cost_unit_id ON debit_invoice_cost_line
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('cost_unit', 'cost_unit_id');

-- ---------------------------------------------------------------------------
-- §6: the Accounts menu the client redrew (Design.xlsx, Menu M3–M16)
-- ---------------------------------------------------------------------------
-- Renamed IN PLACE, for the reason 20260819180000 gives when Vendor moved to
-- CRM: the seed upserts permissions by key, so writing new keys without this
-- would create fresh rows and orphan the old ones, and every role and user
-- grant points at permission.id.

-- "New Invoice (Other)" is now "Debit Invoice".
UPDATE "permission"
   SET "feature" = 'ACCOUNTS.DEBIT_INVOICE',
       "key"     = replace("key", 'ACCOUNTS.NEW_INVOICE_OTHER.', 'ACCOUNTS.DEBIT_INVOICE.')
 WHERE "feature" = 'ACCOUNTS.NEW_INVOICE_OTHER';

-- "Amount Receivable" and "Amount Payable" are now one screen. The receivable
-- rows are renamed onto it...
UPDATE "permission"
   SET "feature" = 'ACCOUNTS.RECEIVABLE_PAYABLE',
       "key"     = replace("key", 'ACCOUNTS.AMOUNT_RECEIVABLE.', 'ACCOUNTS.RECEIVABLE_PAYABLE.')
 WHERE "feature" = 'ACCOUNTS.AMOUNT_RECEIVABLE';

-- ...and the payable rows cannot also be renamed onto the same keys, so every
-- grant on them is copied onto the matching key first. Nobody who could open
-- Amount Payable loses the screen that now shows payables. Where a user
-- already holds an override on the merged key, theirs stands.
INSERT INTO "role_permission" ("tenant_id", "role_id", "permission_id", "created_at", "created_by")
SELECT rp."tenant_id", rp."role_id", t."id", now(), rp."created_by"
  FROM "role_permission" rp
  JOIN "permission" p ON p."id" = rp."permission_id" AND p."feature" = 'ACCOUNTS.AMOUNT_PAYABLE'
  JOIN "permission" t ON t."feature" = 'ACCOUNTS.RECEIVABLE_PAYABLE' AND t."action" = p."action"
ON CONFLICT ("tenant_id", "role_id", "permission_id") DO NOTHING;

INSERT INTO "user_permission"
  ("tenant_id", "user_id", "permission_id", "effect", "created_at", "updated_at", "created_by", "updated_by")
SELECT up."tenant_id", up."user_id", t."id", up."effect", now(), now(), up."created_by", up."updated_by"
  FROM "user_permission" up
  JOIN "permission" p ON p."id" = up."permission_id" AND p."feature" = 'ACCOUNTS.AMOUNT_PAYABLE'
  JOIN "permission" t ON t."feature" = 'ACCOUNTS.RECEIVABLE_PAYABLE' AND t."action" = p."action"
ON CONFLICT ("tenant_id", "user_id", "permission_id") DO NOTHING;

DELETE FROM "role_permission"
 WHERE "permission_id" IN (SELECT "id" FROM "permission" WHERE "feature" = 'ACCOUNTS.AMOUNT_PAYABLE');
DELETE FROM "user_permission"
 WHERE "permission_id" IN (SELECT "id" FROM "permission" WHERE "feature" = 'ACCOUNTS.AMOUNT_PAYABLE');
DELETE FROM "permission" WHERE "feature" = 'ACCOUNTS.AMOUNT_PAYABLE';
