-- Публичные share-ссылки на приёмки/отгрузки.
--
-- Сценарий: менеджер кликает в таблице иконку 🔗, сервер генерирует
-- уникальный токен (64 hex = 32 байта random). Менеджер копирует ссылку
-- и отправляет внешнему получателю (например, поставщику). Тот открывает
-- /share/{token} без авторизации и видит read-only карточку с фото и
-- материалами. Ссылка живёт 10 дней; можно отозвать раньше.
--
-- Безопасность фото: на публичной странице URL картинок указывает на
-- наш API (/share/{token}/photos/{id}), сервер сам подписывает S3 и
-- стримит байты — клиент не видит ни S3-домена, ни presigned URL.

CREATE TABLE IF NOT EXISTS "share_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_type" text NOT NULL CHECK ("entity_type" IN ('delivery', 'shipment')),
  "entity_id" uuid NOT NULL,
  -- 64 hex = 32 байта random (crypto.randomBytes). UNIQUE на колонку.
  "token" varchar(64) NOT NULL UNIQUE,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  -- Audit: сколько раз открыли ссылку и кто последний.
  "accessed_count" integer NOT NULL DEFAULT 0,
  "last_accessed_at" timestamp with time zone,
  "last_accessed_ip" text,
  "last_accessed_user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Поиск активных токенов для конкретной сущности (чтобы переиспользовать
-- существующий вместо создания дубля при повторном клике «Поделиться»).
CREATE INDEX IF NOT EXISTS "share_tokens_entity_active_idx"
  ON "share_tokens" ("entity_type", "entity_id")
  WHERE "revoked_at" IS NULL;

-- Быстрый lookup по токену в публичных endpoints.
-- UNIQUE constraint выше уже создаёт btree-индекс, отдельный не нужен.
