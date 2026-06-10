-- Справочник единиц измерения. Используется веб-порталом для выпадающего
-- списка в столбце «Ед.» позиций УПД / приёмок / отгрузок (см. UnitSelect).
-- Раньше столбец был свободным текстом — пользователи опечатывались, мешались
-- одинаковые единицы в разных написаниях («шт» / «шт.» / «штука»).
--
-- На бэке `unit` в delivery_items / shipment_items / source_document_items
-- остаётся text без FK на этот справочник — нельзя ломать legacy-данные
-- и мобильный клиент, который шлёт строку как есть. Справочник — это
-- whitelist для UI; legacy-значения, которых нет в whitelist, UI показывает
-- через virtual-опцию (как в CustomerCounterpartySelect), не теряя их.
--
-- code — короткая форма, которая хранится в позициях (как раньше «шт», «кг»).
-- name — длинное название для UI («Штука», «Килограмм»).
-- okeiCode — опциональный код по ОКЕИ (Общероссийский классификатор единиц
--   измерения), нужно для будущей сверки с УПД, где LLM может вернуть
--   ОКЕИ-код вместо названия (796 → шт). Пока заполняем для справки.

CREATE TABLE IF NOT EXISTS "units" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(32) NOT NULL,
  "name" varchar(128) NOT NULL,
  "okei_code" varchar(8),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "units_code_unique" ON "units" (lower("code"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "units_active_idx" ON "units" ("is_active");
--> statement-breakpoint

-- Seed: основные единицы из ОКЕИ + типовые для стройки. Список покрывает
-- 95% реальных позиций УПД заказчика (см. логи llm_calls 2026-05/06).
-- Админ может расширить через UI «Справочники → Ед-ы изм.»
INSERT INTO "units" ("code", "name", "okei_code") VALUES
  ('шт',    'Штука',                 '796'),
  ('кг',    'Килограмм',             '166'),
  ('г',     'Грамм',                 '163'),
  ('т',     'Тонна',                 '168'),
  ('м',     'Метр',                  '006'),
  ('см',    'Сантиметр',             '004'),
  ('мм',    'Миллиметр',             '003'),
  ('м²',    'Квадратный метр',       '055'),
  ('м³',    'Кубический метр',       '113'),
  ('л',     'Литр',                  '112'),
  ('пог.м', 'Погонный метр',         '018'),
  ('упак',  'Упаковка',              '778'),
  ('комп',  'Комплект',              '839'),
  ('рул',   'Рулон',                 '736'),
  ('лист',  'Лист',                  '625'),
  ('меш',   'Мешок',                 NULL),
  ('бух',   'Бухта',                 NULL),
  ('пар',   'Пара',                  '715'),
  ('койк/м','Койко-место',           NULL),
  ('усл.ед','Условная единица',      '876')
ON CONFLICT DO NOTHING;
