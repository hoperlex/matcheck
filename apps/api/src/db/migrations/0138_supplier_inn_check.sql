-- Проверка ИНН поставщика при распознавании (флаг SUPPLIER_INN_CHECK,
-- domain/sourceDocuments/supplier-inn-check.ts).
--
-- supplier_inn_check — след решения: как прочитала модель, что стало итогом и
-- откуда исправлено (реестр ЭДО / справочник). Пишется в shadow и on; в on
-- исправленный ИНН ложится и в supplier_inn_raw, поэтому исходное значение
-- живёт только здесь.
--
-- Индекс по дате реестра ЭДО: воркер ищет ту же УПД по дате, номеру и сумме
-- на каждом распознавании.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "supplier_inn_check" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edo_export_documents_document_date_idx"
  ON "edo_export_documents" (("document_date"::date))
  WHERE "document_date" IS NOT NULL;
