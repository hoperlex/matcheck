-- Откат 0099: убираем связь строки реестра с заглушкой.
--
-- resolved_at, проставленный категории «документ был и удалён», НЕ снимаем: это
-- утверждение о факте (документ существовал и удалён), оно верно независимо от
-- наличия колонки. Снять его — значит вернуть ситуацию, где repair пытается
-- воскресить удалённые документы.
--
-- Заглушки, созданные скриптом бэкфилла, эта миграция тоже не трогает: они
-- обычные документы с вложениями, и удалять их надо адресно, из интерфейса.
-- Найти их можно так:
--   SELECT id, original_filename, parse_error_code FROM source_documents
--    WHERE parse_error_code IN ('supplementary', 'not_processed');
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0099_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0099>';

DROP INDEX IF EXISTS "bundle_import_items_stub_document_idx";
--> statement-breakpoint
ALTER TABLE "bundle_import_items" DROP COLUMN IF EXISTS "stub_document_id";
