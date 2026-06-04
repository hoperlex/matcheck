-- Чат внешний↔менеджер на публичных share-ссылках.
--
-- Сценарий: получатель ссылки (без логина) задаёт вопрос менеджеру через
-- форму на /share/{token}. Менеджер (автор ссылки) видит badge-уведомление
-- в портале, отвечает в Drawer-чате; ответ виден внешнему пользователю при
-- следующем polling/refresh.
--
-- Хранится навсегда (пока живёт сам share_token). Объём ничтожный: средняя
-- переписка ~5 КБ. При удалении токена сообщения уходят cascade.

CREATE TABLE IF NOT EXISTS "share_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "share_token_id" uuid NOT NULL
    REFERENCES "share_tokens"("id") ON DELETE CASCADE,
  -- 'external' — анонимный получатель ссылки; 'manager' — автор ссылки или
  -- админ/менеджер с доступом. Это критично для UX: разные bubble в чате.
  "sender_type" text NOT NULL CHECK ("sender_type" IN ('external', 'manager')),
  -- Для manager-сообщений — ссылка на users (для отображения ФИО/email).
  -- Для external — NULL (внешний пользователь не имеет аккаунта).
  "sender_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- Для external — введённое имя; для manager — NULL (берём из users).
  "sender_name" text,
  -- Для external — email из формы (для возможного email-фолоуапа в будущем).
  -- Никогда не возвращается в публичных GET-ответах, только в защищённых.
  "sender_email" text,
  "body" text NOT NULL,
  -- Для external — false до открытия чата менеджером. Для manager — всегда true.
  -- Используется только для счётчика «непрочитанных» (badge в шапке).
  "is_read" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Выборка переписки по треду (тред = share_token) с пагинацией по времени.
CREATE INDEX IF NOT EXISTS "share_messages_token_created_idx"
  ON "share_messages" ("share_token_id", "created_at");

-- Быстрый count непрочитанных по треду / по владельцу. Partial-индекс,
-- очень компактный — большинство сообщений быстро прочитываются.
CREATE INDEX IF NOT EXISTS "share_messages_unread_partial_idx"
  ON "share_messages" ("share_token_id")
  WHERE "is_read" = false AND "sender_type" = 'external';
