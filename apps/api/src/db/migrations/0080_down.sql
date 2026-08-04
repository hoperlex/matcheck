-- Откат 0080: возвращаем частичные индексы orphan-очистки на taken_at.
--
-- Безопасно и симметрично: данные ни в ту, ни в другую сторону не меняются,
-- откатывается только определение индексов. Откатывать имеет смысл вместе с
-- кодом — старый photoOrphanCleanup выбирает по taken_at.

DROP INDEX IF EXISTS "delivery_photos_orphan_idx";
CREATE INDEX "delivery_photos_orphan_idx"
  ON "delivery_photos" ("taken_at")
  WHERE "uploaded_at" IS NULL;

DROP INDEX IF EXISTS "shipment_photos_orphan_idx";
CREATE INDEX "shipment_photos_orphan_idx"
  ON "shipment_photos" ("taken_at")
  WHERE "uploaded_at" IS NULL;
