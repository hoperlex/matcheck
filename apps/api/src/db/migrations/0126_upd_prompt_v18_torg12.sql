-- УПД-промпт v18: адреса граф товарной накладной ТОРГ-12.
--
-- Зачем. Активная v13 описывает только форму УПД/счёта-фактуры (графы 1–11).
-- ТОРГ-12 (код по ОКУД 0330212) размечена иначе, и модель читает её по чужим
-- адресам: в цену и сумму попадает масса нетто из графы 10 («2886» при пустых
-- денежных графах), а номером документа становится номер транспортной
-- накладной из рамки в правом верхнем углу (боевой случай — накладная
-- 1002004449 от 21.09.2026: в ответе 10626044499, позиций ноль).
--
-- Количество здесь НЕ вычисляется промптом: модель только называет
-- напечатанное в графах 7 и 8, а перемножает их код (domain/edo/torg12-qty,
-- рубильник TORG12_QTY). Требование «посчитай и сверь» уже дважды ломало
-- чтение колонок — v15 и v16 против v13, см. 0120 и 0121.
--
-- Наследует v13 дословно, как и v17.
--
-- Промпт заводится НЕАКТИВНЫМ. Проверка:
--   scripts/upd-prompt-ab.ts --base "default v13" --new "default v18" --details
--
-- Откат: 0126_down.sql.

INSERT INTO "prompts" ("doc_kind", "name", "content", "is_active")
SELECT
  'upd',
  'default v18',
  "content" || chr(10) || chr(10) ||
  '# Товарная накладная ТОРГ-12' || chr(10) || chr(10) ||
  'Если в шапке документа напечатано «ТОВАРНАЯ НАКЛАДНАЯ» и «Форма по ОКУД 0330212», перед тобой форма ТОРГ-12. Её графы адресуются так:' || chr(10) || chr(10) ||
  '- docNumber — значение графы «Номер документа» в таблице рядом с «Дата составления». Номер транспортной накладной из рамки в правом верхнем углу бланка, коды «по ОКУД» и «по ОКПО», номер справки и номер договора поставки номером документа НЕ являются.' || chr(10) ||
  '- qtyPerPlace — графа 7 «Количество в одном месте», как напечатана.' || chr(10) ||
  '- places — графа 8 «Количество мест, штук», как напечатана.' || chr(10) ||
  '- massNetKg — графа 10 «Количество (масса нетто)», когда в ней стоит масса в килограммах.' || chr(10) ||
  '- qty — количество товара в единице измерения строки, если оно напечатано. Когда в графе 10 стоит масса в килограммах, а единица измерения товара другая (м2, м3, шт, пал), это масса, а не количество: верни qty: null и заполни massNetKg.' || chr(10) ||
  '- price — графа 11 «Цена, руб. коп.»; sum — графа 15 «Сумма с учётом НДС, руб. коп.»; vatRate — графа 13 «ставка, %»; vatSum — графа 14 «сумма НДС, руб. коп.».' || chr(10) ||
  '- Прочерк, знак «X» или пустая графа означают, что значения нет: верни null. Массу и количество мест в денежные поля не подставляй.' || chr(10) ||
  '- Строки «Итого» и «Всего по накладной» — итоги документа, отдельной позицией они не являются.',
  false
FROM "prompts"
WHERE "doc_kind" = 'upd' AND "name" = 'default v13';
--> statement-breakpoint

DO $$
DECLARE
  v18_count int;
  v18_extends_v13 int;
  added text;
  active_cnt int;
  active_name text;
BEGIN
  SELECT count(*) INTO v18_count
    FROM prompts WHERE doc_kind = 'upd' AND name = 'default v18';
  IF v18_count <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один промпт «upd / default v18», найдено %.', v18_count;
  END IF;

  SELECT count(*) INTO v18_extends_v13
    FROM prompts v18
    JOIN prompts v13 ON v13.doc_kind = 'upd' AND v13.name = 'default v13'
   WHERE v18.doc_kind = 'upd' AND v18.name = 'default v18'
     AND position(v13.content in v18.content) = 1
     AND v18.content <> v13.content;
  IF v18_extends_v13 <> 1 THEN
    RAISE EXCEPTION 'default v18 не является дословным расширением default v13.';
  END IF;

  SELECT substr(v18.content, length(v13.content) + 1) INTO added
    FROM prompts v18
    JOIN prompts v13 ON v13.doc_kind = 'upd' AND v13.name = 'default v13'
   WHERE v18.doc_kind = 'upd' AND v18.name = 'default v18';

  IF added NOT LIKE '%0330212%' THEN
    RAISE EXCEPTION 'В default v18 нет признака формы ТОРГ-12.';
  END IF;

  -- Ни слова про умножение и самопроверку: ровно этим ломались v15 и v16.
  IF added LIKE '%умнож%' OR added LIKE '%Проверь себя%' OR added LIKE '%сойтись%'
     OR added LIKE '%совпасть%' OR added LIKE '%сверь%' OR added LIKE '%перемнож%' THEN
    RAISE EXCEPTION 'В хвосте default v18 появилась арифметика — количество считает код, а не промпт.';
  END IF;

  IF EXISTS (SELECT 1 FROM prompts WHERE doc_kind = 'upd' AND name = 'default v18' AND is_active) THEN
    RAISE EXCEPTION 'default v18 не должен активироваться миграцией.';
  END IF;

  SELECT count(*) INTO active_cnt FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_cnt <> 1 THEN
    RAISE EXCEPTION 'Активных промптов upd должно остаться ровно один, найдено %.', active_cnt;
  END IF;

  SELECT name INTO active_name FROM prompts WHERE doc_kind = 'upd' AND is_active = true;
  IF active_name = 'default v18' THEN
    RAISE EXCEPTION 'Активным остался default v18 — миграция активность менять не должна.';
  END IF;
END $$;
