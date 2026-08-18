DROP INDEX IF EXISTS "recognition_evidence_events_bundle_idx";
DROP TABLE IF EXISTS "recognition_evidence_events";

DROP INDEX IF EXISTS "recognition_dispatch_events_entity_idx";
DROP TABLE IF EXISTS "recognition_dispatch_events";

ALTER TABLE "bundle_segments"
  DROP COLUMN IF EXISTS "recovery_attempts",
  DROP COLUMN IF EXISTS "dispatch_generation";

ALTER TABLE "source_bundles"
  DROP COLUMN IF EXISTS "recovery_attempts",
  DROP COLUMN IF EXISTS "job_id";

ALTER TABLE "source_documents"
  DROP COLUMN IF EXISTS "recovery_attempts";

DROP INDEX IF EXISTS "job_outbox_ready_idx";
CREATE INDEX IF NOT EXISTS "job_outbox_ready_idx"
  ON "job_outbox" ("next_attempt_at")
  WHERE "processing_at" IS NULL;

ALTER TABLE "job_outbox"
  DROP COLUMN IF EXISTS "superseded_at",
  DROP COLUMN IF EXISTS "parked_at";
