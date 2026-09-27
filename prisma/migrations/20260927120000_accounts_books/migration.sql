-- ===========================================================================
-- ACCOUNTS — the books: docs/MODULE_ACCOUNTS.md §14
-- ===========================================================================
--
-- Design.xlsx, 2026-09-27: the client drew the rest of the Accounts menu.
-- Seven tables and five enums:
--
--   ledger_account       Chart of accounts — a Ledger or a Sub Ledger
--   bank                 bank setup — one row per bank branch
--   bank_account         Account setup — posts through its own Sub Ledger
--   journal_entry        one voucher: Journal, Expense, Income or Transfer
--   journal_line         its debits and credits, in the workspace base
--   supplier_payment     Expense-Vendor against a Credit Invoice
--   opening_settlement   money in or out against a CRM opening balance
--
-- One existing table gains one nullable column: debit_invoice_receipt now
-- names the Income voucher that banked it (journal_entry_id). Receipts
-- already on file keep NULL — they were recorded before there were books.
-- Nothing is dropped, nothing existing is rewritten.
--
-- The DDL below is `prisma migrate diff` between the committed schema and
-- this one. What Prisma cannot say follows it by hand: the checks, the
-- partial keys, the balance trigger, tenancy, grants, audit and the guards.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "ledger_account_type" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "journal_entry_kind" AS ENUM ('JOURNAL', 'EXPENSE', 'INCOME', 'TRANSFER');

-- CreateEnum
CREATE TYPE "journal_entry_status" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ledger_party_type" AS ENUM ('CUSTOMER', 'AGENT', 'CARRIER', 'VENDOR');

-- CreateEnum
CREATE TYPE "settlement_side" AS ENUM ('RECEIVABLE', 'PAYABLE');

-- AlterTable
ALTER TABLE "debit_invoice_receipt" ADD COLUMN     "journal_entry_id" BIGINT;

-- CreateTable
CREATE TABLE "ledger_account" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "account_type" "ledger_account_type" NOT NULL,
    "parent_id" BIGINT,
    "name" VARCHAR(200) NOT NULL,
    "system_key" VARCHAR(64),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "ledger_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "bank_name" VARCHAR(200) NOT NULL,
    "branch" VARCHAR(200) NOT NULL,
    "bank_address" TEXT,
    "swift_no" VARCHAR(20),
    "routing_no" VARCHAR(20),
    "iban_no" VARCHAR(40),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_account" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "account_name" VARCHAR(200) NOT NULL,
    "account_no" VARCHAR(50) NOT NULL,
    "bank_id" BIGINT NOT NULL,
    "ledger_account_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "series_year" INTEGER NOT NULL,
    "kind" "journal_entry_kind" NOT NULL,
    "entry_date" DATE NOT NULL,
    "description" TEXT,
    "attachment_file" VARCHAR(500),
    "status" "journal_entry_status" NOT NULL DEFAULT 'DRAFT',
    "party_type" "ledger_party_type",
    "customer_id" BIGINT,
    "agent_id" BIGINT,
    "carrier_id" BIGINT,
    "vendor_id" BIGINT,
    "total_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "posted_at" TIMESTAMPTZ(6),
    "posted_by" BIGINT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" BIGINT,
    "cancel_reason" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "journal_entry_id" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "ledger_account_id" BIGINT NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "journal_entry_id" BIGINT NOT NULL,
    "debit_invoice_cost_id" BIGINT NOT NULL,
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "amount_base" DECIMAL(18,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "supplier_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_settlement" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "journal_entry_id" BIGINT NOT NULL,
    "side" "settlement_side" NOT NULL,
    "party_type" "ledger_party_type" NOT NULL,
    "customer_id" BIGINT,
    "agent_id" BIGINT,
    "vendor_id" BIGINT,
    "settlement_date" DATE NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "currency_code" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "opening_settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_account_tenant_id_idx" ON "ledger_account"("tenant_id");

-- CreateIndex
CREATE INDEX "ledger_account_tenant_id_parent_id_idx" ON "ledger_account"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_tenant_id_code_key" ON "ledger_account"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_tenant_id_id_key" ON "ledger_account"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_tenant_id_system_key_key" ON "ledger_account"("tenant_id", "system_key");

-- CreateIndex
CREATE INDEX "bank_tenant_id_idx" ON "bank"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_tenant_id_code_key" ON "bank"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "bank_tenant_id_id_key" ON "bank"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "bank_account_tenant_id_idx" ON "bank_account"("tenant_id");

-- CreateIndex
CREATE INDEX "bank_account_bank_id_idx" ON "bank_account"("bank_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_tenant_id_code_key" ON "bank_account"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_tenant_id_id_key" ON "bank_account"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_tenant_id_ledger_account_id_key" ON "bank_account"("tenant_id", "ledger_account_id");

-- CreateIndex
CREATE INDEX "journal_entry_tenant_id_idx" ON "journal_entry"("tenant_id");

-- CreateIndex
CREATE INDEX "journal_entry_tenant_id_kind_status_idx" ON "journal_entry"("tenant_id", "kind", "status");

-- CreateIndex
CREATE INDEX "journal_entry_customer_id_idx" ON "journal_entry"("customer_id");

-- CreateIndex
CREATE INDEX "journal_entry_agent_id_idx" ON "journal_entry"("agent_id");

-- CreateIndex
CREATE INDEX "journal_entry_carrier_id_idx" ON "journal_entry"("carrier_id");

-- CreateIndex
CREATE INDEX "journal_entry_vendor_id_idx" ON "journal_entry"("vendor_id");

-- CreateIndex
CREATE INDEX "journal_entry_posted_by_idx" ON "journal_entry"("posted_by");

-- CreateIndex
CREATE INDEX "journal_entry_cancelled_by_idx" ON "journal_entry"("cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_tenant_id_code_key" ON "journal_entry"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_tenant_id_id_key" ON "journal_entry"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "journal_line_tenant_id_idx" ON "journal_line"("tenant_id");

-- CreateIndex
CREATE INDEX "journal_line_journal_entry_id_idx" ON "journal_line"("journal_entry_id");

-- CreateIndex
CREATE INDEX "journal_line_ledger_account_id_idx" ON "journal_line"("ledger_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_line_tenant_id_id_key" ON "journal_line"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "supplier_payment_tenant_id_idx" ON "supplier_payment"("tenant_id");

-- CreateIndex
CREATE INDEX "supplier_payment_journal_entry_id_idx" ON "supplier_payment"("journal_entry_id");

-- CreateIndex
CREATE INDEX "supplier_payment_debit_invoice_cost_id_idx" ON "supplier_payment"("debit_invoice_cost_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_tenant_id_id_key" ON "supplier_payment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "opening_settlement_tenant_id_idx" ON "opening_settlement"("tenant_id");

-- CreateIndex
CREATE INDEX "opening_settlement_journal_entry_id_idx" ON "opening_settlement"("journal_entry_id");

-- CreateIndex
CREATE INDEX "opening_settlement_customer_id_idx" ON "opening_settlement"("customer_id");

-- CreateIndex
CREATE INDEX "opening_settlement_agent_id_idx" ON "opening_settlement"("agent_id");

-- CreateIndex
CREATE INDEX "opening_settlement_vendor_id_idx" ON "opening_settlement"("vendor_id");

-- CreateIndex
CREATE INDEX "opening_settlement_currency_id_idx" ON "opening_settlement"("currency_id");

-- CreateIndex
CREATE UNIQUE INDEX "opening_settlement_tenant_id_id_key" ON "opening_settlement"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "debit_invoice_receipt_journal_entry_id_idx" ON "debit_invoice_receipt"("journal_entry_id");

-- AddForeignKey
ALTER TABLE "debit_invoice_receipt" ADD CONSTRAINT "debit_invoice_receipt_tenant_id_journal_entry_id_fkey" FOREIGN KEY ("tenant_id", "journal_entry_id") REFERENCES "journal_entry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "ledger_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank" ADD CONSTRAINT "bank_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank" ADD CONSTRAINT "bank_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank" ADD CONSTRAINT "bank_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_tenant_id_bank_id_fkey" FOREIGN KEY ("tenant_id", "bank_id") REFERENCES "bank"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_tenant_id_ledger_account_id_fkey" FOREIGN KEY ("tenant_id", "ledger_account_id") REFERENCES "ledger_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_tenant_id_vendor_id_fkey" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendor"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tenant_id_journal_entry_id_fkey" FOREIGN KEY ("tenant_id", "journal_entry_id") REFERENCES "journal_entry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tenant_id_ledger_account_id_fkey" FOREIGN KEY ("tenant_id", "ledger_account_id") REFERENCES "ledger_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_tenant_id_journal_entry_id_fkey" FOREIGN KEY ("tenant_id", "journal_entry_id") REFERENCES "journal_entry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_tenant_id_debit_invoice_cost_id_fkey" FOREIGN KEY ("tenant_id", "debit_invoice_cost_id") REFERENCES "debit_invoice_cost"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_tenant_id_journal_entry_id_fkey" FOREIGN KEY ("tenant_id", "journal_entry_id") REFERENCES "journal_entry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_tenant_id_vendor_id_fkey" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendor"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ------------------------------------------------------------ the rules
-- A voucher line is one debit or one credit, never both and never neither.
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_one_side"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)));

-- §14.4: cancelling says why, the way a cancelled invoice does.
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_cancel_needs_reason"
  CHECK ("status" <> 'CANCELLED' OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) > 0));

-- "Pay to" / "Income From" names exactly the party its type says, or nobody.
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_party_matches_type"
  CHECK (
    ("party_type" IS NULL      AND "customer_id" IS NULL AND "agent_id" IS NULL AND "carrier_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'CUSTOMER' AND "customer_id" IS NOT NULL AND "agent_id" IS NULL AND "carrier_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'AGENT'    AND "agent_id" IS NOT NULL AND "customer_id" IS NULL AND "carrier_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'CARRIER'  AND "carrier_id" IS NOT NULL AND "customer_id" IS NULL AND "agent_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'VENDOR'   AND "vendor_id" IS NOT NULL AND "customer_id" IS NULL AND "agent_id" IS NULL AND "carrier_id" IS NULL)
  );

ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_amount_positive"
  CHECK ("amount" > 0);

-- Carriers hold no opening balance (20260819180000), so none is settled.
ALTER TABLE "opening_settlement" ADD CONSTRAINT "opening_settlement_party_matches_type"
  CHECK (
    ("party_type" = 'CUSTOMER' AND "customer_id" IS NOT NULL AND "agent_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'AGENT'    AND "agent_id" IS NOT NULL AND "customer_id" IS NULL AND "vendor_id" IS NULL) OR
    ("party_type" = 'VENDOR'   AND "vendor_id" IS NOT NULL AND "customer_id" IS NULL AND "agent_id" IS NULL)
  );

-- ---------------------------------------------------------- natural keys
-- No two ledgers of one head share a name, and no two sub ledgers of one
-- ledger do. "Sea Freight-FCL" under Cost of Service and under Income on
-- Service are different accounts, as the sheet draws them.
CREATE UNIQUE INDEX "ledger_account_ledger_name_key"
  ON "ledger_account" ("tenant_id", "account_type", lower("name"))
  WHERE "parent_id" IS NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "ledger_account_sub_ledger_name_key"
  ON "ledger_account" ("tenant_id", "parent_id", lower("name"))
  WHERE "parent_id" IS NOT NULL AND "deleted_at" IS NULL;

-- One bank setup row per branch of a bank.
CREATE UNIQUE INDEX "bank_name_branch_key"
  ON "bank" ("tenant_id", lower("bank_name"), lower("branch"))
  WHERE "deleted_at" IS NULL;

-- One account number per branch.
CREATE UNIQUE INDEX "bank_account_number_key"
  ON "bank_account" ("tenant_id", "bank_id", "account_no")
  WHERE "deleted_at" IS NULL;

-- ------------------------------------------------------- the chart's shape
-- Ledger -> Sub Ledger, and no deeper (sheet B66–C68). A sub ledger sits under
-- a ledger of its own head: an Expense account cannot hang off Assets.
CREATE OR REPLACE FUNCTION app_assert_ledger_account_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_parent bigint;
  parent_type   ledger_account_type;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'ledger account % cannot be its own parent', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT parent_id, account_type INTO parent_parent, parent_type
    FROM ledger_account
   WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id;

  IF parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'ledger account % would sit under a sub ledger; the chart is two levels deep', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF parent_type IS DISTINCT FROM NEW.account_type THEN
    RAISE EXCEPTION 'ledger account % is % but its ledger is %', NEW.id, NEW.account_type, parent_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_account WHERE parent_id = NEW.id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'ledger account % has sub ledgers of its own and cannot become one', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT EXECUTE ON FUNCTION app_assert_ledger_account_parent() TO ff_app;

CREATE TRIGGER ledger_account_parent_guard
  BEFORE INSERT OR UPDATE OF parent_id, account_type ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION app_assert_ledger_account_parent();

-- ------------------------------------------------- a posted voucher balances
-- The sheets' "Debit Amount / Credit Amount / Difference": the application
-- refuses a difference, and this is the layer that catches the path which
-- forgets. Deferred to COMMIT, so a voucher is judged whole — after every line
-- of it is written — never half way through.
CREATE OR REPLACE FUNCTION app_assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_id     bigint;
  entry_status journal_entry_status;
  total_debit  numeric;
  total_credit numeric;
  line_count   integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    entry_id := NEW.id;
  ELSE
    entry_id := NEW.journal_entry_id;
  END IF;

  SELECT status INTO entry_status FROM journal_entry WHERE id = entry_id;
  -- A draft is still being written; a cancelled voucher is out of the books.
  IF entry_status IS DISTINCT FROM 'POSTED' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
    INTO total_debit, total_credit, line_count
    FROM journal_line
   WHERE journal_entry_id = entry_id AND deleted_at IS NULL;

  IF line_count < 2 OR total_debit = 0 OR total_debit <> total_credit THEN
    RAISE EXCEPTION 'voucher % does not balance: debit %, credit %, % lines',
      entry_id, total_debit, total_credit, line_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

GRANT EXECUTE ON FUNCTION app_assert_journal_balanced() TO ff_app;

CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT OR UPDATE ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_assert_journal_balanced();

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT OR UPDATE OF status ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_assert_journal_balanced();

-- ------------------------------------------------------------------ tenancy
-- The single-comparison form (20260917090000). Nothing here is opened to the
-- agent or customer portals.
ALTER TABLE "ledger_account" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ledger_account"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "bank" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "bank_account" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_account"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "journal_entry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "journal_entry"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "journal_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "journal_line"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "supplier_payment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supplier_payment"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "opening_settlement" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "opening_settlement"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

-- No DELETE anywhere (§4 rule 3). A draft's replaced lines, a cancelled
-- voucher's settlements and a removed account are soft-deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE "ledger_account" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "ledger_account_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "bank" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "bank_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "bank_account" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "bank_account_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "journal_entry" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "journal_entry_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "journal_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "journal_line_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "supplier_payment" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "supplier_payment_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "opening_settlement" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "opening_settlement_id_seq" TO ff_app;

-- §4 rule 7: the audit trail is a trigger, so a write from any path is caught.
CREATE TRIGGER "ledger_account_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "ledger_account"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "bank_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "bank"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "bank_account_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "bank_account"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "journal_entry_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_entry"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "journal_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "supplier_payment_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "supplier_payment"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "opening_settlement_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "opening_settlement"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- §4 rule 10. Carrier and currency are system-capable and reached by
-- single-column keys, so the constraint alone cannot say whose row it is.
CREATE TRIGGER journal_entry_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF carrier_id ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
CREATE TRIGGER opening_settlement_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF currency_id ON opening_settlement
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');
