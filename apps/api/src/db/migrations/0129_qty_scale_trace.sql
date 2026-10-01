-- След строгого правила потери десятичной запятой в количестве (×1000).
-- Только nullable-поля: миграция совместима со старым API/worker и не
-- переписывает существующие документы.
-- Не ждём DDL-замок бесконечно: при длинной рабочей транзакции миграция
-- откатится, а действующий API продолжит работу. Повторить можно позже.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "qty_scale" jsonb;

ALTER TABLE "photo_recognized_items"
  ADD COLUMN IF NOT EXISTS "qty_scale" jsonb;

ALTER TABLE "source_document_items"
  ADD COLUMN IF NOT EXISTS "qty_read" numeric(18, 4);

COMMENT ON COLUMN "source_documents"."qty_scale" IS
  'След правила qty ×1000: наблюдения, применённые правки и исходные значения. Служебное поле.';
COMMENT ON COLUMN "photo_recognized_items"."qty_scale" IS
  'След правила qty ×1000 для распознавания фото. Служебное поле.';
COMMENT ON COLUMN "source_document_items"."qty_read" IS
  'Количество из ответа модели до qty-scale; NULL, если автоматическая правка не применялась.';
