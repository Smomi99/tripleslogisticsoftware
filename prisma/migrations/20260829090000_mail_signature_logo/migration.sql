-- The logos at the foot of an outgoing letter.
--
-- The client's signature carries three: their own mark, and the BAFFA and DP
-- Alliance memberships a freight forwarder is judged by. A carrier reading a
-- rate request looks for exactly those before deciding whether to answer, so
-- they are not decoration.
--
-- A table rather than three columns on notification_setting, because a
-- membership is a thing a company gains and loses. Three today is not three
-- forever, and a fourth should be an upload rather than a migration.
--
-- Only the storage key is held here, per §2 of the purchase spec: the bytes
-- live in object storage and the row points at them.
CREATE TABLE "mail_signature_logo" (
  "tenant_id"  BIGINT NOT NULL,
  "id"         BIGSERIAL PRIMARY KEY,
  "code"       VARCHAR(32) NOT NULL,
  "file_key"   VARCHAR(500) NOT NULL,
  -- What a reader with images switched off sees instead. Required, because a
  -- blocked image with no alt text is a blank box where a credential was.
  "alt_text"   VARCHAR(200) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  -- Rendered height. Logos arrive at wildly different pixel sizes and a
  -- signature wants them on one line, optically matched.
  "height_px"  INTEGER NOT NULL DEFAULT 40,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" BIGINT,
  "updated_by" BIGINT,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "mail_signature_logo_height_ck" CHECK ("height_px" BETWEEN 8 AND 200)
);

ALTER TABLE "mail_signature_logo" ADD CONSTRAINT "mail_signature_logo_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mail_signature_logo" ADD CONSTRAINT "mail_signature_logo_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mail_signature_logo" ADD CONSTRAINT "mail_signature_logo_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "mail_signature_logo_tenant_id_id_key" ON "mail_signature_logo" ("tenant_id", "id");
CREATE UNIQUE INDEX "mail_signature_logo_tenant_id_code_key" ON "mail_signature_logo" ("tenant_id", "code");
CREATE INDEX "mail_signature_logo_tenant_id_idx" ON "mail_signature_logo" ("tenant_id");

ALTER TABLE "mail_signature_logo" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mail_signature_logo"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "mail_signature_logo" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "mail_signature_logo_id_seq" TO ff_app;

-- §4 rule 7. Replacing the logo on outgoing company mail is a change somebody
-- should be answerable for.
CREATE TRIGGER "mail_signature_logo_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "mail_signature_logo"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
