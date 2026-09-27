-- ===========================================================================
-- Customer and vendor openings: two columns, as the agent has
-- docs/MODULE_ACCOUNTS.md §14.14
-- ===========================================================================
--
-- The client, 2026-09-27: the agent's "We owe (Dr)" and "Agent owe (Cr)" give
-- the Receivable-Payable list the right answer, and the customer and vendor
-- should have the same two inputs in place of their one signed Opening
-- Balance.
--
-- A single signed figure asked the operator to know that a payable is
-- negative. Entered the natural way — a positive number for what we owe a
-- vendor — it showed up as money the vendor owed us. Two columns, each naming
-- its own side, cannot be entered backwards; and a party can now owe on one
-- account while being owed on another, which one figure could not say.
--
--   customer.opening_balance  ->  customer.we_owe      (what we owe them)
--                                 customer.customer_owe (what they owe us)
--   vendor.opening_balance    ->  vendor.we_owe
--                                 vendor.vendor_owe
--
-- The figures already on file move by the rule they were entered under
-- (20260819180000: "positive is owed to us"), so every party's balance reads
-- exactly as it did before this ran: a positive balance becomes what they owe
-- us, a negative one what we owe them, a zero neither. Nothing is guessed —
-- where a figure was entered with the wrong sign, the operator now corrects it
-- in a field that says which side it is on.
--
-- opening_balance is then dropped: every figure it held is in the new
-- columns, and a column nothing reads would only drift from them. The
-- currency column, its foreign key, its index and its tenant guard are kept
-- as they are — one currency for both figures, as on the agent.
-- ===========================================================================

ALTER TABLE "customer" ADD COLUMN "we_owe" DECIMAL(18,4);
ALTER TABLE "customer" ADD COLUMN "customer_owe" DECIMAL(18,4);
ALTER TABLE "vendor" ADD COLUMN "we_owe" DECIMAL(18,4);
ALTER TABLE "vendor" ADD COLUMN "vendor_owe" DECIMAL(18,4);

-- The move. The audit trigger records each row as a SYSTEM update.
UPDATE "customer" SET "customer_owe" = "opening_balance" WHERE "opening_balance" > 0;
UPDATE "customer" SET "we_owe" = -"opening_balance" WHERE "opening_balance" < 0;
UPDATE "vendor" SET "vendor_owe" = "opening_balance" WHERE "opening_balance" > 0;
UPDATE "vendor" SET "we_owe" = -"opening_balance" WHERE "opening_balance" < 0;

ALTER TABLE "customer" DROP CONSTRAINT "customer_opening_needs_currency";
ALTER TABLE "vendor" DROP CONSTRAINT "vendor_opening_needs_currency";
ALTER TABLE "customer" DROP COLUMN "opening_balance";
ALTER TABLE "vendor" DROP COLUMN "opening_balance";

-- A figure with no currency cannot be posted to a ledger — the agent's rule.
ALTER TABLE "customer" ADD CONSTRAINT "customer_opening_needs_currency"
  CHECK (("we_owe" IS NULL AND "customer_owe" IS NULL) OR "opening_currency_id" IS NOT NULL);
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_opening_needs_currency"
  CHECK (("we_owe" IS NULL AND "vendor_owe" IS NULL) OR "opening_currency_id" IS NOT NULL);

-- Each column names its side, so neither holds a negative figure.
ALTER TABLE "customer" ADD CONSTRAINT "customer_opening_not_negative"
  CHECK (COALESCE("we_owe", 0) >= 0 AND COALESCE("customer_owe", 0) >= 0);
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_opening_not_negative"
  CHECK (COALESCE("we_owe", 0) >= 0 AND COALESCE("vendor_owe", 0) >= 0);
