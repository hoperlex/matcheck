-- Публичная загрузка документов поставщиком (страница /uploads).
--
-- Зачем в ingest_events, а не в source_bundles. Таблица событий приёма уже
-- спроектирована как «одна отправка»: на один пакет их может быть несколько
-- (ручная загрузка, письмо, публичная отправка от поставщика). Тикет на самом
-- пакете сломал бы повторную публичную отправку комплекта, который до этого
-- пришёл почтой: событие получило бы чужой тикет либо внутренний пакет задним
-- числом стал бы «публичным».
--
-- public_ticket — непрозрачный идентификатор обращения, единственное, что
-- поставщик получает наружу. Внутренний bundle_id ему не отдаётся: иначе
-- статус-эндпоинт принимал бы внутренние UUID и, зная чужой id, аноним мог бы
-- опрашивать состояние внутренних пакетов.
--
-- submission_manifest — имена файлов ИМЕННО ЭТОЙ отправки и вердикт входного
-- фильтра по каждому. Без него статус по новому тикету брал бы имена из
-- переиспользованного пакета: тот же комплект байтов мог быть загружен внутри
-- под другими именами, и публичная страница раскрыла бы внутреннее имя файла.
--
-- Значение source_origin намеренно НЕ добавляется: origin уходит мобильному
-- клиенту в /sync и сериализуется zod-схемой ответа списка документов, а
-- ALTER TYPE ... ADD VALUE необратим. Происхождение определяется наличием
-- события с channel='public'.

ALTER TABLE "ingest_events"
  ADD COLUMN IF NOT EXISTS "public_ticket" varchar(32),
  ADD COLUMN IF NOT EXISTS "submitter_name" text,
  ADD COLUMN IF NOT EXISTS "submitter_phone" text,
  ADD COLUMN IF NOT EXISTS "submitter_ip" text,
  ADD COLUMN IF NOT EXISTS "submitter_user_agent" text,
  ADD COLUMN IF NOT EXISTS "submission_manifest" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingest_events_public_ticket_unique"
  ON "ingest_events" ("public_ticket")
  WHERE "public_ticket" IS NOT NULL;
