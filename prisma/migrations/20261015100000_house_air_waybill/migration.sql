-- ===========================================================================
-- DOCUMENTATION — the House Air Waybill
-- docs/MODULE_DOCUMENTATION.md §14
-- ===========================================================================
--
-- An air booking has no container load plan (Menu I23, "No need CLP for Air
-- Shipment"): its advise is built from the confirmed cargo receipts, and its
-- bill is a House Air Waybill rather than a bill of lading. It is the same
-- bl_draft row, approved and issued through the same screens, and printed on
-- the client's own HAWB.
--
--   bl_draft
--     pre_carriage_by_mode_id, place_of_receipt   NOT NULL dropped. A waybill
--                    has neither box; the route still requires both on sea.
--     package_count, chargeable_weight_kg          new, nullable. The waybill's
--                    No. of Pieces and Chargeable Weight, pulled from the
--                    advise's totals and editable until approval.
--   notification_setting
--     awb_issuer_details                           new, nullable. The address
--                    and licence lines printed under the name on the HAWB.
--
-- Nothing is dropped or renamed, and every existing row already satisfies the
-- new CHECKs. RLS, grants and the audit triggers already cover both tables; the
-- tenant guard on pre_carriage_by_mode_id passes a NULL through.
--
-- The DDL is `prisma migrate diff` between the committed schema and this one,
-- with the two CHECKs below appended.
-- ===========================================================================

-- AlterTable
ALTER TABLE "notification_setting" ADD COLUMN     "awb_issuer_details" TEXT;

-- AlterTable
ALTER TABLE "bl_draft" ADD COLUMN     "chargeable_weight_kg" DECIMAL(18,3),
ADD COLUMN     "package_count" INTEGER,
ALTER COLUMN "pre_carriage_by_mode_id" DROP NOT NULL,
ALTER COLUMN "place_of_receipt" DROP NOT NULL;

-- ----------------------------------------------------------------- checks
-- A count of pieces and a weight are never negative. The schema refuses first;
-- these catch the write that goes round it.
ALTER TABLE "bl_draft" ADD CONSTRAINT "bl_draft_package_count_ck"
  CHECK ("package_count" IS NULL OR "package_count" >= 0);
ALTER TABLE "bl_draft" ADD CONSTRAINT "bl_draft_chargeable_weight_ck"
  CHECK ("chargeable_weight_kg" IS NULL OR "chargeable_weight_kg" >= 0);
