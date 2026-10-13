-- Реестр УПД из ЭДО обновляется сам (выпуск A2).
--
-- edo_export_cursors — постоянный курсор ленты для автопрохода. Курсор
-- Диадока (IndexKey) действителен только для того же запроса: ящика, фильтров
-- и отсечки по времени. Поэтому вместе с ключом хранится вся идентичность
-- запроса; при её расхождении проход не читает ленту, пока курсор не сбросят
-- явно (удалением строки).
--
-- edo_export_runs — журнал проходов. По нему окно подбора говорит, когда реестр
-- проверялся в последний раз, а не «самое позднее время получения УПД».
-- scope отделяет полный проход (all) от выгрузки по списку (list) и переписи
-- (census): только полный проход делает реестр «проверенным».
--
-- edo_export_documents.attempts / next_retry_at — повтор неудачных выгрузок
-- отдельным проходом. Лента известный failed больше не перекачивает.
--
-- edo_export_census — перепись документов, которые выгрузка не берёт (сканы,
-- счета-фактуры, накладные), только по метаданным и без скачивания: кто из
-- поставщиков шлёт их вместо УПД.
--
-- НЕДЕСТРУКТИВНО: три новые таблицы, две колонки с константным значением по
-- умолчанию (без перезаписи таблицы) и индексы на таблице в ~11 тыс. строк.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edo_export_cursors" (
  "edo_account_id" uuid PRIMARY KEY NOT NULL REFERENCES "edo_accounts"("id") ON DELETE CASCADE,
  "box_id" text NOT NULL,
  "feed_query" text NOT NULL,
  "since" timestamp with time zone NOT NULL,
  "index_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edo_export_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "edo_account_id" uuid NOT NULL REFERENCES "edo_accounts"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "trigger" text NOT NULL,
  "outcome" text DEFAULT 'running' NOT NULL,
  "truncate_reason" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "feed_completed_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "index_key_before" text,
  "index_key_after" text,
  "events_seen" integer DEFAULT 0 NOT NULL,
  "stored" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "retried" integer DEFAULT 0 NOT NULL,
  "census" integer DEFAULT 0 NOT NULL,
  "error" text,
  CONSTRAINT "edo_export_runs_scope_check" CHECK ("scope" IN ('all', 'list', 'census')),
  CONSTRAINT "edo_export_runs_trigger_check" CHECK ("trigger" IN ('auto', 'script')),
  CONSTRAINT "edo_export_runs_outcome_check"
    CHECK ("outcome" IN ('running', 'completed', 'truncated', 'stopped', 'error')),
  CONSTRAINT "edo_export_runs_truncate_reason_check"
    CHECK ("truncate_reason" IS NULL OR "truncate_reason" IN ('limit', 'no_index_key'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edo_export_runs_account_idx"
  ON "edo_export_runs" ("edo_account_id", "started_at");
--> statement-breakpoint
ALTER TABLE "edo_export_documents" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "edo_export_documents" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edo_export_documents_retry_idx"
  ON "edo_export_documents" ("edo_account_id", "next_retry_at") WHERE "status" = 'failed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edo_export_documents_seller_inns_idx"
  ON "edo_export_documents" USING gin ("seller_inns");
--> statement-breakpoint
-- Окно подбора опознаёт отправителя скана по ящику: проверяются только ящики
-- найденных сканов, а не весь реестр.
CREATE INDEX IF NOT EXISTS "edo_export_documents_box_idx"
  ON "edo_export_documents" ("counteragent_box_id") WHERE "counteragent_box_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edo_export_census" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "edo_account_id" uuid NOT NULL REFERENCES "edo_accounts"("id") ON DELETE CASCADE,
  "message_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "document_type" text,
  "category" text NOT NULL,
  "document_number" text,
  "document_date" date,
  "number_source" text,
  "file_name" text,
  "content_size" bigint,
  "counteragent_box_id" text,
  "from_title" text,
  "total_sum" text,
  "message_has_utd" boolean NOT NULL,
  "received_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "edo_export_census_category_check" CHECK ("category" IN ('scan', 'invoice', 'waybill'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "edo_export_census_entity_unique"
  ON "edo_export_census" ("edo_account_id", "message_id", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edo_export_census_received_idx"
  ON "edo_export_census" ("received_at");
