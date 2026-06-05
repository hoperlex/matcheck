-- Этап отгрузки, к которому относится фото: 'before' — снято на 1-м этапе
-- (КПП, погрузка, документы перед выездом), 'after' — снято на 2-м этапе
-- (после подтверждения МОЛ). Зеркало миграции 0037 для delivery_photos,
-- которая ввела ту же семантику для приёмок. Источник истины — мобильный
-- клиент: знает экран, на котором инспектор нажал «Снять фото».
--
-- Default 'before':
-- 1) Все уже существующие shipment_photos логически относятся к 1-му этапу —
--    фичи «после» до этой миграции у отгрузки не было, capture'ы шли без
--    разметки (см. комментарий в DispatchStage1FormViewModel.kt:315 до этой
--    правки).
-- 2) Старые версии mobile/web, не присылающие stage в presign, продолжат
--    работать без изменений.
CREATE TYPE "shipment_photo_stage" AS ENUM ('before', 'after');

ALTER TABLE "shipment_photos"
  ADD COLUMN "stage" "shipment_photo_stage" NOT NULL DEFAULT 'before';
