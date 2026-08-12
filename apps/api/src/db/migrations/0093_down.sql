-- Откат 0093: убираем индекс живых refresh-токенов сессии.
--
-- Что теряется. Ничего из данных — только скорость: revokeBySessionId (logout,
-- инвалидация сессии) снова начнёт сканировать всю refresh_tokens. На проде это
-- десятки МБ на каждый вызов, но функционально поведение не меняется.
--
-- Откат кода Фазы 1 сам по себе этого индекса не требует — он полезен и старой
-- версии refresh.ts. Отдельного смысла откатывать почти нет.
--
-- DROP INDEX без CONCURRENTLY берёт короткую эксклюзивную блокировку на
-- таблицу; на проде предпочтительно `DROP INDEX CONCURRENTLY` отдельным
-- запросом вне транзакции.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0093_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0093>';

DROP INDEX IF EXISTS "refresh_tokens_session_active_idx";
