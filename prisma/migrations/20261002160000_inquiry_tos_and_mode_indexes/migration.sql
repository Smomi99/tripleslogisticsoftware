-- inquiry_mode_id_idx has indexed the wrong column since 20260825090000.
--
-- That migration swapped the meanings of inquiry.tos_id and inquiry.mode_id by
-- renaming the columns. An index follows its column through a RENAME COLUMN, so
-- the index that had been on mode_id ended up on tos_id still carrying the old
-- name — and the column now called mode_id was left with no index at all,
-- against §4 rule 8.
--
-- schema.prisma declares an index on each, so `prisma migrate dev` saw a
-- mode_id index on tos_id and generated a migration to drop and recreate it.
-- This gives the existing index the name of the column it actually covers and
-- builds the one mode_id never had. Nothing is dropped.
ALTER INDEX "inquiry_mode_id_idx" RENAME TO "inquiry_tos_id_idx";

CREATE INDEX "inquiry_mode_id_idx" ON "inquiry" ("mode_id");
