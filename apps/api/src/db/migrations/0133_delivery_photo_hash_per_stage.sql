-- Одно и то же фото допустимо в обоих этапах одной приёмки.
-- Идемпотентность по содержимому сохраняется внутри каждого этапа.
DROP INDEX IF EXISTS "delivery_photo_content_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_photo_content_unique"
  ON "delivery_photos" ("delivery_id", "stage", "content_hash")
  WHERE "content_hash" IS NOT NULL;
