-- Роль «Мониторинг» (monitor) + отметка проверки качества на приёмках/отгрузках.
--
-- Зачем: сотрудник контроля качества (web-only, read-only на данные) просматривает
-- все приёмки/отгрузки по всем объектам и ставит отметку проверки — «Проверено»
-- (approved) или «Есть замечания» (issues, с комментарием). Отметка ОРТОГОНАЛЬНА
-- операционному статусу (запись остаётся «Подтверждено МОЛ»), поэтому это отдельные
-- новые колонки по образцу confirmed_by_mol_* (миграция 0018), а НЕ новый статус в
-- цепочке. Guard переходов, фильтры отчётов и мобильный sync не затрагиваются.
--
-- Значение enum 'monitor' в этой миграции НЕ используется в DDL (колонки review_* —
-- varchar/uuid/timestamptz, не enum), поэтому ADD VALUE в одном файле с ALTER TABLE
-- безопасен (нет 55P04). Пользователи роли monitor заводятся позже, отдельно.
--
-- Все ADD COLUMN — nullable, DEFAULT NULL: существующие записи не меняются, влияния
-- на данные и на мобильного клиента нет. review_state=NULL = «не проверено».
--
-- Откат: колонки/индексы можно удалить; удалить value из enum PostgreSQL штатно не
-- умеет — при откате оставляем неиспользуемое значение.

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'monitor';
--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "review_state" varchar(16)
    CONSTRAINT "deliveries_review_state_check" CHECK ("review_state" IN ('approved','issues')),
  ADD COLUMN IF NOT EXISTS "review_note" text,
  ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "review_state" varchar(16)
    CONSTRAINT "shipments_review_state_check" CHECK ("review_state" IN ('approved','issues')),
  ADD COLUMN IF NOT EXISTS "review_note" text,
  ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_review_state_idx" ON "deliveries" ("review_state") WHERE "review_state" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_review_state_idx" ON "shipments" ("review_state") WHERE "review_state" IS NOT NULL;
