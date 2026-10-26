-- Откат правила «покупатель совпал с поставщиком» (PARTY_ROLES_CHECK).
--
-- Порядок: сначала PARTY_ROLES_CHECK=off и перезапуск api и worker, затем этот
-- SQL, и только потом откат КОДА. Прежний API не знает имя
-- buyer_same_as_supplier: сериализатор ответа документа упал бы на таких
-- строках (как с supplier_inn_unverified, см. 0138_down.sql).
--
-- Сброшенные покупатели этим скриптом не возвращаются: прочитанные моделью
-- стороны лежат в recognition_evidence_events (evidence_type = 'party_roles').
UPDATE source_documents
   SET validation = jsonb_set(
         validation,
         '{warnings}',
         COALESCE(
           (SELECT jsonb_agg(w) FROM jsonb_array_elements(validation->'warnings') w
             WHERE w->>'name' <> 'buyer_same_as_supplier'),
           '[]'::jsonb))
 WHERE validation->'warnings' @> '[{"name":"buyer_same_as_supplier"}]';
