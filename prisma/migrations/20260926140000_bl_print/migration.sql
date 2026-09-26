-- ===========================================================================
-- DOCUMENTATION — BL Print (Menu K7)
-- docs/MODULE_DOCUMENTATION.md §13
-- ===========================================================================
--
-- The Menu sheet's chain (F22) ends "… SI Submission > BL Issue > Debit Note",
-- and BL Print is the screen where the bill is issued. Two things record it:
--
--   shipment_status  gains BL_ISSUED, after BL_DRAFTED — BL Print is a worklist
--                    of bookings like every other one in the product, and a
--                    worklist is this enum narrowed (§3.8's reasoning)
--   bl_draft         gains issued_at / issued_by — who issued the bill, and
--                    when. The date is printed on the originals.
--
-- Nothing is dropped, renamed or rewritten. Both columns are nullable and every
-- existing row satisfies both CHECKs the moment this runs.
--
-- The DDL is `prisma migrate diff` between the committed schema and this one,
-- with AFTER added to the enum value so it sorts beside BL_DRAFTED, and the two
-- CHECKs below appended.
-- ===========================================================================

-- AlterEnum
-- Not used anywhere in this migration: a value added by ALTER TYPE cannot be
-- used in the transaction that added it.
ALTER TYPE "shipment_status" ADD VALUE 'BL_ISSUED' AFTER 'BL_DRAFTED';

-- AlterTable
ALTER TABLE "bl_draft" ADD COLUMN     "issued_at" TIMESTAMPTZ(6),
ADD COLUMN     "issued_by" BIGINT;

-- CreateIndex
CREATE INDEX "bl_draft_issued_by_idx" ON "bl_draft"("issued_by");

-- AddForeignKey
ALTER TABLE "bl_draft" ADD CONSTRAINT "bl_draft_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------- checks
-- Who and when travel together, as they do for every other act on this row.
ALTER TABLE "bl_draft" ADD CONSTRAINT "bl_draft_issue_has_issuer"
  CHECK (("issued_at" IS NULL) = ("issued_by" IS NULL));

-- Only an approved bill is issued (§13.3 rule 1). The route refuses first; this
-- catches the write that goes round it.
ALTER TABLE "bl_draft" ADD CONSTRAINT "bl_draft_issue_needs_approval"
  CHECK ("issued_at" IS NULL OR "approved_at" IS NOT NULL);
