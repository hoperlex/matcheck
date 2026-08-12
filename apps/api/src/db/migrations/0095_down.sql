-- Откат 0095: убираем ИНН сторон документа.
--
-- Что теряется. ИНН, распознанные после выката: у сторон без FK на справочник
-- (грузополучатель без ИНН в графе 4 — обычное дело) восстановить их будет
-- неоткуда, кроме журнала llm_calls. У сторон с FK ИНН остаётся в справочнике,
-- и колонки в списке просто вернутся к однострочному виду.
--
-- Код откатывать обязательно вместе: DTO и все producers обращаются к этим
-- колонкам по имени, без них запросы упадут на 42703.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0095_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0095>';

ALTER TABLE "source_documents"
  DROP COLUMN IF EXISTS "supplier_inn_raw",
  DROP COLUMN IF EXISTS "buyer_inn_raw",
  DROP COLUMN IF EXISTS "consignee_inn_raw";
