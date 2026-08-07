-- Откат 0090: убираем самообслуживаемый сброс пароля.
--
-- Безопасно: обе таблицы новые, на них никто не ссылается. Но сначала откатить
-- код, потом схему — публичные роуты /api/v1/public/password-reset/* и админский
-- список упадут на несуществующих таблицах.
--
-- Уже выданные ссылки после отката перестают работать безвозвратно: расшифровать
-- их нечем, а строки удалены. Людям, которым ссылка отправлена, но ещё не
-- использована, пароль придётся сменить админским ключиком.
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0090_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0090>';

DROP TABLE IF EXISTS "password_reset_tokens";
--> statement-breakpoint
DROP TABLE IF EXISTS "password_reset_requests";
