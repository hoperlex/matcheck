-- Откат 0145: убирает промпт «upd / torg12 v2».
--
-- Не удаляем активный или уже использованный промпт: такой откат стёр бы связь
-- llm_calls с фактическим текстом распознавания. Если промпт включён через
-- TORG12_PROMPT, сначала выключите его (TORG12_PROMPT=off) — но вызовы,
-- успевшие пройти, всё равно удержат строку.
DELETE FROM "prompts" p
WHERE p."doc_kind" = 'upd'
  AND p."name" = 'torg12 v2'
  AND p."is_active" = false
  AND NOT EXISTS (SELECT 1 FROM "llm_calls" c WHERE c."prompt_id" = p."id");
