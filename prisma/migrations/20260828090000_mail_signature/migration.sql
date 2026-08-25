-- The sign-off on outgoing mail.
--
-- The client's own templates end with their company block — name, two office
-- addresses, phone, website. That block cannot live in the template text
-- itself: the seeded templates are shared rows (tenant_id NULL) that every
-- workspace on the server falls back to, and one company's Banani address
-- appearing under another company's rate request is the multi-tenancy failure
-- §7A exists to prevent.
--
-- So the template carries {{signature}} and the text lives here, beside the
-- price-team addresses that were already this table's job: tenant-owned,
-- editable on Settings → Notification, and empty until somebody fills it in.
ALTER TABLE "notification_setting"
  ADD COLUMN "signature_block" TEXT;
