-- Откат 0083: убираем стороны документа.
--
-- Теряются распознанные покупатель и грузополучатель (в том числе имена без
-- ИНН, которых больше негде хранить). Бэкфилл buyer_id восстановим при
-- повторном накате — он считается из recipient_id.
--
-- В meta/_journal.json НЕ регистрируется и автоматически не применяется:
-- scripts/migrate.ts берёт только файлы из журнала. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0083_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0083>';

ALTER TABLE "source_documents"
  DROP COLUMN IF EXISTS "buyer_id",
  DROP COLUMN IF EXISTS "buyer_name_raw",
  DROP COLUMN IF EXISTS "consignee_id",
  DROP COLUMN IF EXISTS "consignee_name_raw";
