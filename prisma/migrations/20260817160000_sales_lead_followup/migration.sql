-- CreateTable
CREATE TABLE "sales_lead_followup" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "followup_date" DATE NOT NULL,
    "contact_mode" "contact_mode" NOT NULL,
    "contact_person" VARCHAR(200),
    "notes" TEXT,
    "next_followup_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sales_lead_followup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_lead_followup_tenant_id_idx" ON "sales_lead_followup"("tenant_id");

-- CreateIndex
CREATE INDEX "sales_lead_followup_lead_id_idx" ON "sales_lead_followup"("lead_id");

-- CreateIndex
CREATE INDEX "sales_lead_followup_next_followup_date_idx" ON "sales_lead_followup"("next_followup_date");

-- AddForeignKey
ALTER TABLE "sales_lead_followup" ADD CONSTRAINT "sales_lead_followup_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lead_followup" ADD CONSTRAINT "sales_lead_followup_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "sales_lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lead_followup" ADD CONSTRAINT "sales_lead_followup_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lead_followup" ADD CONSTRAINT "sales_lead_followup_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (CLAUDE.md §7A rule 2). A lead's follow-up history is one company's
-- sales activity; new tables inherit no policy, so this is not optional.
ALTER TABLE "sales_lead_followup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_lead_followup"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
