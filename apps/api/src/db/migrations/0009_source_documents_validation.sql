-- Авто-сверка арифметики УПД: после распознавания на сервере считается
-- Σ построчных sum/vatSum vs итог из шапки и построчно qty×price/НДС, результат
-- складывается в JSONB-колонку. См. apps/api/src/domain/edo/upd-validation.ts.

ALTER TABLE "source_documents" ADD COLUMN "validation" jsonb;
