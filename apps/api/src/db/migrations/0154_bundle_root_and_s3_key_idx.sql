-- Индексы под «машину» и вложения: сверка планшета перестаёт перебирать таблицы.
--
-- Симптом. Портал открывает приёмку десятки секунд, хотя сама карточка лёгкая:
-- база занята сверкой планшетов. POST /sync/reconcile раз в минуту на каждом
-- планшете отбирает документы объекта за 90 дней через предикат видимости
-- (mobile-visibility.ts, groupIsCompleteSql). Замер на бою 19.11.2026, объект
-- АЛИЯ: 34,4 с на один вызов, из них
--   * ~26,8 с — 1441 документ × полный перебор source_bundles (19,5 тыс. строк)
--     в соединении `coalesce(member.parent_bundle_id, member.id) = root.id`;
--   * ~7,3 с — 3017 строк реестра × полный перебор source_document_attachments
--     в условии `a.s3_key = bi.input_s3_key`.
-- Стоимость растёт как «документы в окне × пакеты в базе»: с 1 сентября по
-- 17 ноября — в 25 раз, и с ростом таблиц продолжала бы расти.
--
-- Почему существующие индексы не помогают:
--   * source_bundles_parent_idx — только parent_bundle_id и только где он не
--     NULL; выражение coalesce(parent_bundle_id, id) им не обслуживается;
--   * у source_document_attachments есть лишь индекс по source_document_id (0071);
--     уникальный ключ bundle_import_items ищет в обратную сторону.
--
-- ВЫРАЖЕНИЕ ИНДЕКСА ОБЯЗАНО БУКВАЛЬНО СОВПАДАТЬ с тем, что написано в запросах:
-- coalesce(<алиас>.parent_bundle_id, <алиас>.id). Перестановка аргументов или
-- другая форма (`id = x or parent_bundle_id = x`) — и планировщик индекс не
-- возьмёт. Тот же шаблон, кроме предиката видимости, используют
-- portalDocumentGroupSizeSql, loadSdNames, bumpGroupRevision,
-- markSourceDocumentContentChanged, publishGroupDocuments,
-- recordVisibilityTransitions, machine-lock; поиск по s3_key — stub-documents и
-- список документов портала. Ускоряются все сразу.
--
-- НЕДЕСТРУКТИВНО: индексы неуникальные, данные не меняются, ограничений на
-- данные не добавляется, форма ответов API не меняется.
--
-- ПОРЯДОК ВЫКАТА:
--   1) СНАЧАЛА online-index runner (scripts/create-indexes-online.ts) строит
--      оба индекса CONCURRENTLY — запись планшетов и портала не блокируется;
--   2) ПОТОМ обычный деплой: CREATE INDEX IF NOT EXISTS увидит готовые индексы
--      и ничего не сделает, а страж в конце подтвердит, что они валидны.
-- Если раннер не запускали, этот файл построит индексы обычным CREATE INDEX:
-- SHARE-лок на обе таблицы на время построения и до конца транзакции (таблицы
-- 15 и 5 МБ — доли секунды). lock_timeout не даёт встать в очередь за длинной
-- пишущей транзакцией: не дождались — миграция падает, деплой повторяют.
--
-- Страж. Сбой CONCURRENTLY оставляет индекс с тем же именем в состоянии
-- INVALID: он занимает имя, но планировщиком не используется. IF NOT EXISTS
-- такой индекс молча пропустил бы, и миграция числилась бы применённой без
-- ускорения. Поэтому после создания проверяем валидность и падаем с подсказкой —
-- деплой останавливается до пересоздания контейнеров.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_bundles_root_idx" ON "source_bundles" ((coalesce("parent_bundle_id", "id")));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_document_attachments_s3_key_idx" ON "source_document_attachments" ("s3_key");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN ('source_bundles_root_idx', 'source_document_attachments_s3_key_idx')
       AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'Индекс миграции 0154 невалиден (остаток сбойного CREATE INDEX CONCURRENTLY). Перезапустите scripts/create-indexes-online.ts — он удалит и построит индекс заново, — затем повторите деплой.';
  END IF;
END
$$;
