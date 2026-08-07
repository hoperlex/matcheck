-- Откат 0089: убираем отметку времени последней неудачи входа.
--
-- Безопасно: колонка аддитивная и читается только логикой паузы в
-- routes/auth.ts. Но сначала откатить код, потом схему — иначе login упадёт
-- на несуществующей колонке при первой же неверной попытке.
--
-- Сам счётчик failed_login_count не трогаем: он существовал и до 0089.
-- Учтите, что после отката кода вернётся и блокировка аккаунта на 30 минут,
-- поэтому накопленные значения счётчика стоит обнулить руками:
--   UPDATE users SET failed_login_count = 0, locked_until = NULL;
--
-- В meta/_journal.json НЕ регистрируется. Применять вручную:
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0089_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<sha256 файла 0089>';

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "last_failed_login_at";
