-- Идентичность строки BillHub в справочнике поставщиков (импорт справочников,
-- scripts/import-directories.ts). У строк из сида 0055 id совпадает с ID
-- BillHub, а у строк, созданных распознаванием и обогащённых из BillHub по ИНН,
-- id свой — без отдельной колонки повторный импорт держался бы только на
-- уникальности ИНН. Уникальный индекс не даёт двум строкам справочника
-- претендовать на одну строку BillHub. Колонку заполняет импорт, не миграция.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE suppliers ADD COLUMN billhub_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX suppliers_billhub_id_uq ON suppliers (billhub_id) WHERE billhub_id IS NOT NULL;
