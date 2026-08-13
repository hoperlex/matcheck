-- Поставка из нескольких УПД: происхождение позиций, поколения сборки пакета,
-- манифест сегментов и claim группы.
--
-- Задача целиком: одна машина привозит несколько УПД (в т.ч. россыпью фотографий
-- страниц). Сегодня каждый файл — отдельный документ, приёмка знает лишь первый
-- из них, а позиции не помнят, откуда пришли. Эта миграция кладёт основание под
-- все шаги: атрибуцию позиций, атомарную публикацию собранного пакета и запрет
-- принять одну поставку дважды.
--
-- НЕДЕСТРУКТИВНО: только добавление колонок с NULL/DEFAULT и двух новых таблиц.
-- Ни один существующий writer в новые поля не пишет — до появления кода
-- поведение системы не меняется вовсе.

-- ── 1. Происхождение позиции приёмки ────────────────────────────────────────
--
-- source_document_id — это ПРОИСХОЖДЕНИЕ данных, а не текущая связь: связь
-- живёт в delivery_sources и снимается отвязкой, происхождение остаётся. Иначе
-- после «Отвязать» неоткуда узнать, откуда взялась строка, и повторная привязка
-- вынуждена угадывать по названию и количеству.
--
-- ON DELETE RESTRICT, а не SET NULL: обнуление при удалении УПД теряет ровно ту
-- информацию, ради которой колонка заводится. Документ, чьи позиции попали в
-- приёмку, удалять нельзя — только архивировать. Новых блокировок это не
-- создаёт: привязанный документ и сегодня защищён RESTRICT в delivery_sources.
ALTER TABLE "delivery_items"
  ADD COLUMN IF NOT EXISTS "source_document_id" uuid REFERENCES "source_documents"("id") ON DELETE RESTRICT;

-- Точная исходная строка. Позволяет серверу проверить не только «позиция из
-- этого документа», но и «именно эта строка». SET NULL, а не RESTRICT: повторный
-- разбор документа удаляет и пересоздаёт source_document_items (см. worker,
-- DELETE ... WHERE source_document_id = ...), и RESTRICT заблокировал бы
-- переразбор. Документ при этом остаётся известен — атрибуция не теряется.
ALTER TABLE "delivery_items"
  ADD COLUMN IF NOT EXISTS "source_document_item_id" uuid REFERENCES "source_document_items"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "delivery_items_source_document_idx"
  ON "delivery_items" ("source_document_id")
  WHERE "source_document_id" IS NOT NULL;

-- ── 2. Поколения сборки пакета ──────────────────────────────────────────────
--
-- assembly_version отделяет уже загруженное от новой сборки:
--   legacy     — «файл = документ», как было; группа = сам документ;
--   logical_v1 — «логический УПД = документ», группа = корневой пакет.
-- Существующие пакеты остаются legacy НАВСЕГДА и не перегруппировываются:
-- внутри них пять фотографий одной УПД лежат как пять самостоятельных
-- документов, и показать их одной поставкой значило бы впятеро задвоить
-- материалы.
ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "assembly_version" text NOT NULL DEFAULT 'legacy';

-- Поколение, которое РАЗРЕШЕНО показывать. Выставляется той же транзакцией,
-- что публикует собранный набор документов. NULL у legacy-пакетов и у пакетов,
-- сборка которых ещё не завершилась: их промежуточные документы не должны
-- попасть ни в список, ни в /sync.
ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "published_generation" integer;

-- Версия состава группы. Растёт не только при изменении набора документов, но и
-- при изменении реквизитов или позиций любого из них: планшет сверяет её при
-- создании приёмки, и «состав тот же, но суммы другие» — тоже расхождение.
ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "group_revision" integer NOT NULL DEFAULT 1;

-- Порядок входных файлов пакета. Без него набор фотографий нельзя разложить в
-- страницы: «вторая страница» определяется только соседством с первой, а
-- выборка из реестра порядка не гарантирует.
ALTER TABLE "bundle_import_items"
  ADD COLUMN IF NOT EXISTS "input_order" integer;

-- ── 3. Манифест сегментов ───────────────────────────────────────────────────
--
-- Сегмент = один логический УПД, собранный из страниц. Манифест сохраняется,
-- чтобы повтор упавшего задания не создал второй комплект документов: сегмент
-- ищется по (пакет, поколение, индекс), а не заводится заново. Публикация
-- проставляет source_document_id и published_at всем сегментам поколения одной
-- транзакцией.
CREATE TABLE IF NOT EXISTS "bundle_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bundle_id" uuid NOT NULL REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL,
  "segment_index" integer NOT NULL,
  -- Документ появляется в момент публикации; до этого сегмент существует как
  -- запись манифеста со staging-результатом распознавания.
  "source_document_id" uuid REFERENCES "source_documents"("id") ON DELETE SET NULL,
  -- PageRef[]: { registryItemId, inputOrder, pageInFile } — адрес каждой
  -- страницы, переживающий пересборку и разделение документов.
  "page_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- normal | fallback | uncertain (см. segmentUpdPages). Поколение с fallback
  -- или uncertain не публикуется автоматически: разбирает менеджер.
  "confidence" text,
  "doc_number" text,
  "doc_date" date,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "bundle_segments_slot_unique"
  ON "bundle_segments" ("bundle_id", "generation", "segment_index");

CREATE INDEX IF NOT EXISTS "bundle_segments_document_idx"
  ON "bundle_segments" ("source_document_id")
  WHERE "source_document_id" IS NOT NULL;

-- ── 4. Claim группы ─────────────────────────────────────────────────────────
--
-- Одна поставка принимается один раз. Проверкой в коде это не удержать: два
-- планшета создают приёмку одновременно, и оба видят группу свободной.
-- PRIMARY KEY по group_id делает второй заезд ошибкой уникальности внутри
-- транзакции создания.
--
-- Группа занята ЛЮБОЙ неудалённой приёмкой, в том числе завершённой
-- (confirmed_mol): иначе ту же машину можно принять повторно на следующий день.
-- Сценарий «несколько рейсов по одному УПД» — осознанное действие менеджера,
-- которое снимает claim явно.
CREATE TABLE IF NOT EXISTS "delivery_group_claims" (
  "group_id" uuid PRIMARY KEY REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "delivery_id" uuid NOT NULL REFERENCES "deliveries"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "released_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "delivery_group_claims_delivery_idx"
  ON "delivery_group_claims" ("delivery_id");

-- ── 5. Backfill происхождения там, где оно однозначно ───────────────────────
--
-- Только приёмки РОВНО с одной привязанной УПД: при двух и более неизвестно,
-- из какой пришла строка. Но и одной связи мало — рядом с позициями УПД в
-- приёмке лежат строки, внесённые инспектором руками, и приписать их документу
-- значило бы соврать в интерфейсе.
--
-- Поэтому сопоставление — multiset: позиции группируются по нормализованному
-- (название, единица), и ключ засчитывается ТОЛЬКО если число строк с обеих
-- сторон совпало. Совпало — строки сопоставляются попарно в порядке line_no;
-- не совпало — весь ключ остаётся NULL. Количество в ключ не входит намеренно:
-- мобильный клиент кладёт его в qty_actual, веб — в qty_planned, а инспектор
-- правит фактическое при приёмке.
WITH single_source AS (
  -- Агрегат по массиву, а не MIN(): у uuid в Postgres нет функции MIN, а
  -- группа здесь заведомо из одной строки (HAVING COUNT(*) = 1).
  SELECT ds."delivery_id", (array_agg(ds."source_document_id"))[1] AS "source_document_id"
    FROM "delivery_sources" ds
   GROUP BY ds."delivery_id"
  HAVING COUNT(*) = 1
),
di AS (
  SELECT i."id",
         i."delivery_id",
         s."source_document_id",
         lower(btrim(regexp_replace(i."name_raw", '\s+', ' ', 'g'))) AS "name_key",
         lower(btrim(coalesce(i."unit", ''))) AS "unit_key",
         row_number() OVER (
           PARTITION BY i."delivery_id",
                        lower(btrim(regexp_replace(i."name_raw", '\s+', ' ', 'g'))),
                        lower(btrim(coalesce(i."unit", '')))
           ORDER BY i."line_no", i."id"
         ) AS "rn",
         count(*) OVER (
           PARTITION BY i."delivery_id",
                        lower(btrim(regexp_replace(i."name_raw", '\s+', ' ', 'g'))),
                        lower(btrim(coalesce(i."unit", '')))
         ) AS "cnt"
    FROM "delivery_items" i
    JOIN single_source s ON s."delivery_id" = i."delivery_id"
   WHERE i."source_document_id" IS NULL
),
si AS (
  SELECT it."id",
         it."source_document_id",
         lower(btrim(regexp_replace(it."name_raw", '\s+', ' ', 'g'))) AS "name_key",
         lower(btrim(coalesce(it."unit", ''))) AS "unit_key",
         row_number() OVER (
           PARTITION BY it."source_document_id",
                        lower(btrim(regexp_replace(it."name_raw", '\s+', ' ', 'g'))),
                        lower(btrim(coalesce(it."unit", '')))
           ORDER BY it."line_no", it."id"
         ) AS "rn",
         count(*) OVER (
           PARTITION BY it."source_document_id",
                        lower(btrim(regexp_replace(it."name_raw", '\s+', ' ', 'g'))),
                        lower(btrim(coalesce(it."unit", '')))
         ) AS "cnt"
    FROM "source_document_items" it
   WHERE it."source_document_id" IN (SELECT "source_document_id" FROM single_source)
),
matched AS (
  SELECT di."id" AS "delivery_item_id",
         di."source_document_id",
         si."id" AS "source_document_item_id"
    FROM di
    JOIN si
      ON si."source_document_id" = di."source_document_id"
     AND si."name_key" = di."name_key"
     AND si."unit_key" = di."unit_key"
     AND si."rn" = di."rn"
   WHERE di."cnt" = si."cnt"
)
UPDATE "delivery_items" t
   SET "source_document_id" = m."source_document_id",
       "source_document_item_id" = m."source_document_item_id"
  FROM matched m
 WHERE t."id" = m."delivery_item_id";
