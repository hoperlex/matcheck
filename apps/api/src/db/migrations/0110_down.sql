-- Откат 0110: удаляет промпт формы 1-Т.
--
-- Применять вручную (psql -1 -f), затем удалить строку миграции из
-- drizzle.__drizzle_migrations. Перед откатом выключите WAYBILL_1T_FALLBACK:
-- без активного промпта второй проход бросит «активный промпт не найден».
--
-- Записи журнала llm_calls ссылаются на prompt_id с ON DELETE SET NULL, то
-- есть удаление применённого промпта обезличит их. Поэтому удаляем только
-- промпт, которым ещё ничего не разобрано.
DELETE FROM "prompts"
 WHERE "doc_kind" = 'transport_waybill_1t'
   AND NOT EXISTS (SELECT 1 FROM "llm_calls" lc WHERE lc."prompt_id" = "prompts"."id");
