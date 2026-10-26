DROP INDEX IF EXISTS "shipment_photo_content_unique";
CREATE UNIQUE INDEX "shipment_photo_content_unique"
  ON "shipment_photos" ("shipment_id", "content_hash")
  WHERE "content_hash" IS NOT NULL;
