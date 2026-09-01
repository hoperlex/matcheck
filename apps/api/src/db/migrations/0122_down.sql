-- Откат 0122.
--
-- ДЕСТРУКТИВНО в узком смысле: теряются признак пути разбора и сохранённые
-- сверки у фото, разобранных УПД-веткой. Сами позиции остаются, но после
-- отката интерфейс снова не сможет отличить сумму С налогом от суммы БЕЗ
-- налога — поэтому откат схемы делать только вместе с откатом кода
-- (PHOTO_RECOGNIZE_UPD_ROUTE=0 и выкладка предыдущей версии).

ALTER TABLE "photo_recognized_items"
  DROP COLUMN IF EXISTS "parser",
  DROP COLUMN IF EXISTS "validation",
  DROP COLUMN IF EXISTS "vat_sum",
  DROP COLUMN IF EXISTS "items_count";
