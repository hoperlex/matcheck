-- Блок материалов, к которому привязана УПД из ЭДО: документ приёмки
-- (бумажная УПД или накладная). NULL — связь с приёмкой целиком, как раньше.
-- SET NULL: документ блока пропал — связь с приёмкой остаётся, чип уходит в шапку.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "delivery_edo_matches"
  ADD COLUMN "section_document_id" uuid REFERENCES "source_documents"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "delivery_edo_matches_section_idx" ON "delivery_edo_matches"("section_document_id") WHERE "section_document_id" IS NOT NULL;
