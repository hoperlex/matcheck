-- Откат 0098: удаляем промпт М-15 v2.
--
-- Перед откатом убедиться, что активен НЕ v2, иначе разбор накладных
-- останется без активного промпта и упадёт с «Активный промпт для
-- doc_kind=m15 не найден»:
--   UPDATE prompts SET is_active = true WHERE doc_kind = 'm15' AND name = 'default v1';
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0098_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0098>';

DELETE FROM "prompts" WHERE "doc_kind" = 'm15' AND "name" = 'default v2' AND "is_active" = false;
