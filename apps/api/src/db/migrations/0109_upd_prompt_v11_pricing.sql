-- УПД-промпт v11: различать напечатанную, отсутствующую и неясную стоимость.
--
-- Вся редакция v10 копируется дословно; добавляется только хвост про optional
-- поле pricing. Новая версия неактивна: до A/B прод продолжает работать на
-- прежнем промпте, а UPD_NO_PRICING_V1=0 не применяет даже корректный absent.

INSERT INTO "prompts" ("doc_kind", "name", "content", "is_active")
SELECT
  'upd',
  'default v11',
  "content" || chr(10) || chr(10) ||
  'ОБЯЗАТЕЛЬНО добавь в корневой JSON поле pricing: "printed", если в документе напечатана хотя бы одна цена/сумма; "absent", только если стоимостной части структурно нет во всём документе; "unclear", если графы стоимости есть, но прочитать их надёжно нельзя. Не используй "absent" для размытого или обрезанного изображения.',
  false
FROM "prompts"
WHERE "doc_kind" = 'upd' AND "name" = 'default v10';
--> statement-breakpoint
DO $$
DECLARE
  v11_count int;
  v11_extends_v10 int;
  v11_has_rule int;
  v11_active int;
BEGIN
  SELECT count(*) INTO v11_count
    FROM prompts WHERE doc_kind = 'upd' AND name = 'default v11';
  IF v11_count <> 1 THEN
    RAISE EXCEPTION 'Ожидался ровно один промпт «upd / default v11», найдено %. Проверьте наличие default v10.', v11_count;
  END IF;

  SELECT count(*) INTO v11_extends_v10
    FROM prompts v11
    JOIN prompts v10 ON v10.doc_kind = 'upd' AND v10.name = 'default v10'
   WHERE v11.doc_kind = 'upd' AND v11.name = 'default v11'
     AND position(v10.content in v11.content) = 1
     AND v11.content <> v10.content;
  IF v11_extends_v10 <> 1 THEN
    RAISE EXCEPTION 'default v11 не является дословным расширением default v10.';
  END IF;

  SELECT count(*) INTO v11_has_rule
    FROM prompts
   WHERE doc_kind = 'upd' AND name = 'default v11'
     AND content LIKE '%поле pricing:%'
     AND content LIKE '%"printed"%'
     AND content LIKE '%"absent"%'
     AND content LIKE '%"unclear"%';
  IF v11_has_rule <> 1 THEN
    RAISE EXCEPTION 'В default v11 отсутствует полный контракт pricing.';
  END IF;

  SELECT count(*) INTO v11_active
    FROM prompts
   WHERE doc_kind = 'upd' AND name = 'default v11' AND is_active = true;
  IF v11_active <> 0 THEN
    RAISE EXCEPTION 'default v11 не должен активироваться миграцией.';
  END IF;
END $$;
