-- MODULE_INQUIRY_QUOTATION.md §6.6 — the quotation's standing notes.
--
-- §6.6 lists three of them and is explicit about where they live: "Standard
-- notes, stored as editable tenant text, not hardcoded." They are commercial
-- terms — what the quotation is not, who pays the tax, when payment is due —
-- and a forwarder that words them differently must be able to say so without a
-- release.
--
-- Home: notification_setting, the tenant's one-row settings table. It already
-- carries signature_block, which the Shipping Order PDF reads as its
-- letterhead, so this table has quietly become the tenant's DOCUMENT settings
-- as well as its mail settings. The name is now narrower than the contents;
-- renaming it is a mechanical change worth doing on its own rather than
-- smuggling into a phase about a PDF.
--
-- Left NULL rather than backfilled. The product's own wording is the default
-- the settings screen offers and the PDF falls back to, so a workspace that
-- deliberately clears the notes gets none — which a backfill would have made
-- impossible to express.

ALTER TABLE "notification_setting" ADD COLUMN "quotation_notes" TEXT;

COMMENT ON COLUMN "notification_setting"."quotation_notes" IS
  'Standing notes printed on the quotation PDF (§6.6). Null means the product default.';
