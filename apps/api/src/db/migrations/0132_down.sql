-- Откат 0132. Реестр edo_export_documents остаётся — снимаются только курсор,
-- журнал проходов, перепись и колонки повтора. Файлы в хранилище не трогаются.
DROP TABLE IF EXISTS "edo_export_census";
DROP INDEX IF EXISTS "edo_export_documents_box_idx";
DROP INDEX IF EXISTS "edo_export_documents_seller_inns_idx";
DROP INDEX IF EXISTS "edo_export_documents_retry_idx";
ALTER TABLE "edo_export_documents" DROP COLUMN IF EXISTS "next_retry_at";
ALTER TABLE "edo_export_documents" DROP COLUMN IF EXISTS "attempts";
DROP TABLE IF EXISTS "edo_export_runs";
DROP TABLE IF EXISTS "edo_export_cursors";
