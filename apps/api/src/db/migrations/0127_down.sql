-- Откат 0127. Возвращает каскадное удаление журнала вместе с документом —
-- то есть прежнее поведение, при котором записи о разборе накладных пропадают.
DROP INDEX IF EXISTS "recognition_evidence_events_created_at_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "llm_calls_bundle_idx";
--> statement-breakpoint
ALTER TABLE "llm_calls" DROP CONSTRAINT IF EXISTS "llm_calls_bundle_id_fkey";
--> statement-breakpoint
ALTER TABLE "llm_calls" DROP COLUMN IF EXISTS "bundle_id";
--> statement-breakpoint
ALTER TABLE "llm_calls" DROP CONSTRAINT IF EXISTS "llm_calls_source_document_id_fkey";
--> statement-breakpoint
ALTER TABLE "llm_calls"
  ADD CONSTRAINT "llm_calls_source_document_id_fkey"
  FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE CASCADE;
