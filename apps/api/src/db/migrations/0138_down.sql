-- Откат 0138. Сначала флаг SUPPLIER_INN_CHECK=off и откат кода. Предупреждение
-- supplier_inn_unverified снимается из validation: прежний API не знает это
-- имя, и сериализатор ответа документа упал бы на таких строках.
UPDATE source_documents
   SET validation = jsonb_set(
         validation,
         '{warnings}',
         COALESCE(
           (SELECT jsonb_agg(w) FROM jsonb_array_elements(validation->'warnings') w
             WHERE w->>'name' <> 'supplier_inn_unverified'),
           '[]'::jsonb))
 WHERE validation->'warnings' @> '[{"name":"supplier_inn_unverified"}]';
--> statement-breakpoint
DROP INDEX IF EXISTS "edo_export_documents_document_date_idx";
--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "supplier_inn_check";
