-- Weight moves into the volume grid, per container size.
--
-- The client's wireframe puts "Weight in Kg" among the grid rows, and
-- inquiry_volume.weight_kg has carried it since the grid was built. The
-- inquiry-level column was the older, single-figure version of the same
-- question and now has no field on any screen.
--
-- Copy it onto volume rows that do NOT already state a weight. A row that does
-- is the more specific answer and wins — overwriting it would replace a figure
-- someone typed against a particular size with one typed for the whole
-- inquiry.
--
-- Where every row already states a weight, the inquiry-level figure has
-- nowhere to go and is dropped with the column. On the development database
-- that is one row: INQ-2026-000001 said 455554 at inquiry level while its only
-- volume row says 2121. The grid figure is the one every screen has been
-- showing since the grid landed, so it is the one kept.

UPDATE "inquiry_volume" v
   SET "weight_kg" = i."weight_kg"
  FROM "inquiry" i
 WHERE v."inquiry_id" = i."id"
   AND v."deleted_at" IS NULL
   AND v."weight_kg" IS NULL
   AND i."weight_kg" IS NOT NULL;

ALTER TABLE "inquiry" DROP COLUMN "weight_kg";
