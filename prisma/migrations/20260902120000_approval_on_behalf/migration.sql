-- MODULE_BOOKING_CARGO.md §9 Q6, answered by the client on 2026-09-02.
--
-- The question was who approves a proposed schedule: the Booking List says
-- "when Customer approved the proposed vsl", but Shipment Approval also sits in
-- the internal Customer Service menu. The answer is both — a customer approves
-- their own, and C/S can record an approval that arrived by phone or email —
-- "with the actor recorded", which §5.3 had already assumed.
--
-- Recording the actor was already true: approved_by and decided_by are there.
-- What was missing is the difference between the two cases. "Approved by Rahim"
-- reads as the customer having agreed when Rahim is our own C/S desk, and that
-- is exactly the ambiguity somebody will argue about later.
--
-- Additive, defaulted, and false is the truthful value for every existing row:
-- nothing has been approved on anyone's behalf yet.

ALTER TABLE "shipment_po"
  ADD COLUMN "approved_on_behalf" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "shipment_schedule"
  ADD COLUMN "decided_on_behalf" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "shipment_po"."approved_on_behalf" IS
  'True when a C/S user recorded the customer''s decision rather than the customer making it (§9 Q6).';
COMMENT ON COLUMN "shipment_schedule"."decided_on_behalf" IS
  'True when a C/S user recorded the customer''s decision rather than the customer making it (§9 Q6).';
