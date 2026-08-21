-- Who to notify when an Outbound lane has no live rate.
--
-- One row per workspace, edited from Settings. Its own table rather than
-- columns on tenant, because tenant is platform-owned (§4 rule 2 exempts it
-- from tenant_id) while this is the workspace's own configuration.

CREATE TABLE "notification_setting" (
  "tenant_id"         BIGINT NOT NULL,
  "id"                BIGSERIAL NOT NULL,
  "price_team_emails" TEXT,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  "created_by"        BIGINT,
  "updated_by"        BIGINT,
  CONSTRAINT "notification_setting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_setting_tenant_id_key" ON "notification_setting" ("tenant_id");

ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New tables do not inherit policies (§7A rule 2).
ALTER TABLE "notification_setting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_setting"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON TABLE "notification_setting" TO ff_app;
