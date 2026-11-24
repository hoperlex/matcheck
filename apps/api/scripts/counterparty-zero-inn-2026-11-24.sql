-- Строки counterparties с ИНН «0» → ИНН-заглушка «0000…» (жалоба 24.11, приёмка 27099).
--
-- До выпуска с миграцией 0156 выбор поставщика без ИНН в приёмке/отгрузке без
-- документа заводил строку с ИНН «0». Место «ИНН без КПП» у «0» одно на всю
-- таблицу: с 21.10 его заняла «СК "ЭСТ"» (fd041a39, приёмка 20904), и выбор
-- любого другого поставщика без ИНН отвечал 500. Новый код заводит строку с
-- заглушкой и ссылкой на запись справочника (supplier-counterparty.ts), а «0»
-- не пишет нигде. Скрипт переводит на заглушку то, что осталось от старого.
--
-- Что делает: каждая строка inn = '0' без КПП получает заглушку, updated_at =
-- now() и, если ровно у одной записи «Поставщиков» без ИНН то же имя (без учёта
-- регистра и пробелов по краям), ссылку supplier_directory_id на неё. На
-- 24.11 такая строка одна: fd041a39 → 1dbca13e «ООО "СТРОИТЕЛЬНАЯ КОМПАНИЯ
-- "ЭСТ"». Приёмки, которые на неё ссылаются, не меняются.
--
-- updated_at обязателен: /sync отдаёт контрагентов по updated_at, без сдвига
-- планшет, у которого строка уже сохранена, замену не получит.
--
-- Порядок: ПОСЛЕ выката API с миграцией 0156 (сверить BUILD_SHA). Раньше
-- нельзя: deploy.sh применяет миграции до переключения контейнеров, и старый
-- API, увидев свободное «0», завёл бы новую строку «0» с чужим именем. До
-- запуска скрипта ничего не ломается: «0» занят, старый API отвечает 500, как
-- и раньше, новый «0» не трогает.
--
-- Повторный запуск безопасен: строк «0» нет — NOTICE с нулями, ничего не
-- меняется. Все проверки внутри DO-блока: при расхождении — исключение и откат
-- всего. Совпадение заглушки с существующей (1 к 4·10⁹) тоже даёт исключение —
-- тогда просто запустить ещё раз.
--
-- Запуск: psql -v ON_ERROR_STOP=1 -f apps/api/scripts/counterparty-zero-inn-2026-11-24.sql
begin;
do $$
declare
  r record;
  dir uuid;
  same_name int;
  fixed int := 0;
  linked int := 0;
  rest int;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'counterparties'
       and column_name = 'supplier_directory_id'
  ) then
    raise exception 'нет колонки counterparties.supplier_directory_id — миграция 0156 не применена';
  end if;

  for r in
    select id, name, supplier_directory_id
      from counterparties
     where inn = '0' and kpp is null
     order by created_at, id
       for update
  loop
    dir := r.supplier_directory_id;
    if dir is null then
      -- «Без ИНН» — как в supplier-counterparty.ts: ни одной цифры или больше 12.
      select count(*), min(s.id::text)::uuid
        into same_name, dir
        from suppliers s
       where lower(btrim(s.name)) = lower(btrim(r.name))
         and (regexp_replace(s.inn, '\D', '', 'g') = ''
              or length(regexp_replace(s.inn, '\D', '', 'g')) > 12);
      if same_name <> 1 then dir := null; end if;
    end if;

    update counterparties
       set inn = '0000' || substr(md5(id::text || clock_timestamp()::text), 1, 8),
           supplier_directory_id = dir,
           updated_at = now()
     where id = r.id;
    fixed := fixed + 1;
    if dir is not null then linked := linked + 1; end if;
  end loop;

  select count(*) into rest from counterparties where inn = '0' and kpp is null;
  if rest <> 0 then raise exception 'строк с ИНН «0» без КПП осталось: %', rest; end if;

  raise notice 'строк с ИНН «0» переведено на заглушку: %, из них связано со справочником: %',
    fixed, linked;
end $$;
commit;
