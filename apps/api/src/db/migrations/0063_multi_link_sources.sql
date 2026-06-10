-- Разрешаем одной УПД быть привязанной к нескольким приёмкам/отгрузкам
-- (сценарий «несколько поставок» — одна УПД на 50 тонн арматуры
-- приезжает 4-5 рейсами, каждый рейс = своя приёмка).
--
-- ЧТО МЕНЯЕМ:
--   - снимаем UNIQUE-constraint delivery_sources.source_document_id;
--   - снимаем UNIQUE-constraint shipment_sources.source_document_id.
--
-- Drizzle через uniqueIndex(...) создал именно CONSTRAINT, а не отдельный
-- индекс — поэтому `DROP INDEX` падает на dependency check
-- (2BP01: cannot drop index ... because constraint ... requires it).
-- Правильный путь — `ALTER TABLE DROP CONSTRAINT`; Postgres сам
-- удаляет привязанный к constraint индекс.
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
--   - Откат: ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (если в БД нет
--     дубликатов sourceDocumentId).

ALTER TABLE "delivery_sources"
  DROP CONSTRAINT IF EXISTS "delivery_sources_source_document_id_unique";
--> statement-breakpoint
ALTER TABLE "shipment_sources"
  DROP CONSTRAINT IF EXISTS "shipment_sources_source_document_id_unique";
