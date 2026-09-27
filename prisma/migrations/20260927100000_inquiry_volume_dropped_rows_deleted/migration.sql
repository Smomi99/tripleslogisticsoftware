-- ===========================================================================
-- Volume rows an edit dropped are deleted, not left inactive
-- ===========================================================================
--
-- Editing an inquiry deactivated the grid rows the new input no longer had,
-- but every reader of the grid — the inquiry list and drawer, the quotation,
-- the shipment, the debit invoice, agent_inquiry_volume_v — filters on
-- deleted_at alone. So an inquiry switched from FCL to LCL went on showing its
-- old containers beside the new CBM. inquiry.route.ts now soft-deletes them;
-- this brings the rows already dropped into line.
--
-- Nothing else ever sets is_active = false on inquiry_volume: there is no
-- Active/Inactive toggle on a grid row, only the edit path. So an inactive,
-- undeleted row here is exactly one an edit dropped.
--
-- Soft delete only (§4 rule 3). Taking these rows out of the partial
-- once-per-size indexes cannot collide with anything; it only frees the slot.
-- The audit trigger records each one as a SYSTEM DELETE.
-- ===========================================================================

UPDATE "inquiry_volume"
   SET "deleted_at" = "updated_at"
 WHERE "is_active" = false
   AND "deleted_at" IS NULL;
