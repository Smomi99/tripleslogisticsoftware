-- Cancel quotation (client, 2026-10-29): who cancelled it, when, and why — the
-- columns a cancelled booking and a cancelled debit invoice carry.
--
-- quotation's RLS policy, grants and audit trigger cover the new columns as
-- they cover the rest of the row, so nothing else changes. CANCELLED counts as
-- live for quotation_live_revision_key: the number keeps exactly one issue
-- that is not superseded, and that issue is the cancelled one.

ALTER TABLE "quotation" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_by" BIGINT;

CREATE INDEX "quotation_cancelled_by_idx" ON "quotation"("cancelled_by");

ALTER TABLE "quotation" ADD CONSTRAINT "quotation_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cancelling says why and when, the way a cancelled booking and invoice do.
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_cancel_needs_reason"
  CHECK ("status" <> 'CANCELLED'
         OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) > 0 AND "cancelled_at" IS NOT NULL));
