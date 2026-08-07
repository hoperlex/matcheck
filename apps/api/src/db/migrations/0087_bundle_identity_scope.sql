-- Идентичность пакета = scope + содержимое.
--
-- Зачем. `bundle_hash` под глобальным UNIQUE хранил ЧИСТЫЙ хеш содержимого,
-- поэтому один и тот же комплект файлов физически не мог существовать в двух
-- пакетах. Загрузка того же УПД на другой объект или другую дату поставки
-- упиралась в чужую строку и получала отказ «эти же файлы уже загружены».
-- Отказ приходил даже тогда, когда документы прежнего пакета были удалены, —
-- на проде так и произошло: файл удалили, а загрузить его заново стало нельзя.
--
-- Код теперь пишет в `bundle_hash` хеш scoped-ключа (bundleIdentityHashOf), а
-- сравнение ПО СОДЕРЖИМОМУ живёт в `content_hash`. Сам UNIQUE на bundle_hash
-- сохраняется: он защищает от гонок и нужен другим каналам (накладные, почта,
-- дочерние пакеты), которые пишут туда свои значения.
--
-- Здесь только индексы:
--   1) content_hash — под поиск пакета-двойника (та же пачка в другом scope);
--      он нужен ради пометки менеджеру, а не ради переиспользования;
--   2) idempotency_key становится УНИКАЛЬНЫМ — это и есть канонический ключ
--      пакета, обещанный ещё в 0074. На проде 166 непустых значений, все
--      различны, поэтому индекс строится без конфликта. Частичный: пакеты
--      накладных и legacy-строки живут с NULL и под уникальность не подпадают.

CREATE INDEX IF NOT EXISTS "source_bundles_content_hash_idx"
  ON "source_bundles" ("content_hash")
  WHERE "content_hash" IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "source_bundles_idempotency_key_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "source_bundles_idempotency_key_unique"
  ON "source_bundles" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
