-- Откат 0088: убираем происхождение получателя.
--
-- Безопасно: колонка аддитивная, читатели обращаются к ней через nullable-поле
-- DTO. Но после отката RBAC-предикат в lib/contractor-scope.ts перестанет
-- отличать автоподстановку от выбора человека — сначала откатить код, потом
-- схему, иначе запросы упадут на несуществующей колонке.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0088_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0088>';

ALTER TABLE "source_documents"
  DROP CONSTRAINT IF EXISTS "source_documents_recipient_source_check";
--> statement-breakpoint
ALTER TABLE "source_documents"
  DROP COLUMN IF EXISTS "recipient_source";
