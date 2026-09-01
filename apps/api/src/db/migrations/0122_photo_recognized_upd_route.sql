-- Кэш распознавания фото-документа учится хранить результат УПД-ветки.
--
-- Зачем. Экран «Операции → Принятые → фото документа» разбирал ЛЮБУЮ бумагу
-- одним терпимым промптом, прошитым в коде. На УПД он систематически съезжает
-- по колонкам: количество берёт из графы 2 («Код по ОКЕИ»: 796 = шт), цену —
-- из подграфы «в одном месте», а сумму читает из графы 5 (без налога), тогда
-- как итог документа — из графы 9 (с налогом). За 30 дней это 653 строки с
-- расхождением, которое налоговой базой не объясняется.
--
-- Теперь УПД уходит в основной парсер (домен photos/recognize-upd.ts), а
-- накладные, ОС-2, М-15 и рукописные остаются на прежнем промпте. Хранить
-- результаты двух путей в одних полях нельзя: у них РАЗНАЯ налоговая база
-- items.sum. Отсюда `parser`.
--
-- НЕДЕСТРУКТИВНО: только новые колонки. `parser` — NOT NULL с дефолтом
-- 'photo_v1', потому что все существующие записи сделаны прежним путём.

ALTER TABLE "photo_recognized_items"
  ADD COLUMN IF NOT EXISTS "parser" varchar(16) NOT NULL DEFAULT 'photo_v1',
  ADD COLUMN IF NOT EXISTS "validation" jsonb,
  ADD COLUMN IF NOT EXISTS "vat_sum" numeric(20, 2),
  ADD COLUMN IF NOT EXISTS "items_count" integer;

COMMENT ON COLUMN "photo_recognized_items"."parser" IS
  'Путь разбора: photo_v1 (терпимый промпт накладных, items.sum БЕЗ налога) | upd_vision (основной УПД-парсер, items.sum С налогом).';
COMMENT ON COLUMN "photo_recognized_items"."validation" IS
  'Полный UpdValidation по этому результату (checks + warnings). NULL — сверки не было (ветка photo_v1).';
COMMENT ON COLUMN "photo_recognized_items"."vat_sum" IS
  'Общая сумма НДС по документу. Заполняется только веткой upd_vision.';
COMMENT ON COLUMN "photo_recognized_items"."items_count" IS
  'Всего наименований из бланка, если напечатано. Заполняется только веткой upd_vision.';
