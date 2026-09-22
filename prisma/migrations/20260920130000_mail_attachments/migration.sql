-- ===========================================================================
-- What travelled with the letter
-- ===========================================================================
--
-- docs/MODULE_DOCUMENTATION.md §9. Until now nothing in the product could
-- attach a file to an email: the quotation sends a body and leaves its PDF to
-- a download link. A BL draft sent to a customer for confirmation with no BL
-- attached is half a letter, so the outbox learns to carry one.
--
-- Keys, not bytes. The rendered documents already go to the file store and
-- shipment_advise.pdf_file / bl_draft.pdf_file point at the same objects; an
-- outbox row is the record of a message, not a second copy of its contents.
-- Both documents are immutable once sent, so a key cannot come to mean
-- something else between being queued and being delivered.
--
-- Default '[]' so every existing row and every existing caller is unchanged.
-- ===========================================================================

ALTER TABLE "email_log" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
