-- Реестр выгрузки УПД из Диадока в хранилище — без карточек в портале.
--
-- Зачем отдельная таблица, а не журнал приёма edo_receipts. Журнал принадлежит
-- импорту: по нему движется курсор ленты, и строка «сохранено» в нём означает
-- «событие пройдено». Выгрузка, записавшая туда свои строки, навсегда отрезала
-- бы эти УПД от будущего импорта — claimEvent берёт только pending/failed, а
-- повторного разбора у ЭДО нет. Здесь выгрузка помнит своё и только своё.
--
-- seller_inns — все продавцы из XML, а не первый: после расширения списка УПД,
-- где в список попал второй продавец, иначе был бы ошибочно пропущен без
-- скачивания.
--
-- НЕДЕСТРУКТИВНО: одна новая таблица. FK на edo_accounts берёт короткий замок,
-- поэтому ждём его не дольше 5 секунд.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edo_export_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "edo_account_id" uuid NOT NULL REFERENCES "edo_accounts"("id") ON DELETE CASCADE,
  "message_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "counteragent_box_id" text,
  "document_type" text NOT NULL,
  "document_function" text,
  "document_number" text,
  "document_date" timestamp without time zone,
  "correction_number" text,
  "seller_inns" text[] DEFAULT '{}'::text[] NOT NULL,
  "supplier_inn" varchar(12),
  "supplier_name" text,
  "total_sum" numeric(18, 2),
  "vat_sum" numeric(18, 2),
  "items_count" integer,
  "content_category" text,
  "received_at" timestamp with time zone,
  "status" text NOT NULL,
  "last_error" text,
  "s3_key" text,
  "content_sha256" varchar(64),
  "size_bytes" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "edo_export_documents_status_check"
    CHECK ("status" IN ('stored', 'not_in_list', 'failed')),
  CONSTRAINT "edo_export_documents_stored_has_file"
    CHECK ("status" <> 'stored' OR ("s3_key" IS NOT NULL AND "content_sha256" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "edo_export_documents_entity_unique"
  ON "edo_export_documents" ("edo_account_id", "message_id", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edo_export_documents_inn_idx"
  ON "edo_export_documents" ("edo_account_id", "supplier_inn");
