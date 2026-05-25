-- Убираем статус «Без документа» как отдельный код жизненного цикла.
-- Теперь признак «нет привязанной УПД» определяется через связку
-- delivery_sources / shipment_sources (sourceDocumentIds.length === 0)
-- и отрисовывается на фронте отдельным тегом, а статус процесса остаётся
-- ортогональным: not_filled / draft / filled / confirmed_mol.

-- Существующие записи со статусом no_document переводим в not_filled
-- (по решению пользователя — визуально сразу понятно, что требует внимания).
UPDATE "deliveries"
SET "status_id" = (
  SELECT "id" FROM "statuses"
  WHERE "entity_type" = 'delivery' AND "code" = 'not_filled'
)
WHERE "status_id" IN (
  SELECT "id" FROM "statuses"
  WHERE "entity_type" = 'delivery' AND "code" = 'no_document'
);

UPDATE "shipments"
SET "status_id" = (
  SELECT "id" FROM "statuses"
  WHERE "entity_type" = 'shipment' AND "code" = 'not_filled'
)
WHERE "status_id" IN (
  SELECT "id" FROM "statuses"
  WHERE "entity_type" = 'shipment' AND "code" = 'no_document'
);

DELETE FROM "statuses"
WHERE "entity_type" IN ('delivery','shipment') AND "code" = 'no_document';
