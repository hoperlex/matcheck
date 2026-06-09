-- Симметричное к deliveries поле «Поставщик» у отгрузок. Используется
-- в шапке отгрузки на портале (рядом с «Откуда»/«Получатель»/«Госномер»/
-- «Водитель»/«Тип отгрузки»). Менеджер может выбрать поставщика из
-- Справочника → Поставщики; бэк апсертит counterparty по ИНН и кладёт
-- её id сюда. См. PATCH /api/v1/shipments/:id/supplier-from-directory.
--
-- Nullable: исторические отгрузки (transfer, writeoff, return) могут
-- вообще не иметь поставщика; обязательным поле НЕ делаем.

ALTER TABLE shipments
  ADD COLUMN supplier_id UUID REFERENCES counterparties(id) ON DELETE SET NULL;
