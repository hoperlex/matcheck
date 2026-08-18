-- Надёжное восстановление заданий распознавания.
--
-- НЕДЕСТРУКТИВНО: добавляются только nullable/defaulted колонки и новая
-- append-only таблица. Существующие задания остаются поколением 0 и продолжают
-- обрабатываться прежними worker'ами во время rolling deploy.

ALTER TABLE "job_outbox"
  ADD COLUMN IF NOT EXISTS "parked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "superseded_at" timestamptz;
--> statement-breakpoint

DROP INDEX IF EXISTS "job_outbox_ready_idx";
CREATE INDEX IF NOT EXISTS "job_outbox_ready_idx"
  ON "job_outbox" ("next_attempt_at")
  WHERE "processing_at" IS NULL
    AND "parked_at" IS NULL
    AND "superseded_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "recovery_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "job_id" text,
  ADD COLUMN IF NOT EXISTS "recovery_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- generation здесь остаётся поколением СБОРКИ. dispatch_generation —
-- независимое поколение попытки распознавания конкретного сегмента.
ALTER TABLE "bundle_segments"
  ADD COLUMN IF NOT EXISTS "dispatch_generation" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "recovery_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Append-only журнал попыток. Намеренно без FK: документ/пакет может быть
-- удалён при откате, а улика о зависании должна пережить удаление.
CREATE TABLE IF NOT EXISTS "recognition_dispatch_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "work_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "job_id" text NOT NULL,
  "event" text NOT NULL,
  "observed_state" text,
  "reason" text,
  "actor" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recognition_dispatch_events_entity_idx"
  ON "recognition_dispatch_events" ("work_type", "entity_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "recognition_evidence_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bundle_id" uuid NOT NULL,
  "source_document_id" uuid,
  "generation" integer NOT NULL,
  "evidence_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recognition_evidence_events_bundle_idx"
  ON "recognition_evidence_events" ("bundle_id", "generation", "created_at");
