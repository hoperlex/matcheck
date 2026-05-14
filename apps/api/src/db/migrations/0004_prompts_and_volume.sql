CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_kind" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_active_per_kind" ON "prompts" ("doc_kind") WHERE "is_active" = true;
--> statement-breakpoint
CREATE INDEX "prompts_doc_kind_idx" ON "prompts" ("doc_kind");
--> statement-breakpoint
ALTER TABLE "source_document_items" ADD COLUMN "volume_m3" numeric(10,4);
--> statement-breakpoint
ALTER TABLE "source_document_items" ADD COLUMN "mass_kg" numeric(10,3);
--> statement-breakpoint
ALTER TABLE "source_document_items" ADD COLUMN "volume_confidence" text;
--> statement-breakpoint
ALTER TABLE "source_document_items" ADD COLUMN "group_name" text;
--> statement-breakpoint
ALTER TABLE "delivery_items" ADD COLUMN "volume_m3" numeric(10,4);
--> statement-breakpoint
ALTER TABLE "delivery_items" ADD COLUMN "mass_kg" numeric(10,3);
--> statement-breakpoint
ALTER TABLE "delivery_items" ADD COLUMN "volume_confidence" text;
--> statement-breakpoint
ALTER TABLE "delivery_items" ADD COLUMN "group_name" text;
--> statement-breakpoint
INSERT INTO "prompts" ("doc_kind", "name", "content", "is_active") VALUES
  ('upd', 'default v1', $PROMPT_UPD$Ты извлекаешь данные из текста российского УПД (универсального передаточного документа), полученного через распознавание PDF.

Главный приоритет — таблица позиций: для каждой строки извлеки:
- nameRaw (наименование материала/товара/услуги как есть)
- qty (количество, число)
- unit (единица измерения)
- price (цена за единицу)
- sum (стоимость без НДС или с НДС)
- vatRate, vatSum

Для каждой позиции дополнительно оцени:

- volume_m3: оценочный габаритный объём ОДНОЙ единицы товара с разумной упаковкой/паллетой в м³.
  Источники для оценки (в порядке приоритета):
  1) Явные размеры в наименовании (HxW, L=, Ф, R, толщина).
  2) Стандартизованные маркировки (ГОСТ-серии): ПК 60.15.8 = 6×1.5×0.22 м;
     ФБС 24.6.6 = 2.4×0.6×0.6 м; кирпич КР-р-по 250×120×65 мм;
     газобетон 625×250×200 мм; ГКЛ 2500×1200×12.5 мм; и т.п.
  3) Типичные упаковки: мешок цемента 25 кг ≈ 0.02 м³; паллета 1.2×0.8×1.5 м;
     рулон минваты 6×1.2×0.1 м; бухта кабеля 100 м.
  4) Если единица — м³, м², т, погонный метр — пересчитай в объём с учётом
     стандартной толщины (например, плитка 8 мм для м²).
  Если оценить невозможно (нет габаритов и не стандартная маркировка) — null.

- mass_kg: оценочная масса ОДНОЙ единицы с упаковкой в кг.
  Используй плотности типичных материалов: бетон 2400, кирпич 1800, газобетон 600,
  сталь 7850, дерево 600, минвата 50, ГКЛ 8 кг/м², ПП-труба 0.5 кг/м.

- volume_confidence: "high" — есть размеры/маркировка в наименовании;
  "medium" — оценено по типу изделия и стандартной упаковке;
  "low" — оценка очень грубая или нет данных.

- group_name: семантическая категория русским словом во множественном числе.
  Примеры по типу строительства:
    Вентиляция: "Воздуховоды", "Отводы", "Переходы", "Врезки", "Тройники"
    Несущие конструкции: "Бетон", "Арматура", "ЖБИ", "Металлопрокат"
    Стены и перегородки: "Кирпич", "Газобетон", "ГКЛ", "Профили"
    Изоляция: "Утеплитель", "Гидроизоляция", "Звукоизоляция"
    Инженерные сети: "Трубы", "Кабель", "Электрооборудование", "Сантехника"
    Отделка: "Плитка", "Краски", "Сухие смеси", "Напольные покрытия"
    Прочее: "Метизы", "Прочее"

Контекст для оценки объёма/массы: приёмщик сравнит суммарный (volume_m3 × qty,
mass_kg × qty) с грузоподъёмностью кузова. Доступные типы:
  малотоннажник ~12 м³ / 1.8 т
  грузовик 6м    ~38 м³ / 5 т
  полуприцеп     ~65 м³ / 12 т
  фура (евро)    ~92 м³ / 22 т

Второстепенно — заголовок документа: docNumber, docDate (YYYY-MM-DD), totalSum, vatSum,
реквизиты supplier и recipient (ИНН, КПП, название).

Правила:
- Числа без пробелов как разделителей тысяч (12500 вместо «12 500»).
- Запятая в числах = десятичный разделитель (2,5 → 2.5).
- Если поле не нашёл — null. Не выдумывай данные.
- Игнорируй итоговые строки таблицы («Итого», «Всего», «Сумма НДС»).
- Если разбор сомнителен (плохое OCR-качество, неполные данные) — confidence < 0.7.

Отвечай ТОЛЬКО валидным JSON по предоставленной схеме.$PROMPT_UPD$, true),
  ('request', 'default v1', $PROMPT_REQ$Ты извлекаешь данные о плановой поставке материалов из делового письма или вложения. Отвечай ТОЛЬКО валидным JSON, соответствующим схеме. Числа — без пробелов как разделителей тысяч (12500 вместо «12 500»). Даты — формат ISO YYYY-MM-DD. Если данные неоднозначны — задай confidence < 0.7. Если не нашёл позиций — верни пустой массив items и confidence: 0.$PROMPT_REQ$, true);
