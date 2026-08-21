-- An inquiry's recipients are agents and CARRIERS, not customers.
--
-- The client corrected this after the first version shipped: Inbound still
-- picks agents, but Outbound picks carriers. A customer is who the inquiry is
-- for — inquiry.customer_id, untouched — never who you chase a rate from.
--
-- The two customer selections already recorded on INQ-2026-000005 have no
-- equivalent under the new rule: a customer is not a carrier, and guessing one
-- would be worse than losing the selection. They are removed. The inquiry's
-- notify_emails text is left exactly as typed, since it is free text and may
-- still be the addresses that were wanted.

DELETE FROM "inquiry_party_contact" WHERE "customer_pic_id" IS NOT NULL;
DELETE FROM "inquiry_party"         WHERE "customer_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- inquiry_party: customer -> carrier
-- ---------------------------------------------------------------------------
ALTER TABLE "inquiry_party" DROP CONSTRAINT "inquiry_party_one_side";
ALTER TABLE "inquiry_party" DROP CONSTRAINT "inquiry_party_customer_fkey";
DROP INDEX "inquiry_party_key";
ALTER TABLE "inquiry_party" DROP COLUMN "customer_id";

ALTER TABLE "inquiry_party" ADD COLUMN "carrier_id" BIGINT;

-- carrier is system-capable (tenant_id may be NULL), so a composite key is
-- impossible and §4 rule 10 is enforced by the trigger instead.
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_carrier_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER inquiry_party_carrier_id_tenant_guard
  BEFORE INSERT OR UPDATE OF "carrier_id" ON "inquiry_party"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');

ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_one_side"
  CHECK (("agent_id" IS NULL) <> ("carrier_id" IS NULL));
CREATE UNIQUE INDEX "inquiry_party_key"
  ON "inquiry_party" ("tenant_id", "inquiry_id", "agent_id", "carrier_id");
CREATE INDEX "inquiry_party_carrier_id_idx" ON "inquiry_party" ("carrier_id");

-- ---------------------------------------------------------------------------
-- inquiry_party_contact: customer_pic -> carrier_pic
-- ---------------------------------------------------------------------------
-- carrier_pic IS tenant-owned, so this one keeps a composite key.
CREATE UNIQUE INDEX "carrier_pic_tenant_id_id_key" ON "carrier_pic" ("tenant_id", "id");

ALTER TABLE "inquiry_party_contact" DROP CONSTRAINT "inquiry_party_contact_one_side";
ALTER TABLE "inquiry_party_contact" DROP CONSTRAINT "inquiry_party_contact_customer_pic_fkey";
DROP INDEX "inquiry_party_contact_key";
ALTER TABLE "inquiry_party_contact" DROP COLUMN "customer_pic_id";

ALTER TABLE "inquiry_party_contact" ADD COLUMN "carrier_pic_id" BIGINT;
ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_carrier_pic_fkey"
  FOREIGN KEY ("tenant_id", "carrier_pic_id") REFERENCES "carrier_pic"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_one_side"
  CHECK (("agent_pic_id" IS NULL) <> ("carrier_pic_id" IS NULL));
CREATE UNIQUE INDEX "inquiry_party_contact_key"
  ON "inquiry_party_contact" ("tenant_id", "inquiry_id", "agent_pic_id", "carrier_pic_id");
