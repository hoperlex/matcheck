-- Инвариант «принятый файл всегда виден документом»: связь строки реестра с
-- заглушкой и закрытие строк, документ по которым удалён.
--
-- Зачем. Файл, загруженный через публичную форму, мог исчезнуть из «Документов»
-- шестью путями: зона «Дополнительные документы» (store_only), сертификат по
-- классификатору (supplementary), нераспознанная накладная (техническая запись
-- с is_technical=true), исчерпание ретраев, сбой getObject и закрытие строки
-- реестра как failed. Во всех случаях объект лежит в S3, а записи документа
-- нет — менеджер видит «ничего не пришло». Код теперь достраивает недостающий
-- документ-заглушку (domain/sourceDocuments/stub-documents.ts), и ему нужны две
-- вещи от схемы.
--
-- 1. stub_document_id — ЧЕСТНАЯ связь строки реестра с заведённым по ней
--    документом. created_document_ids для этого не годится: это jsonb без FK,
--    документ по нему можно удалить, и массив останется указывать в пустоту.
--    Проверка «массив непустой» дала бы ложное «документ уже есть», а проверка
--    «есть живой документ из массива» — ложное «документа нет» после законного
--    удаления. Колонка сделана по образцу соседней manual_document_id: тот же
--    ON DELETE SET NULL, ту же роль играет.
--
-- 2. resolved_at у строк, чей документ БЫЛ и удалён. Без этого первый же
--    repair-проход увидит «строка есть, документа нет» и заведёт заглушку
--    заново — воскресит удалённое менеджером. Причём воскресит призраком:
--    удаление документа ставит его S3-ключи в очередь на физическое удаление
--    (deleteUpdWithRefsCheck), так что файла за заглушкой уже нет.
--    resolved_at — существующий механизм «вопрос по файлу закрыт, не
--    переоткрывать», им же пользуется ручной разбор.
--
-- Замер на боевой БД перед миграцией: 19 таких строк (документ объявлен в
-- created_document_ids, ни одного живого не осталось).
--
-- Данные эта миграция НЕ поднимает: чтобы завести заглушку, нужно проверить
-- наличие объекта в S3 (иначе получится документ без файла), а из SQL этого не
-- сделать. Заглушки создаёт скрипт scripts/backfill-stub-documents.ts тем же
-- кодом, что и воркер.
--
-- Откат: 0099_down.sql.

ALTER TABLE "bundle_import_items"
  ADD COLUMN IF NOT EXISTS "stub_document_id" uuid REFERENCES "source_documents"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Индекс нужен самой БД: без него ON DELETE SET NULL делает seq scan реестра на
-- каждое удаление документа.
CREATE INDEX IF NOT EXISTS "bundle_import_items_stub_document_idx"
  ON "bundle_import_items" ("stub_document_id")
  WHERE "stub_document_id" IS NOT NULL;
--> statement-breakpoint
-- Категория «документ был и удалён»: объявленные документы есть, живых не
-- осталось. resolved_by_user_id намеренно NULL — кто именно удалил, известно из
-- entity_deletions, а здесь важен сам факт закрытия.
UPDATE "bundle_import_items" bi
   SET "resolved_at" = now(),
       "reason" = coalesce(bi."reason", 'документ по файлу удалён'),
       "updated_at" = now()
 WHERE bi."resolved_at" IS NULL
   AND jsonb_array_length(coalesce(bi."created_document_ids", '[]'::jsonb)) > 0
   AND NOT EXISTS (
     SELECT 1
       FROM "source_documents" sd
      WHERE sd."id" IN (
        SELECT value::uuid FROM jsonb_array_elements_text(bi."created_document_ids") AS t(value)
      )
   );
