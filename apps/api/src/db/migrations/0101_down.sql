-- Откат 0101: удаляем УПД-промпт v10.
--
-- Перед откатом убедиться, что активен НЕ v10, иначе разбор останется без
-- активного промпта и упадёт с «Активный промпт для doc_kind=upd не найден»:
--   UPDATE prompts SET is_active = true WHERE doc_kind = 'upd' AND name = 'default v9';
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0101_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0101>';

DELETE FROM "prompts" WHERE "doc_kind" = 'upd' AND "name" = 'default v10' AND "is_active" = false;
