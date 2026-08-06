-- Откат 0085: убираем состояние второго прохода.
--
-- Теряется информация о заказанных и выполненных повторах. Документы, у которых
-- второй проход был в состоянии queued, после отката разберутся обычным
-- текстовым путём — данные не пострадают, повтор просто не состоится.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0085_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0085>';

DROP INDEX IF EXISTS "source_documents_second_pass_queued_idx";
--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "second_pass";
