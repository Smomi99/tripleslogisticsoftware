-- CR-002 §9's right: who may change a container's cost split by hand.
--
-- Shipped with a migration rather than left to db:seed, the same way the other
-- four CLP actions were, so a deploy that enables the feature also adds the
-- right that guards it. The seed upserts the same row from the same code
-- constant, so running it afterwards is a no-op.
--
-- Separate from the consolidation migration because that one is already
-- applied here, and editing an applied migration changes its checksum.
--
-- Its own action rather than folding into EDIT: a manual split moves money
-- between different customers' invoices, which is not something everybody who
-- can edit a load plan should be able to do.
INSERT INTO "permission" ("module", "feature", "action", "key", "updated_at")
VALUES
  ('OPERATION', 'OPERATION.CONTAINER_LOAD_PLAN', 'OVERRIDE_COST',
   'OPERATION.CONTAINER_LOAD_PLAN.OVERRIDE_COST', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
