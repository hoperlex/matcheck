SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "delivery_edo_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "delivery_id" uuid NOT NULL REFERENCES "deliveries"("id") ON DELETE CASCADE,
  "source_document_id" uuid REFERENCES "source_documents"("id") ON DELETE RESTRICT,
  "export_document_id" uuid REFERENCES "edo_export_documents"("id") ON DELETE RESTRICT,
  "linked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "delivery_edo_matches_one_document_chk"
    CHECK (("source_document_id" IS NULL) <> ("export_document_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_edo_matches_source_unique" ON "delivery_edo_matches"("delivery_id", "source_document_id") WHERE "source_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_edo_matches_export_unique" ON "delivery_edo_matches"("delivery_id", "export_document_id") WHERE "export_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "delivery_edo_matches_source_idx" ON "delivery_edo_matches"("source_document_id") WHERE "source_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "delivery_edo_matches_export_idx" ON "delivery_edo_matches"("export_document_id") WHERE "export_document_id" IS NOT NULL;
