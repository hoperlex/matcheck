ALTER TABLE "source_document_items" DROP COLUMN IF EXISTS "qty_read";
ALTER TABLE "photo_recognized_items" DROP COLUMN IF EXISTS "qty_scale";
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "qty_scale";
