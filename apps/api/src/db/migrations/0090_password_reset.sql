-- Самообслуживаемый сброс пароля: заявка от пользователя + ссылка от админа.
--
-- Зачем. Забывший пароль мог только позвонить админу, тот придумывал пароль за
-- него и слал открытым текстом в мессенджер. Человек этот пароль не запоминал и
-- через неделю приходил снова. Теперь он задаёт пароль сам по одноразовой
-- ссылке, а админ лишь передаёт её любым удобным каналом.
--
-- Почему ДВЕ таблицы, а не одна. Заявка (публичная форма) и ссылка (действие
-- админа) — разные сущности с разным уровнем доверия. Если бы форма выпускала
-- токен сама, любой знающий чужой email бесконечно обнулял бы уже отправленную
-- человеку ссылку простым дёрганьем формы. Разделение делает это невозможным.

CREATE TABLE IF NOT EXISTS "password_reset_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  -- SET NULL, а не CASCADE: уволенного админа должно быть можно удалить, и
  -- историческая заявка этому мешать не должна.
  "resolved_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
-- Одна открытая заявка на пользователя: повторное «Забыли пароль?» обновляет
-- дату существующей, а не плодит строки.
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_requests_open_unique"
  ON "password_reset_requests" ("user_id")
  WHERE "resolved_at" IS NULL;
--> statement-breakpoint
-- Токен равносилен паролю: им захватывают аккаунт. Поэтому, в отличие от
-- share_tokens, открытым он не хранится — только sha256 для поиска и
-- AES-256-GCM-конверт для повторного показа админу.
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  -- Без DEFAULT: id генерируется приложением ДО шифрования, потому что входит
  -- в AAD конверта (buildAad('password_reset_tokens', id)).
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" varchar(64) NOT NULL,
  "token_encrypted" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_hash_unique"
  ON "password_reset_tokens" ("token_hash");
--> statement-breakpoint
-- Не более одной непогашенной ссылки на пользователя.
--
-- Предикат намеренно БЕЗ "expires_at > now()": PostgreSQL требует immutable
-- выражения в индексе, а now() меняется — с ним миграция просто не применится.
-- Плата за это: выдавая новую ссылку, приложение отзывает все неиспользованные
-- записи пользователя, включая уже протухшие, иначе упрётся в эту уникальность.
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_one_open"
  ON "password_reset_tokens" ("user_id")
  WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
