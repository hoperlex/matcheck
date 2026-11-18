-- Повторная разметка «ручного вноса/выноса» после выката 0153.
--
-- deploy.sh применяет миграции (шаг 6) раньше, чем пересоздаёт контейнеры
-- (шаг 8), а между ними до 10 минут ждёт остановки воркера. Всё это время
-- старый API создаёт ручные записи планшета с is_manual = false. Скрипт
-- размечает их теми же условиями, что и 0153. Идемпотентен: повторный
-- запуск даёт нули.
--
-- Запуск (на hub, ПОСЛЕ deploy.sh):
--   psql -v ON_ERROR_STOP=1 -f apps/api/scripts/manual-entry-backfill.sql
--
-- Условия держать одинаковыми с миграцией 0153_manual_entry.sql.
begin;
do $$
declare
  n_marker integer;
  n_vehicle_form integer;
  n_shipments integer;
begin
  update deliveries
     set is_manual = true
   where is_manual = false
     and split_part(comment, E'\n', 1) = 'Ручной внос';
  get diagnostics n_marker = row_count;

  -- Номер «РУЧНОЙ ВНОС» / «ВНОС» — ручной и без комментария; «БН» — только
  -- вместе с пометкой «ручной внос» в комментарии.
  update deliveries
     set is_manual = true
   where is_manual = false
     and (
       (
         comment ilike '%ручной внос%'
         and upper(regexp_replace(coalesce(vehicle_plate, ''), '[^А-ЯЁA-Zа-яёa-z0-9]', '', 'g'))
             in ('БН', 'РУЧНОЙВНОС', 'БЕЗНОМЕРА')
       )
       or upper(regexp_replace(coalesce(vehicle_plate, ''), '[^А-ЯЁA-Zа-яёa-z0-9]', '', 'g'))
          in ('РУЧНОЙВНОС', 'ВНОС')
     );
  get diagnostics n_vehicle_form = row_count;

  update shipments
     set is_manual = true
   where is_manual = false
     and split_part(comment, E'\n', 1) = 'Ручной вынос';
  get diagnostics n_shipments = row_count;

  raise notice 'размечено: ручной внос по маркеру — %, через форму с машиной — %, ручной вынос — %',
    n_marker, n_vehicle_form, n_shipments;
end $$;
commit;
