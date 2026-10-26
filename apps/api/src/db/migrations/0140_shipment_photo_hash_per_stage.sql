-- Одно и то же фото допустимо в обоих этапах одной отгрузки.
-- Идемпотентность по содержимому сохраняется внутри каждого этапа.
DROP INDEX IF EXISTS "shipment_photo_content_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_photo_content_unique"
  ON "shipment_photos" ("shipment_id", "stage", "content_hash")
  WHERE "content_hash" IS NOT NULL;
