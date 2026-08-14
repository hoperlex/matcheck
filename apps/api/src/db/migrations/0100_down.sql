-- Откат 0100: убираем состояние повтора, режим разбора, позицию в пакете и
-- право роли на повторное распознавание.
--
-- can_reparse снимается вместе с колонкой, поэтому отдельно откатывать UPDATE
-- не нужно: выданное monitor'у право живёт только в ней.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0100_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0100>';

ALTER TABLE "role_page_permissions" DROP COLUMN IF EXISTS "can_reparse";
--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "batch_index";
--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "parse_mode";
--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "reparse";
