-- Частичные индексы orphan-очистки фото переезжают с taken_at на created_at.
--
-- Зачем. С версии 1.0.33 планшет присылает собственное время съёмки, и
-- delivery_photos.taken_at / shipment_photos.taken_at перестают быть моментом
-- создания записи. У фото, снятого в офлайне вчера и попавшего на сервер
-- только что, taken_at сразу «старше часа» — job photoOrphanCleanup сочла бы
-- его сиротой и удалила бы запись раньше, чем клиент успеет сделать PUT в S3.
-- Поэтому запрос очистки переведён на created_at (момент presign), а индексы
-- должны это повторять, иначе почасовая job уходит в seq scan по таблицам фото.
--
-- Данные не меняются: только определение двух частичных индексов.

DROP INDEX IF EXISTS "delivery_photos_orphan_idx";
CREATE INDEX "delivery_photos_orphan_idx"
  ON "delivery_photos" ("created_at")
  WHERE "uploaded_at" IS NULL;

DROP INDEX IF EXISTS "shipment_photos_orphan_idx";
CREATE INDEX "shipment_photos_orphan_idx"
  ON "shipment_photos" ("created_at")
  WHERE "uploaded_at" IS NULL;
