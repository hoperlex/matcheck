-- Откат 0096: убираем происхождение позиций, поколения сборки, манифест и claim.
--
-- Что теряется безвозвратно:
--   * атрибуция позиций приёмок к УПД (колонки удаляются вместе со значениями);
--   * манифест сегментов — то есть знание, из каких страниц собран каждый
--     логический УПД. Сами документы и вложения остаются, пересобрать манифест
--     можно только повторным разбором;
--   * claim'ы групп: после отката одну поставку снова можно принять дважды.
--
-- Что НЕ теряется: сами документы, приёмки, позиции и связи delivery_sources.
--
-- Порядок отката. Сначала код, потом SQL: старый код о новых колонках не знает
-- и спокойно живёт с ними, а новый код без колонок уронит выборки приёмок и
-- документов. Обратный порядок опаснее.
--
-- ВНИМАНИЕ: после отката документы, чьи позиции лежат в приёмках, снова станут
-- удаляемыми (RESTRICT уходит вместе с колонкой). Если между накатом и откатом
-- кто-то отвязал УПД от приёмки, его удаление больше ничем не задержится —
-- позиции останутся сиротами без указания источника.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0096_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0096>';

DROP TABLE IF EXISTS "delivery_group_claims";
DROP TABLE IF EXISTS "bundle_segments";

ALTER TABLE "bundle_import_items" DROP COLUMN IF EXISTS "input_order";

ALTER TABLE "source_bundles" DROP COLUMN IF EXISTS "group_revision";
ALTER TABLE "source_bundles" DROP COLUMN IF EXISTS "published_generation";
ALTER TABLE "source_bundles" DROP COLUMN IF EXISTS "assembly_version";

DROP INDEX IF EXISTS "delivery_items_source_document_idx";
ALTER TABLE "delivery_items" DROP COLUMN IF EXISTS "source_document_item_id";
ALTER TABLE "delivery_items" DROP COLUMN IF EXISTS "source_document_id";
