-- The four CLP actions the load plan adds (MODULE_CLP.md §6).
--
-- Shipped with the migration rather than left to `db:seed`, so a deploy that
-- adds the tables also adds the rights that guard them. The seed upserts the
-- same rows from the same code constant, so running it afterwards is a no-op.
--
-- Separate from the Phase B migration because that one is already applied
-- here, and editing an applied migration changes its checksum.
--
-- CANCEL, VIEW, CREATE, EDIT, TOGGLE_STATUS and EXPORT already exist on this
-- feature. EXPORT is the print document — §6 calls it PRINT, but every other
-- printable record in this registry exports, and one name for one act is worth
-- more than matching a heading.
INSERT INTO "permission" ("module", "feature", "action", "key", "updated_at")
VALUES
  ('OPERATION', 'OPERATION.CONTAINER_LOAD_PLAN', 'SPLIT',
   'OPERATION.CONTAINER_LOAD_PLAN.SPLIT', CURRENT_TIMESTAMP),
  ('OPERATION', 'OPERATION.CONTAINER_LOAD_PLAN', 'FINALISE',
   'OPERATION.CONTAINER_LOAD_PLAN.FINALISE', CURRENT_TIMESTAMP),
  ('OPERATION', 'OPERATION.CONTAINER_LOAD_PLAN', 'CANCEL',
   'OPERATION.CONTAINER_LOAD_PLAN.CANCEL', CURRENT_TIMESTAMP),
  ('OPERATION', 'OPERATION.CONTAINER_LOAD_PLAN', 'OVERRIDE_CAPACITY',
   'OPERATION.CONTAINER_LOAD_PLAN.OVERRIDE_CAPACITY', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
