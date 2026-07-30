-- Откат миграции 0074_bundle_model_expand.
--
-- НЕ зарегистрирован в meta/_journal.json и НЕ применяется автоматически —
-- scripts/migrate.ts берёт только файлы из журнала. Лежит здесь потому, что
-- ALTER TABLE не откатывается возвратом предыдущего образа: если после выката
-- expand-фазы понадобится вернуться, нужен явный DOWN.
--
-- Применять вручную и только пока writers НЕ переведены на новую модель
-- (этап 5): после их перевода откат означает потерю idempotency_key у пакетов,
-- созданных новым кодом.
--
--   psql "$DATABASE_URL" -1 -f apps/api/src/db/migrations/0074_down.sql
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash 0074>';
--
-- Порядок обратный созданию: сначала зависимые таблицы, потом колонки.

BEGIN;

DROP TABLE IF EXISTS "ingest_events";
DROP TABLE IF EXISTS "mail_routes";
DROP TABLE IF EXISTS "mail_attachments";
DROP TABLE IF EXISTS "mail_messages";
DROP TABLE IF EXISTS "mail_receipts";

-- source_mail_message_unique миграция 0074 НЕ трогает (сужение перенесено в
-- contract-фазу), поэтому и откатывать его здесь нечего.

ALTER TABLE "mail_accounts"
  DROP COLUMN IF EXISTS "sender_allowlist",
  DROP COLUMN IF EXISTS "default_contractor_id",
  DROP COLUMN IF EXISTS "default_direction",
  DROP COLUMN IF EXISTS "default_site_id",
  DROP COLUMN IF EXISTS "poll_lease_until",
  DROP COLUMN IF EXISTS "poll_lease_token",
  DROP COLUMN IF EXISTS "poll_lease_owner",
  DROP COLUMN IF EXISTS "uid_validity",
  DROP COLUMN IF EXISTS "poll_enabled",
  DROP COLUMN IF EXISTS "purpose";

-- Возврат типа безопасен: значения UID, не помещающиеся в int4, появляются
-- только при реальном поллинге, которого до этапа 9 нет.
ALTER TABLE "mail_accounts" ALTER COLUMN "last_uid" TYPE integer;

ALTER TABLE "source_documents"
  DROP COLUMN IF EXISTS "dispatch_generation",
  DROP COLUMN IF EXISTS "is_technical";

DROP INDEX IF EXISTS "source_bundles_parent_idx";
DROP INDEX IF EXISTS "source_bundles_idempotency_key_idx";

ALTER TABLE "source_bundles"
  DROP COLUMN IF EXISTS "dispatch_generation",
  DROP COLUMN IF EXISTS "parent_bundle_id",
  DROP COLUMN IF EXISTS "origin",
  DROP COLUMN IF EXISTS "idempotency_key",
  DROP COLUMN IF EXISTS "content_hash";

COMMIT;
