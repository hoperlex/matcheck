-- Журнал вызовов модели переживает удаление технической записи документа.
--
-- Зачем. Разбор пакета накладных (parseWaybillBatch) логируется на временную
-- запись source_documents, которую воркер после создания реальных документов
-- удаляет. Внешний ключ llm_calls.source_document_id был объявлен
-- ON DELETE CASCADE — вместе с техзаписью исчезала и запись журнала. На бою это
-- означает, что по накладным журнала нет: у документа № 20 144 (21.09.2026)
-- заполнены llm_provider_id и llm_confidence, то есть вызов был, а в llm_calls
-- за это окно нет ни одной записи transport_waybill.
--
-- Что делаем:
--   1. FK → ON DELETE SET NULL: запись остаётся, теряя лишь ссылку на удалённый
--      документ;
--   2. колонка bundle_id — по ней вызов находится и после того, как ссылка на
--      документ обнулилась (техзапись пакетного разбора одноразовая, а пакет
--      живёт);
--   3. индекс (bundle_id, created_at) — для выборки логов по пакету;
--   4. индекс recognition_evidence_events(created_at) — для ретенции: имеющийся
--      составной индекс начинается с bundle_id и для удаления по возрасту
--      бесполезен.
--
-- НЕДЕСТРУКТИВНО: новая nullable-колонка, два индекса и ослабление правила
-- удаления. Существующие строки не меняются; уже удалённые каскадом записи
-- миграция не восстанавливает.

ALTER TABLE "llm_calls" DROP CONSTRAINT IF EXISTS "llm_calls_source_document_id_fkey";
--> statement-breakpoint
ALTER TABLE "llm_calls"
  ADD CONSTRAINT "llm_calls_source_document_id_fkey"
  FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "llm_calls" ADD COLUMN IF NOT EXISTS "bundle_id" uuid;
--> statement-breakpoint
ALTER TABLE "llm_calls" DROP CONSTRAINT IF EXISTS "llm_calls_bundle_id_fkey";
--> statement-breakpoint
ALTER TABLE "llm_calls"
  ADD CONSTRAINT "llm_calls_bundle_id_fkey"
  FOREIGN KEY ("bundle_id") REFERENCES "source_bundles"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "llm_calls_bundle_idx" ON "llm_calls" ("bundle_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recognition_evidence_events_created_at_idx"
  ON "recognition_evidence_events" ("created_at");
--> statement-breakpoint

COMMENT ON COLUMN "llm_calls"."bundle_id" IS
  'Пакет, в рамках которого сделан вызов. Нужен потому, что у пакетного разбора source_document_id указывает на временную запись, удаляемую после разбора.';
