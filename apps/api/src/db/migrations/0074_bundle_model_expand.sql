-- Приём УПД из почты, этап 4 — EXPAND-фаза модели пакетов и почтовых сущностей.
--
-- Всё в этой миграции аддитивно и nullable, а `source_bundles_bundle_hash_unique`
-- ОСТАЁТСЯ на месте: старый образ обязан продолжать работать на новой схеме.
-- Ограничения (`SET NOT NULL`, `UNIQUE` на idempotency_key, снятие
-- bundle_hash_unique) навешивает отдельная contract-миграция — только после
-- того, как writers переведены и отработали в проде.
--
-- ЧТО ТРОГАЕТ ДАННЫЕ: backfill ниже пишет ТОЛЬКО в колонки, созданные этой же
-- миграцией (content_hash, idempotency_key, origin). Существующие поля не
-- переписываются, а новые до перевода writers никем не читаются.
--
-- Замеры на боевой БД (30.07.2026): 157 пакетов, все с bundle_hash/site_id/
-- direction, все 157 bundle_hash различны; 183 документа, все origin='manual_pdf';
-- технических записей (transport_waybill + bundle_id) — ноль; mail_accounts пуста.

-- ─── 1. source_bundles: новые колонки ──────────────────────────────────────
ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "origin" "source_origin",
  ADD COLUMN IF NOT EXISTS "parent_bundle_id" uuid REFERENCES "source_bundles"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "dispatch_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ─── 2. source_documents: технический флаг и поколение диспетчеризации ─────
-- is_technical заменяет эвристику «kind + наличие bundle»: у реальных ТН тот
-- же kind, поэтому по типу их различить нельзя.
ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "is_technical" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dispatch_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ─── 3. Backfill существующих пакетов ──────────────────────────────────────
-- Каноническая форма ключа. Этап 5 (createBundle) ОБЯЗАН строить её точно так
-- же, иначе исторические пакеты перестанут опознаваться как уже загруженные:
--   v1|manual|<site>|<direction>|<contractor>|<mol>|<expected>|<contentHash>
-- Пустые значения дают пустой сегмент — разделитель '|' сохраняет позиции.
UPDATE "source_bundles" SET
  "content_hash" = "bundle_hash",
  "origin" = 'manual_pdf',
  "idempotency_key" =
    'v1|manual|'
    || coalesce("site_id"::text, '') || '|'
    || "direction"::text || '|'
    || coalesce("contractor_id"::text, '') || '|'
    || coalesce("recipient_mol_id"::text, '') || '|'
    || coalesce(to_char("expected_date", 'YYYY-MM-DD'), '') || '|'
    || "bundle_hash"
WHERE "idempotency_key" IS NULL;
--> statement-breakpoint

-- Обычный индекс, НЕ unique: уникальность включает contract-миграция.
CREATE INDEX IF NOT EXISTS "source_bundles_idempotency_key_idx" ON "source_bundles" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_bundles_parent_idx" ON "source_bundles" ("parent_bundle_id") WHERE "parent_bundle_id" IS NOT NULL;
--> statement-breakpoint

-- ─── 4. mail_accounts: назначение ящика, поллинг, лиз ──────────────────────
-- last_uid: IMAP UID доходит до 2^32-1, int4 переполняется. Таблица пуста,
-- поэтому смена типа мгновенна.
ALTER TABLE "mail_accounts"
  ALTER COLUMN "last_uid" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "mail_accounts"
  ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'request',
  ADD COLUMN IF NOT EXISTS "poll_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "uid_validity" bigint,
  ADD COLUMN IF NOT EXISTS "poll_lease_owner" uuid,
  ADD COLUMN IF NOT EXISTS "poll_lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "poll_lease_until" timestamptz,
  ADD COLUMN IF NOT EXISTS "default_site_id" uuid REFERENCES "sites"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "default_direction" "source_direction",
  ADD COLUMN IF NOT EXISTS "default_contractor_id" uuid REFERENCES "counterparties"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "sender_allowlist" text[];
--> statement-breakpoint

-- ─── 5. mail_receipts — ТОЛЬКО транспорт ───────────────────────────────────
-- Строка создаётся ДО загрузки тела письма, поэтому у падения на fetch/MIME/S3
-- есть куда записать попытку. Терминальные состояния двигают watermark;
-- fetch_failed/parse_failed — только после исчерпания попыток.
CREATE TABLE IF NOT EXISTS "mail_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mail_account_id" uuid NOT NULL REFERENCES "mail_accounts"("id") ON DELETE CASCADE,
  "uid" bigint NOT NULL,
  "uid_validity" bigint NOT NULL,
  -- fetching | parsed | skipped_by_size | fetch_failed | parse_failed | vanished
  "status" text NOT NULL DEFAULT 'fetching',
  "rfc822_size" bigint,
  "raw_s3_key" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_receipts_uid_unique" ON "mail_receipts" ("mail_account_id", "uid_validity", "uid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_receipts_status_idx" ON "mail_receipts" ("mail_account_id", "status");
--> statement-breakpoint

-- ─── 6. mail_messages — ТОЛЬКО бизнес ──────────────────────────────────────
-- Строка создаётся для КАЖДОГО разобранного письма, включая ignored,
-- no_attachments и rejected_sender: иначе эти исходы негде хранить и письмо
-- пропадает из наблюдаемости.
--
-- message_hash — sha256 от СЫРОГО .eml, не от Message-ID: хеш по заголовку
-- позволил бы отправителю подделать Message-ID настоящего письма и добиться
-- того, что подлинный УПД молча отбросится как дубль.
CREATE TABLE IF NOT EXISTS "mail_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mail_account_id" uuid NOT NULL REFERENCES "mail_accounts"("id") ON DELETE CASCADE,
  "receipt_id" uuid REFERENCES "mail_receipts"("id") ON DELETE SET NULL,
  "message_hash" varchar(64) NOT NULL,
  "message_id_header" text,
  "from_address" text,
  "subject" text,
  "received_at" timestamptz,
  -- quarantined | resolving | ingested | rejected | ignored | no_attachments | rejected_sender
  "status" text NOT NULL DEFAULT 'quarantined',
  "reject_reason" text,
  "bundle_id" uuid REFERENCES "source_bundles"("id") ON DELETE SET NULL,
  "resolve_token" uuid,
  "resolve_started_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "suggested_site_id" uuid REFERENCES "sites"("id") ON DELETE SET NULL,
  "suggested_direction" "source_direction",
  "raw_s3_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_messages_hash_unique" ON "mail_messages" ("mail_account_id", "message_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_status_idx" ON "mail_messages" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_resolving_idx" ON "mail_messages" ("resolve_started_at") WHERE "status" = 'resolving';
--> statement-breakpoint

-- ─── 7. mail_attachments — нормализованно, не jsonb ────────────────────────
-- Отдельная таблица даёт FK, индексы и атомарный restore-attachment вместо
-- перезаписи json-массива.
CREATE TABLE IF NOT EXISTS "mail_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mail_message_id" uuid NOT NULL REFERENCES "mail_messages"("id") ON DELETE CASCADE,
  "idx" integer NOT NULL,
  "filename" text,
  "declared_mime" text,
  "sniffed_mime" text,
  "size_bytes" bigint NOT NULL DEFAULT 0,
  "sha256" varchar(64),
  "staging_s3_key" text,
  -- kept | suspected_signature | skipped | restored
  "state" text NOT NULL DEFAULT 'kept',
  "skip_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_attachments_message_idx_unique" ON "mail_attachments" ("mail_message_id", "idx");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_attachments_staging_key_idx" ON "mail_attachments" ("staging_s3_key") WHERE "staging_s3_key" IS NOT NULL;
--> statement-breakpoint

-- ─── 8. mail_routes — правила предзаполнения ───────────────────────────────
-- Матчинг по теме — substring/glob, НЕ regex (ReDoS на чужом вводе).
-- auto_process остаётся admin-only: manager через «запомнить маршрут» создаёт
-- правило только с auto_process = false.
CREATE TABLE IF NOT EXISTS "mail_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mail_account_id" uuid NOT NULL REFERENCES "mail_accounts"("id") ON DELETE CASCADE,
  -- from | subject
  "match_type" text NOT NULL,
  "match_value" text NOT NULL,
  "site_id" uuid REFERENCES "sites"("id") ON DELETE SET NULL,
  "direction" "source_direction",
  "contractor_id" uuid REFERENCES "counterparties"("id") ON DELETE SET NULL,
  "auto_process" boolean NOT NULL DEFAULT false,
  "priority" integer NOT NULL DEFAULT 100,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_routes_account_idx" ON "mail_routes" ("mail_account_id", "priority") WHERE "is_active" = true;
--> statement-breakpoint

-- ─── 9. ingest_events — provenance пакета ──────────────────────────────────
-- Один пакет может прийти вручную И несколькими письмами, поэтому одиночные
-- mail_account_id/message_id в самом пакете были бы неверны.
CREATE TABLE IF NOT EXISTS "ingest_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bundle_id" uuid NOT NULL REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  -- manual | mail
  "channel" text NOT NULL,
  "mail_message_id" uuid REFERENCES "mail_messages"("id") ON DELETE SET NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "cross_scope_of" uuid REFERENCES "source_bundles"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ingest_events_bundle_idx" ON "ingest_events" ("bundle_id", "created_at");
--> statement-breakpoint

-- ─── 10. Сужение уникальности писем-заявок — НЕ ЗДЕСЬ ──────────────────────
-- Сузить `source_mail_message_unique` до `… AND kind = 'request'` в этой
-- миграции нельзя, хотя план изначально помещал сужение сюда.
--
-- Причина проверена эмпирически: PostgreSQL сопоставляет ON CONFLICT с
-- частичным индексом по ТОЧНОМУ совпадению предиката, а не по логическому
-- следованию. Запрос с предикатом `mail_account_id is not null and kind =
-- 'request'` работает на суженном индексе, но падает с 42P10 на старом — и
-- наоборот. То есть код и индекс жёстко связаны, а deploy.sh накатывает схему
-- (шаг 4) РАНЬШЕ перезапуска контейнеров (шаг 6): в этом окне работающий
-- старый образ получал бы 42P10 на каждом письме.
--
-- Сужение — операция contract, а не expand, поэтому уезжает в contract-фазу,
-- где выполняется уже после перевода кода. До приёма писем с УПД (этап 9)
-- прежний индекс полностью корректен: единственный потребитель — заявки.

-- ─── 11. Гейт: миграция проходит целиком или откатывается ──────────────────
-- Вся миграция выполняется в одной транзакции (scripts/migrate.ts), поэтому
-- RAISE EXCEPTION здесь означает откат ВСЕХ изменений выше — частично
-- заполненного idempotency_key не остаётся.
DO $$
DECLARE
  nulls bigint;
  dups bigint;
BEGIN
  SELECT count(*) INTO nulls FROM source_bundles WHERE idempotency_key IS NULL;
  IF nulls > 0 THEN
    RAISE EXCEPTION 'backfill не заполнил idempotency_key у % пакетов', nulls;
  END IF;

  SELECT count(*) INTO dups FROM (
    SELECT idempotency_key FROM source_bundles GROUP BY idempotency_key HAVING count(*) > 1
  ) d;
  IF dups > 0 THEN
    RAISE EXCEPTION 'backfill дал % неуникальных idempotency_key — contract-миграция не пройдёт', dups;
  END IF;
END $$;
