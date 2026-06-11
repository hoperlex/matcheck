-- Связь распознанных УПД со справочником поставщиков (suppliers).
--
-- ЛОГИКА:
--   Поставщик из распознанного УПД (PDF/Excel/JPG/PNG) сравнивается со
--   справочником `suppliers` по ИНН (exact) или, если ИНН не совпал, по
--   нормализованному имени (fuzzy, порог Левенштейна ~0.9). Найденный —
--   переиспользуем (счётчик «Поставщики» не растёт). Не найденный — INSERT
--   в suppliers (счётчик увеличивается на 1). source_documents.supplier_directory_id
--   ссылается на эту строку. В counterparties для распознанных УПД больше
--   ничего не пишем — это разные сущности (Контрагенты ≠ Поставщики).
--
-- СОВМЕСТИМОСТЬ:
--   * Старая колонка source_documents.supplier_id (FK на counterparties.id) и
--     её данные НЕ ТРОГАЮТСЯ. Все исторические УПД продолжают работать через
--     неё. Старый индекс source_upd_dedup_idx тоже остаётся.
--   * Для новых распознанных УПД supplier_id = NULL, supplier_directory_id =
--     suppliers.id. DTO supplierName сервер собирает через COALESCE(suppliers.name,
--     counterparties.name) → для пользователя ничего не меняется.
--   * Мобильный клиент: supplierId в его DTO/Entity уже nullable, NULL — легитимное
--     значение. Передача данных не ломается.
--
-- БЕЗОПАСНОСТЬ:
--   * ADD COLUMN c default NULL не блокирует таблицу, не пересчитывает строки.
--   * Partial INDEX строится только по новым непустым (supplier_directory_id, ...).
--   * UNIQUE на suppliers.inn НЕ ДОБАВЛЯЕМ: в текущем seed (982 записи, импорт
--     из JSON заказчика) данные «грязные» — могут быть дубликаты ИНН и пустые
--     значения. Добавление UNIQUE требовало бы предварительной очистки данных,
--     а её мы не хотим делать в авто-миграции. Защиту от гонок при параллельной
--     загрузке УПД одного нового поставщика делаем на уровне приложения через
--     pg_advisory_xact_lock(hashtext(inn)).
--
-- ОТКАТ:
--   DROP INDEX source_upd_dedup_directory_idx;
--   ALTER TABLE source_documents DROP COLUMN supplier_directory_id;
--   (никаких данных не теряется — supplier_id остаётся ссылаться на counterparties).

ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "supplier_directory_id" uuid
  REFERENCES "suppliers"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_upd_dedup_directory_idx"
  ON "source_documents" ("supplier_directory_id", "doc_number", "doc_date")
  WHERE "kind" = 'upd'
    AND "supplier_directory_id" IS NOT NULL
    AND "doc_number" IS NOT NULL
    AND "doc_date" IS NOT NULL;
