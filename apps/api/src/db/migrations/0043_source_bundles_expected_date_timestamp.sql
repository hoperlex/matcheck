-- Согласование типа expected_date в source_bundles с остальными таблицами:
-- в source_documents/source_document_items и др. это `timestamp`, и
-- schema.ts объявляет `timestamp('expected_date', { mode: 'date' })`.
-- В миграции 0041 я по ошибке сделал колонку типа `date` — pg-драйвер
-- возвращает её как строку 'YYYY-MM-DD', и при INSERT в source_documents
-- значение копировалось как строка вместо Date → RangeError: Invalid
-- time value. Приводим к общему типу.

ALTER TABLE "source_bundles"
  ALTER COLUMN "expected_date" TYPE timestamp USING "expected_date"::timestamp;
