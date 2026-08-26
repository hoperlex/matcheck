-- УПД-промпт v17: то же правило про графу 4, но БЕЗ арифметической самопроверки.
--
-- Зачем ещё одна версия. v16 повторила дефект v15 слово в слово: на боевом фото
-- УПД № 328 количество 1140 стало единицей, а 1 140 000 уехало в цену. При этом
-- стоимость и НДС модель прочитала верно — портятся ровно те два поля, что
-- названы в инструкции «умножь количество на цену».
--
-- Счёт по прогонам на этом фото: v13 верна 6 раз из 6, v15 — 0 из 1, v16 — 0 из
-- 2. Разбросом модели это не объясняется. Правила про запятую в v16 нет вовсе,
-- значит остаётся единственное общее у v15 и v16, чего нет в v13:
-- ТРЕБОВАНИЕ ПЕРЕМНОЖИТЬ И СВЕРИТЬ. Похоже, указание считать заставляет модель
-- искать пару «цена x количество» и принимать большое число за цену, вместо
-- того чтобы просто прочитать колонку.
--
-- Поэтому v17 — тот же адрес графы, но БЕЗ единого слова про умножение,
-- сверку и проверку себя. Если дефект уйдёт, причина доказана и правило
-- остаётся в этом виде; если останется — виновато само упоминание цены в
-- хвосте промпта, и тогда промпт этот класс не лечит вовсе.
--
-- Наследует v13 напрямую (как и v16), НЕ v15: см. 0120.
--
-- Промпт заводится НЕАКТИВНЫМ. Проверка:
--   scripts/upd-prompt-ab.ts --base "default v13" --new "default v17" --details
--
-- Откат: 0121_down.sql.

INSERT INTO "prompts" ("doc_kind", "name", "content", "is_active")
SELECT
  'upd',
  'default v17',
  "content" || chr(10) || chr(10) ||
  '# Цена — это графа 4' || chr(10) || chr(10) ||
  'price берётся ТОЛЬКО из графы 4 «Цена (тариф) за единицу измерения»: там напечатана цена за одну единицу БЕЗ налога. Графа 9 («Стоимость товаров с налогом — всего») — это не цена, а стоимость всей строки целиком; её значение в price подставлять нельзя.' || chr(10) || chr(10) ||
  'Если графа 4 пуста или неразборчива — верни price: null. Пустое поле честнее вычисленного.',
  false
FROM "prompts"
WHERE "doc_kind" = 'upd' AND "name" = 'default v13';
--> statement-breakpoint

DO $$
DECLARE
  v17_count int;
  v17_extends_v13 int;
  added text;
  active_cnt int;
  active_name text;
BEGIN
  SELECT count(*) INTO v17_count
    FROM prompts WHERE doc_kind = 'upd' AND name = 'default v17';
  IF v17_count <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один промпт «upd / default v17», найдено %.', v17_count;
  END IF;

  SELECT count(*) INTO v17_extends_v13
    FROM prompts v17
    JOIN prompts v13 ON v13.doc_kind = 'upd' AND v13.name = 'default v13'
   WHERE v17.doc_kind = 'upd' AND v17.name = 'default v17'
     AND position(v13.content in v17.content) = 1
     AND v17.content <> v13.content;
  IF v17_extends_v13 <> 1 THEN
    RAISE EXCEPTION 'default v17 не является дословным расширением default v13.';
  END IF;

  SELECT substr(v17.content, length(v13.content) + 1) INTO added
    FROM prompts v17
    JOIN prompts v13 ON v13.doc_kind = 'upd' AND v13.name = 'default v13'
   WHERE v17.doc_kind = 'upd' AND v17.name = 'default v17';

  IF added NOT LIKE '%ТОЛЬКО из графы 4%' THEN
    RAISE EXCEPTION 'В default v17 нет указания на графу 4.';
  END IF;

  -- Суть эксперимента: в добавленной части не должно быть НИ СЛОВА про
  -- умножение и сверку. Именно они отличают v15/v16 от работающей v13.
  IF added LIKE '%умнож%' OR added LIKE '%Проверь себя%' OR added LIKE '%сойтись%'
     OR added LIKE '%совпасть%' OR added LIKE '%сверь%' THEN
    RAISE EXCEPTION 'В хвосте default v17 появилась арифметическая самопроверка — ровно то, что ломает разбор.';
  END IF;

  -- И ни слова про формат чисел: этим сломалась v15.
  IF added LIKE '%76,032%' OR added LIKE '%запят%' OR added LIKE '%разделител%' THEN
    RAISE EXCEPTION 'В хвосте default v17 появилось правило про формат чисел.';
  END IF;

  IF EXISTS (SELECT 1 FROM prompts WHERE doc_kind = 'upd' AND name = 'default v17' AND is_active) THEN
    RAISE EXCEPTION 'default v17 не должен активироваться миграцией.';
  END IF;

  SELECT count(*) INTO active_cnt FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_cnt <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один активный промпт «upd», найдено %.', active_cnt;
  END IF;

  SELECT name INTO active_name FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_name = 'default v17' THEN
    RAISE EXCEPTION 'default v17 не должен становиться активным в миграции.';
  END IF;
END $$;
