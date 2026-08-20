-- Откат 0117: убирает промпт «transport_waybill_1t / default v2».
--
-- Не удаляем активную или уже использованную версию: такой откат стёр бы связь
-- llm_calls с фактическим текстом распознавания. Если v2 успели включить,
-- сначала верните активность v1 в Администрирование → Промпты.

DELETE FROM "prompts" p
WHERE p."doc_kind" = 'transport_waybill_1t'
  AND p."name" = 'default v2'
  AND p."is_active" = false
  AND NOT EXISTS (SELECT 1 FROM "llm_calls" c WHERE c."prompt_id" = p."id");
