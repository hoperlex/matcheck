-- Единый вход «Загрузить документы» (router): журнал решений на каждый файл
-- пачки + признак типа пакета. Полностью аддитивно, без изменения существующих
-- данных и потоков.
--
-- СОВМЕСТИМОСТЬ:
--   * ADD COLUMN source_bundles.kind nullable — metadata-only change, старые
--     bundle получают NULL (их маршрут определяется job.data.mode, не kind).
--   * CREATE TABLE bundle_import_items — новая таблица, на старые потоки
--     (upload-upd-pdf / upload-waybill) не влияет.
--   * Никаких ALTER TYPE / enum — нет риска 55P04, ничего не блокируется.
--
-- ПРИНЦИП ДАННЫХ: неуверенно распознанные файлы остаются в bundle_import_items
-- со status='needs_review' и НЕ создают source_documents — операционные данные
-- не портятся «угаданным» типом.
--
-- ОТКАТ:
--   DROP TABLE bundle_import_items;
--   ALTER TABLE source_bundles DROP COLUMN kind;

ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bundle_import_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bundle_id" uuid NOT NULL REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "source_filename" text NOT NULL,
  "detected_kind" text,
  "confidence" numeric(4, 3),
  "parser_used" text,
  "status" text DEFAULT 'needs_review' NOT NULL,
  "reason" text,
  "created_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bundle_import_items_bundle_id_idx"
  ON "bundle_import_items" ("bundle_id");
