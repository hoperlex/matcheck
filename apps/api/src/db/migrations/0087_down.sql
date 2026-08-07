-- Откат 0087: возвращаем неуникальный индекс по idempotency_key.
--
-- Обычный индекс именно ВОССТАНАВЛИВАЕТСЯ, а не просто удаляется уникальный:
-- по нему идёт основной поиск пакета при каждой загрузке, и без него запросы
-- уедут в seq scan.
--
-- Данные не страдают: снимается только ограничение. Но откатывать имеет смысл
-- вместе с кодом — новый код рассчитывает на уникальность ключа при разрешении
-- конфликта вставки.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0087_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0087>';

DROP INDEX IF EXISTS "source_bundles_idempotency_key_unique";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "source_bundles_idempotency_key_idx"
  ON "source_bundles" ("idempotency_key");
--> statement-breakpoint

DROP INDEX IF EXISTS "source_bundles_content_hash_idx";
