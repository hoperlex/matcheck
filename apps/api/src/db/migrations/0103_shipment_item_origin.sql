-- Происхождение позиции отгрузки — зеркало §1 миграции 0096 для приёмок.
--
-- Зачем отдельной миграцией. 0096 завела source_document_id/source_document_item_id
-- только у delivery_items: поставка из нескольких УПД начиналась с приёмки. Но
-- отгрузка ходит по той же цепочке — Этап 1 собирает материалы всех документов
-- машины, — и без этих колонок все её позиции приезжают с происхождением NULL.
-- Портал не может разложить их по документам, а «Обновить форму» на планшете
-- не знает, чью строку убирать при изменении состава машины.
--
-- НЕДЕСТРУКТИВНО: только добавление nullable-колонок и частичного индекса.
-- Существующие строки остаются с NULL — это честное «происхождение неизвестно»
-- для всего, что оформлено до появления кода.

-- ON DELETE RESTRICT, как у приёмки: обнуление при удалении документа потеряло
-- бы ровно ту информацию, ради которой колонка заводится. Документ, чьи позиции
-- попали в отгрузку, удалять нельзя — только архивировать.
ALTER TABLE "shipment_items"
  ADD COLUMN IF NOT EXISTS "source_document_id" uuid REFERENCES "source_documents"("id") ON DELETE RESTRICT;

-- SET NULL, а не RESTRICT: повторный разбор документа удаляет и пересоздаёт
-- source_document_items (worker: DELETE ... WHERE source_document_id = ...), и
-- RESTRICT заблокировал бы переразбор. Сам документ при этом остаётся известен.
ALTER TABLE "shipment_items"
  ADD COLUMN IF NOT EXISTS "source_document_item_id" uuid REFERENCES "source_document_items"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "shipment_items_source_document_idx"
  ON "shipment_items" ("source_document_id")
  WHERE "source_document_id" IS NOT NULL;
