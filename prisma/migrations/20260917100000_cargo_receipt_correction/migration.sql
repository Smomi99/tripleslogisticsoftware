-- ===========================================================================
-- Editing a confirmed cargo receipt
-- ===========================================================================
--
-- Client decision, 2026-09-17: a confirmed receipt with a mistake in it may be
-- edited, by a user holding OPERATION.CARGO_RECEIPT.EDIT, with a reason, until
-- the booking is on a live CLP. The CLP takes its cartons, weight and CBM from
-- confirmed receipts, so past that point the plan is what must change first.
--
-- Affects one table, cargo_receipt: three nullable columns, one FK, one CHECK.
-- No existing row changes. The receipt lines are edited in place; what they
-- held before is already in audit_log, whose row trigger fires on both tables.
--
-- The existing table-level GRANT SELECT, INSERT, UPDATE to ff_app covers the
-- new columns, and the tenant_isolation policy is per row, so neither is
-- restated here.

ALTER TABLE "cargo_receipt"
  ADD COLUMN "correction_reason" TEXT,
  ADD COLUMN "corrected_by"      BIGINT,
  ADD COLUMN "corrected_at"      TIMESTAMPTZ(6);

ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_corrected_by_fkey"
  FOREIGN KEY ("corrected_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- All three or none, and only on a confirmed receipt: an edit with no reason,
-- or a reason nobody gave, is not a record anyone can act on.
ALTER TABLE "cargo_receipt" ADD CONSTRAINT "cargo_receipt_correction_ck" CHECK (
  ("correction_reason" IS NULL AND "corrected_by" IS NULL AND "corrected_at" IS NULL)
  OR (
    "status" = 'CONFIRMED'
    AND "correction_reason" IS NOT NULL
    AND btrim("correction_reason") <> ''
    AND "corrected_by" IS NOT NULL
    AND "corrected_at" IS NOT NULL
  )
);
