-- Откат 0086: убираем реестр входных файлов и состояние попытки загрузки.
--
-- Что теряется. Перечень принятых файлов и их конечные состояния, включая
-- отметки ручного разрешения (resolved_at/manual_document_id), а также история
-- попыток загрузки. Уже созданные документы не страдают: они живут в
-- source_documents и на реестр не ссылаются.
--
-- Откатывать имеет смысл только вместе с кодом: воркер новой версии читает
-- входы пакета из bundle_import_items и без этих колонок обработает лишь те
-- пакеты, у которых ещё жива служебная запись с attachments.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0086_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0086>';

ALTER TABLE "job_outbox" DROP COLUMN IF EXISTS "replace_terminal";
--> statement-breakpoint
DROP INDEX IF EXISTS "bundle_import_items_unresolved_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "bundle_import_items_input_file_unique";
--> statement-breakpoint
ALTER TABLE "bundle_import_items"
  DROP COLUMN IF EXISTS "manual_document_id",
  DROP COLUMN IF EXISTS "resolved_by_user_id",
  DROP COLUMN IF EXISTS "resolved_at",
  DROP COLUMN IF EXISTS "effective_status",
  DROP COLUMN IF EXISTS "sub_bundle_id",
  DROP COLUMN IF EXISTS "upload_generation",
  DROP COLUMN IF EXISTS "size_bytes",
  DROP COLUMN IF EXISTS "mime_type",
  DROP COLUMN IF EXISTS "input_s3_key";
--> statement-breakpoint
DROP TABLE IF EXISTS "bundle_upload_attempts";
--> statement-breakpoint
ALTER TABLE "source_bundles" DROP COLUMN IF EXISTS "active_upload_generation";
