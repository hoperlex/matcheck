-- Откат 0091: убираем режим обработки входного файла.
--
-- Что теряется. Признак «файл загружен во вторую зону формы и распознаваться не
-- должен». Сами файлы и строки реестра остаются; после отката все они выглядят
-- как auto, и повторный разбор пакета попытается их классифицировать.
--
-- Откатывать имеет смысл только вместе с кодом: воркер новой версии читает
-- processing_mode при каждом router-задании.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0091_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0091>';

ALTER TABLE "bundle_import_items" DROP COLUMN IF EXISTS "processing_mode";
