-- Откат 0154: только индексы, данные не затрагиваются. Код от них не зависит,
-- без них возвращается прежняя скорость (полный перебор таблиц в сверке).
-- На живой базе удалять CONCURRENTLY, вне транзакции:
--   DROP INDEX CONCURRENTLY IF EXISTS "source_bundles_root_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "source_document_attachments_s3_key_idx";
-- Запись 0154 в журнале миграций при этом остаётся; вернуть индексы — тем же
-- scripts/create-indexes-online.ts.
DROP INDEX IF EXISTS "source_bundles_root_idx";
DROP INDEX IF EXISTS "source_document_attachments_s3_key_idx";
