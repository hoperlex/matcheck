-- «Ручной внос» / «Ручной вынос» — явный вид операции (жалоба 16.11, приёмка 25454).
--
-- Планшет создаёт ручную запись одним этапом: сразу confirmed_mol, без машины,
-- без госномера и УПД. Флага в БД не было — только первая строка комментария
-- «Ручной внос» / «Ручной вынос», а её портал может стереть. Портал не отличал
-- такие записи и требовал госномер у всех, поэтому их нельзя было сохранить.
--
-- is_manual ставится ТОЛЬКО при создании записи (createDelivery/createShipment)
-- и дальше не меняется. Здесь — разметка истории:
--   * приёмки/отгрузки с маркером планшета в первой строке комментария;
--   * приёмки, которые инспектор провёл формой «с машиной», но с пометкой
--     «ручной внос» в комментарии и номером-заглушкой (БН / РУЧНОЙ ВНОС /
--     БЕЗ НОМЕРА) — решение владельца 18.11;
--   * приёмки с номером «РУЧНОЙ ВНОС» / «ВНОС» и без комментария (25945 и
--     ещё 14): номер сам говорит, что машины не было. «БН» без комментария
--     не размечаем — «без номера» бывает и у настоящей машины.
--
-- updated_at НЕ трогаем: иначе ~3,6 тыс. записей ушли бы дельтой в /sync
-- на планшеты. Портал перечитывает карточку при открытии.
--
-- Между этой миграцией и перезапуском API (deploy.sh, шаги 6→8) старый API
-- ещё создаёт ручные записи с false. После выката запустить идемпотентный
-- apps/api/scripts/manual-entry-backfill.sql — те же условия.
--
-- ADD COLUMN ... DEFAULT false — изменение только метаданных (PG 11+).
-- Откат: 0153_down.sql.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "is_manual" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "is_manual" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DO $$
DECLARE
  n_marker integer;
  n_vehicle_form integer;
  n_shipments integer;
BEGIN
  UPDATE "deliveries"
     SET "is_manual" = true
   WHERE "is_manual" = false
     AND split_part("comment", E'\n', 1) = 'Ручной внос';
  GET DIAGNOSTICS n_marker = ROW_COUNT;

  UPDATE "deliveries"
     SET "is_manual" = true
   WHERE "is_manual" = false
     AND (
       (
         "comment" ILIKE '%ручной внос%'
         AND upper(regexp_replace(coalesce("vehicle_plate", ''), '[^А-ЯЁA-Zа-яёa-z0-9]', '', 'g'))
             IN ('БН', 'РУЧНОЙВНОС', 'БЕЗНОМЕРА')
       )
       OR upper(regexp_replace(coalesce("vehicle_plate", ''), '[^А-ЯЁA-Zа-яёa-z0-9]', '', 'g'))
          IN ('РУЧНОЙВНОС', 'ВНОС')
     );
  GET DIAGNOSTICS n_vehicle_form = ROW_COUNT;

  UPDATE "shipments"
     SET "is_manual" = true
   WHERE "is_manual" = false
     AND split_part("comment", E'\n', 1) = 'Ручной вынос';
  GET DIAGNOSTICS n_shipments = ROW_COUNT;

  RAISE NOTICE '0153: ручной внос по маркеру — %, через форму с машиной — %, ручной вынос — %',
    n_marker, n_vehicle_form, n_shipments;
END $$;
