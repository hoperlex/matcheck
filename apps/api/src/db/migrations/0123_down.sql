-- Откат 0123: снять служебные колонки следа.
ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "qty_repair";
ALTER TABLE "photo_recognized_items" DROP COLUMN IF EXISTS "qty_repair";
