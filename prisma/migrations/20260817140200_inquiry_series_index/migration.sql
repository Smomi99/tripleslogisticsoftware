-- DropIndex
DROP INDEX "inquiry_tenant_id_series_year_idx";

-- RenameIndex
ALTER INDEX "inquiry_series_lookup" RENAME TO "inquiry_tenant_id_series_year_code_idx";
