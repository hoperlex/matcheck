-- УПД-промпт v13: модель возвращает напечатанный номер позиции (графа 1).
--
-- Зачем. Целостность списка позиций сегодня проверить нечем: items_count
-- сверяется с надписью «Всего наименований», а её в бланках почти не бывает —
-- на бою за трое суток проверка выполнилась 17 раз из 360 и не поймала ни
-- одного случая. Именно поэтому потерянная строка в УПД 1708/10 (id 10763)
-- была видна только по суммам: наименования съехали на соседние позиции, одна
-- позиция пропала совсем.
--
-- Номер позиции напечатан в графе 1 всегда. Если модель возвращает его как
-- есть, код проверяет простую вещь: номера образуют 1..N без пропусков и
-- повторов (см. items_sequence в domain/edo/upd-validation.ts). Это признак,
-- не зависящий ни от формы бланка, ни от наличия итоговых надписей.
--
-- Запрет выдумывать номер здесь принципиален: если модель начнёт нумеровать
-- строки заново, проверка будет всегда сходиться и потеряет смысл.
--
-- Вся редакция v12 копируется дословно, добавляется только хвост. Промпт
-- заводится НЕАКТИВНЫМ: выкат ничего не меняет, включение — вручную в
-- Администрирование → Промпты и только после
--   scripts/upd-prompt-ab.ts --base "default v9" --new "default v13"
--   scripts/segment-prompt-ab.ts --dir <фото комплекта> --expected <эталон>
--
-- Откат: 0114_down.sql.

INSERT INTO "prompts" ("doc_kind", "name", "content", "is_active")
SELECT
  'upd',
  'default v13',
  "content" || chr(10) || chr(10) ||
  'Для каждой позиции возвращай поле rowNo — порядковый номер позиции, НАПЕЧАТАННЫЙ в графе 1 бланка. Бери его ровно таким, как он стоит в документе. Не нумеруй строки заново и не проставляй номера подряд от себя: если номер в графе 1 не читается или его нет, верни rowNo: null. По этим номерам сверяется целостность списка — пропуск или повтор означает, что строка потерялась или задвоилась.',
  false
FROM "prompts"
WHERE "doc_kind" = 'upd' AND "name" = 'default v12';
--> statement-breakpoint

DO $$
DECLARE
  v13_count int;
  v13_extends_v12 int;
  v13_has_rule int;
  v13_active int;
  active_cnt int;
  active_name text;
BEGIN
  SELECT count(*) INTO v13_count
    FROM prompts WHERE doc_kind = 'upd' AND name = 'default v13';
  IF v13_count <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один промпт «upd / default v13», найдено %. Проверьте наличие default v12.', v13_count;
  END IF;

  SELECT count(*) INTO v13_extends_v12
    FROM prompts v13
    JOIN prompts v12 ON v12.doc_kind = 'upd' AND v12.name = 'default v12'
   WHERE v13.doc_kind = 'upd' AND v13.name = 'default v13'
     AND position(v12.content in v13.content) = 1
     AND v13.content <> v12.content;
  IF v13_extends_v12 <> 1 THEN
    RAISE EXCEPTION 'default v13 не является дословным расширением default v12.';
  END IF;

  -- Без запрета «не нумеруй заново» правило бесполезно: самостоятельно
  -- проставленные номера всегда идут подряд, и проверка ничего не поймает.
  SELECT count(*) INTO v13_has_rule
    FROM prompts
   WHERE doc_kind = 'upd' AND name = 'default v13'
     AND content LIKE '%rowNo%'
     AND content LIKE '%НАПЕЧАТАННЫЙ в графе 1%'
     AND content LIKE '%Не нумеруй строки заново%';
  IF v13_has_rule <> 1 THEN
    RAISE EXCEPTION 'В default v13 отсутствует контракт поля rowNo.';
  END IF;

  SELECT count(*) INTO v13_active
    FROM prompts WHERE doc_kind = 'upd' AND name = 'default v13' AND is_active = true;
  IF v13_active <> 0 THEN
    RAISE EXCEPTION 'default v13 не должен активироваться миграцией.';
  END IF;

  SELECT count(*) INTO active_cnt
    FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_cnt <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один активный промпт «upd», найдено %.', active_cnt;
  END IF;

  SELECT name INTO active_name
    FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_name = 'default v13' THEN
    RAISE EXCEPTION 'default v13 не должен становиться активным в миграции.';
  END IF;
END $$;
