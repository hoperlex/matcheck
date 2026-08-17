-- Откат 0103: снять происхождение позиций отгрузки.
--
-- Данные теряются безвозвратно — восстановить, из какого документа пришла
-- позиция, после DROP уже неоткуда. Применять только если 0103 выкачена
-- ошибочно и код ею ещё не пользуется.

DROP INDEX IF EXISTS "shipment_items_source_document_idx";

ALTER TABLE "shipment_items" DROP COLUMN IF EXISTS "source_document_item_id";
ALTER TABLE "shipment_items" DROP COLUMN IF EXISTS "source_document_id";
