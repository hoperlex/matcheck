-- УПД-промпт v16: цена берётся из графы 4, а не из графы 9.
--
-- Зачем. За 30 дней 155 строк в 36 документах вернулись с ценой, включающей
-- НДС: количество, умноженное на цену, совпадает со стоимостью С НАЛОГОМ
-- (графа 9) вместо стоимости без налога (графа 5). Сам налог при этом выделен
-- верно, то есть документ обычный, а прочитана не та колонка. Пример — УПД
-- № 223379, где все девять строк завышены ровно на ставку.
--
-- ПОЧЕМУ ОТ v13, А НЕ ОТ v15. Это главный вывод предыдущей попытки. v15
-- добавляла правило про запятую в количестве («76,032 м³ — это 76.032»), хотя
-- в v13 уже написано, и написано ВЕРНО:
--     - Числа без пробелов как разделителей тысяч (12500 вместо «12 500»).
--     - Запятая в числах = десятичный разделитель (2,5 → 2.5).
-- Порядок здесь и решает: сначала убрать пробел, потом читать запятую. Новое
-- правило дало модели второе указание про ту же графу, и на фото УПД № 328 она
-- применила его напрямую: «1 140,000» стало количеством 1, а 1 140 000 уехало
-- в цену. Прогон это поймал: v13 читала 1140 × 1120 верно и стабильно дважды.
-- Вывод — дублировать работающее правило хуже, чем не трогать его вовсе.
-- Поэтому v16 наследует v13 и добавляет РОВНО ОДНО правило, про другую графу.
--
-- Чего в правиле сознательно НЕТ:
--   * ни слова про формат чисел — там, где v13 справляется, не вмешиваемся;
--   * нет формулировки «цена, равная стоимости, — признак ошибки»: она ломает
--     законный случай количества, равного единице (в корпусе таких 17 позиций,
--     цена там совпадает со стоимостью БЕЗ налога, и это верно);
--   * нет разрешения вычислять цену. Вычисленное значение выглядит достоверно
--     и потому опаснее пустого поля: подогнанную цену уже не отличить от
--     прочитанной.
--
-- Промпт заводится НЕАКТИВНЫМ. Включение — вручную в Администрирование →
-- Промпты, и только после прогона:
--   scripts/upd-prompt-ab.ts --base "default v13" --new "default v16" --details
--
-- Откат: 0120_down.sql.

INSERT INTO "prompts" ("doc_kind", "name", "content", "is_active")
SELECT
  'upd',
  'default v16',
  "content" || chr(10) || chr(10) ||
  '# Цена берётся из графы 4 — она БЕЗ налога' || chr(10) || chr(10) ||
  'В графе 4 напечатана цена за единицу БЕЗ НДС. Проверь себя перед ответом: умножь количество на цену. Результат обязан совпасть со стоимостью из графы 5 («без налога — всего»), а НЕ со стоимостью из графы 9 («с налогом — всего»). Совпало с графой 9 — значит ты прочитал колонку правее нужной: вернись к графе 4 и прочитай её значение.' || chr(10) || chr(10) ||
  'НЕ вычисляй цену делением: не дели графу 5 на количество и не убирай НДС из графы 9. Если графа 4 в документе пуста или неразборчива — верни price: null. Пустое поле честнее вычисленного: подогнанное число выглядит достоверно и потому опаснее.',
  false
FROM "prompts"
WHERE "doc_kind" = 'upd' AND "name" = 'default v13';
--> statement-breakpoint

DO $$
DECLARE
  v16_count int;
  v16_extends_v13 int;
  v16_has_rule int;
  v16_mentions_comma int;
  active_cnt int;
  active_name text;
BEGIN
  SELECT count(*) INTO v16_count
    FROM prompts WHERE doc_kind = 'upd' AND name = 'default v16';
  IF v16_count <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один промпт «upd / default v16», найдено %. Проверьте наличие default v13.', v16_count;
  END IF;

  -- Наследование именно от v13: если однажды кто-то соберёт v16 поверх v15,
  -- вместе с ней вернётся правило про запятую, на котором мы обожглись.
  SELECT count(*) INTO v16_extends_v13
    FROM prompts v16
    JOIN prompts v13 ON v13.doc_kind = 'upd' AND v13.name = 'default v13'
   WHERE v16.doc_kind = 'upd' AND v16.name = 'default v16'
     AND position(v13.content in v16.content) = 1
     AND v16.content <> v13.content;
  IF v16_extends_v13 <> 1 THEN
    RAISE EXCEPTION 'default v16 не является дословным расширением default v13.';
  END IF;

  SELECT count(*) INTO v16_has_rule
    FROM prompts
   WHERE doc_kind = 'upd' AND name = 'default v16'
     AND content LIKE '%умножь количество на цену%'
     AND content LIKE '%НЕ вычисляй цену делением%'
     AND content LIKE '%вернись к графе 4%';
  IF v16_has_rule <> 1 THEN
    RAISE EXCEPTION 'В default v16 отсутствует правило про графу 4.';
  END IF;

  -- Страховка от возврата дефекта v15: правил про запятую в количестве в
  -- добавленной части быть не должно.
  SELECT count(*) INTO v16_mentions_comma
    FROM prompts v16
    JOIN prompts v13 ON v13.doc_kind = 'upd' AND v13.name = 'default v13'
   WHERE v16.doc_kind = 'upd' AND v16.name = 'default v16'
     AND substr(v16.content, length(v13.content) + 1) LIKE '%76,032%';
  IF v16_mentions_comma <> 0 THEN
    RAISE EXCEPTION 'В хвосте default v16 появилось правило про запятую — именно оно сломало v15.';
  END IF;

  IF EXISTS (SELECT 1 FROM prompts WHERE doc_kind = 'upd' AND name = 'default v16' AND is_active) THEN
    RAISE EXCEPTION 'default v16 не должен активироваться миграцией.';
  END IF;

  SELECT count(*) INTO active_cnt FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_cnt <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один активный промпт «upd», найдено %.', active_cnt;
  END IF;

  SELECT name INTO active_name FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_name = 'default v16' THEN
    RAISE EXCEPTION 'default v16 не должен становиться активным в миграции.';
  END IF;
END $$;
