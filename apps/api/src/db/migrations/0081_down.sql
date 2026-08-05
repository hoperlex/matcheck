-- Откат 0081: снимаем колонки публичной отправки с ingest_events.
--
-- Откатывать имеет смысл только вместе с кодом: после отката публичные роуты
-- (/api/v1/public/*) перестанут работать. Данные уже принятых публичных
-- отправок теряются — сами пакеты, документы и файлы в S3 остаются, пропадает
-- лишь атрибуция «от какого поставщика пришло».

DROP INDEX IF EXISTS "ingest_events_public_ticket_unique";
--> statement-breakpoint
ALTER TABLE "ingest_events"
  DROP COLUMN IF EXISTS "public_ticket",
  DROP COLUMN IF EXISTS "submitter_name",
  DROP COLUMN IF EXISTS "submitter_phone",
  DROP COLUMN IF EXISTS "submitter_ip",
  DROP COLUMN IF EXISTS "submitter_user_agent",
  DROP COLUMN IF EXISTS "submission_manifest";
