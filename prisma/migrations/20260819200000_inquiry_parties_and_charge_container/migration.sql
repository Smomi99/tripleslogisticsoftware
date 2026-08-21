-- Who an inquiry is sent to, and a container size on a local charge.
--
-- The client's rule: Inbound picks agents, Outbound picks customers; from those
-- you pick contacts; the contacts' addresses prefill an editable email list.
--
-- inquiry.customer_id is untouched. That is the party the inquiry is FOR; this
-- is who it goes to, and they are not the same question.

-- ---------------------------------------------------------------------------
-- 1. Composite unique keys the new foreign keys point at (§4 rule 10)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "agent_pic_tenant_id_id_key"    ON "agent_pic"    ("tenant_id", "id");
CREATE UNIQUE INDEX "customer_pic_tenant_id_id_key" ON "customer_pic" ("tenant_id", "id");

-- ---------------------------------------------------------------------------
-- 2. The recipients
-- ---------------------------------------------------------------------------
ALTER TABLE "inquiry" ADD COLUMN "notify_emails" TEXT;

CREATE TABLE "inquiry_party" (
  "tenant_id"   BIGINT NOT NULL,
  "id"          BIGSERIAL NOT NULL,
  "inquiry_id"  BIGINT NOT NULL,
  "agent_id"    BIGINT,
  "customer_id" BIGINT,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"  BIGINT,
  CONSTRAINT "inquiry_party_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inquiry_party_contact" (
  "tenant_id"       BIGINT NOT NULL,
  "id"              BIGSERIAL NOT NULL,
  "inquiry_id"      BIGINT NOT NULL,
  "agent_pic_id"    BIGINT,
  "customer_pic_id" BIGINT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"      BIGINT,
  CONSTRAINT "inquiry_party_contact_pkey" PRIMARY KEY ("id")
);

-- Exactly one side, never both and never neither. Without this a row could
-- name an agent AND a customer, and no screen would know which it meant.
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_one_side"
  CHECK (("agent_id" IS NULL) <> ("customer_id" IS NULL));
ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_one_side"
  CHECK (("agent_pic_id" IS NULL) <> ("customer_pic_id" IS NULL));

CREATE UNIQUE INDEX "inquiry_party_key"
  ON "inquiry_party" ("tenant_id", "inquiry_id", "agent_id", "customer_id");
CREATE UNIQUE INDEX "inquiry_party_contact_key"
  ON "inquiry_party_contact" ("tenant_id", "inquiry_id", "agent_pic_id", "customer_pic_id");
CREATE INDEX "inquiry_party_tenant_id_idx"          ON "inquiry_party" ("tenant_id");
CREATE INDEX "inquiry_party_inquiry_id_idx"         ON "inquiry_party" ("inquiry_id");
CREATE INDEX "inquiry_party_contact_tenant_id_idx"  ON "inquiry_party_contact" ("tenant_id");
CREATE INDEX "inquiry_party_contact_inquiry_id_idx" ON "inquiry_party_contact" ("inquiry_id");

ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_inquiry_fkey"
  FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_agent_fkey"
  FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_customer_fkey"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_inquiry_fkey"
  FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_agent_pic_fkey"
  FOREIGN KEY ("tenant_id", "agent_pic_id") REFERENCES "agent_pic"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_customer_pic_fkey"
  FOREIGN KEY ("tenant_id", "customer_pic_id") REFERENCES "customer_pic"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_party_contact" ADD CONSTRAINT "inquiry_party_contact_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New tables do not inherit policies (§7A rule 2).
ALTER TABLE "inquiry_party" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_party"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "inquiry_party_contact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_party_contact"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- These are rewritten wholesale when an inquiry is edited, the same way the
-- volume grid is, so ff_app needs DELETE here as it does on the join tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inquiry_party"         TO ff_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inquiry_party_contact" TO ff_app;

-- ---------------------------------------------------------------------------
-- 3. A local charge can name the container size it applies to
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_local_charge" ADD COLUMN "container_type_id" BIGINT;
ALTER TABLE "rate_local_charge" ADD CONSTRAINT "rate_local_charge_container_type_id_fkey"
  FOREIGN KEY ("container_type_id") REFERENCES "container_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "rate_local_charge_container_type_id_idx" ON "rate_local_charge" ("container_type_id");

-- container_type is system-capable, so the guard permits a NULL tenant_id
-- parent and rejects one belonging to another workspace (§4 rule 10).
CREATE TRIGGER rate_local_charge_container_type_id_tenant_guard
  BEFORE INSERT OR UPDATE OF "container_type_id" ON "rate_local_charge"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_type', 'container_type_id');
