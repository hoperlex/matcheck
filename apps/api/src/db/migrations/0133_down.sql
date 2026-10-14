DROP INDEX IF EXISTS "delivery_photo_content_unique";
CREATE UNIQUE INDEX "delivery_photo_content_unique"
  ON "delivery_photos" ("delivery_id", "content_hash")
  WHERE "content_hash" IS NOT NULL;
