-- Разрешаем одной УПД быть привязанной к нескольким приёмкам/отгрузкам
-- (сценарий «несколько поставок» — одна УПД на 50 тонн арматуры
-- приезжает 4-5 рейсами, каждый рейс = своя приёмка).
--
-- ЧТО МЕНЯЕМ:
--   - снимаем UNIQUE-индекс delivery_sources.source_document_id;
--   - снимаем UNIQUE-индекс shipment_sources.source_document_id.
--
-- ЧТО ОСТАЁТСЯ КАК БЫЛО:
--   - PRIMARY KEY (delivery_id, source_document_id) — не даёт дубль одной
--     и той же пары (две идентичные строки невозможны);
--   - то же для (shipment_id, source_document_id);
--   - FK на source_documents и deliveries/shipments — каскады прежние.
--
-- БЕЗОПАСНОСТЬ:
--   - Существующие связи 1:1 продолжают работать как раньше.
--   - В UI режим «несколько поставок» — явный тумблер; по умолчанию
--     модалка ведёт себя как раньше (фильтр unaccepted=true).
--   - Откат миграции (если в БД нет дубликатов sourceDocumentId)
--     возвращает UNIQUE индекс простой ALTER.

DROP INDEX IF EXISTS "delivery_sources_source_document_id_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "shipment_sources_source_document_id_unique";
