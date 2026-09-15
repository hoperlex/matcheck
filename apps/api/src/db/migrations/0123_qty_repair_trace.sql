-- След правила восстановления количества (domain/edo/qty-repair).
--
-- Зачем отдельные колонки, а не parse_error_details. Во-первых, после успешной
-- сверки parse_error_details обнуляется, а ветка подтверждённого дубля
-- заменяет его целиком — след правки в нём не переживёт ни того, ни другого.
-- Во-вторых, след нужен для ОТКАТА: без исходного количества, версии разбора и
-- состояния записи отменить правку нечем, а отменять придётся — правило
-- эвристическое.
--
-- Содержимое (jsonb): ruleVersion, mode, detectedAt, generation, docVersion и
-- entries[] с полями state ('observed' | 'applied' | 'reverted'), row, itemId,
-- kind, qtyFrom, qtyTo, price, sum, base, unit, okeiCode, blockedBy.
--
-- Колонки СЛУЖЕБНЫЕ: веб их не читает, в публичные контракты не входят, на
-- карточки, экраны и планшет не влияют.
--
-- НЕДЕСТРУКТИВНО: только новые nullable-колонки, существующие строки читаются
-- как NULL («правило по этому документу не работало»).

ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "qty_repair" jsonb;

ALTER TABLE "photo_recognized_items"
  ADD COLUMN IF NOT EXISTS "qty_repair" jsonb;

COMMENT ON COLUMN "source_documents"."qty_repair" IS
  'След правила восстановления количества: кандидаты и применённые правки с исходными значениями и версией разбора. NULL — кандидатов не было. Служебное поле, UI не читает.';
COMMENT ON COLUMN "photo_recognized_items"."qty_repair" IS
  'То же для результата распознавания фото документа. Версия разбора — updated_at снимка.';
