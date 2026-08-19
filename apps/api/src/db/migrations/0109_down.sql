-- Не удаляем активный или уже использованный промпт: такой откат стёр бы
-- связь llm_calls с фактическим текстом распознавания.
DELETE FROM "prompts" p
WHERE p."doc_kind" = 'upd'
  AND p."name" = 'default v11'
  AND p."is_active" = false
  AND NOT EXISTS (SELECT 1 FROM "llm_calls" c WHERE c."prompt_id" = p."id");
