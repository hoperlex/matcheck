-- Откат 0112: убирает промпт накладных «default v4».
--
-- Применять вручную (psql -1 -f), затем удалить строку миграции из
-- drizzle.__drizzle_migrations.
--
-- Порядок важен: если v4 успели включить кнопкой в админке, сначала возвращаем
-- активность v3 — вид transport_waybill ни на мгновение не должен остаться без
-- активной записи, иначе resolvePrompt в воркере бросит ошибку на первом же
-- пакете. При невключённом v4 первые два запроса просто ничего не меняют.
UPDATE "prompts" SET "is_active" = false
  WHERE "doc_kind" = 'transport_waybill' AND "name" = 'default v4';

UPDATE "prompts" SET "is_active" = true
  WHERE "doc_kind" = 'transport_waybill' AND "name" = 'default v3'
    AND NOT EXISTS (
      SELECT 1 FROM "prompts" p2
       WHERE p2."doc_kind" = 'transport_waybill' AND p2."is_active" = true
    );

-- Записи журнала llm_calls ссылаются на prompt_id с ON DELETE SET NULL, то
-- есть удаление применённого промпта обезличит их. Поэтому удаляем только
-- промпт, которым ещё ничего не разобрано; если v4 уже работал — он остаётся
-- в таблице выключенным, и история вызовов сохраняет ссылку на него.
DELETE FROM "prompts"
 WHERE "doc_kind" = 'transport_waybill'
   AND "name" = 'default v4'
   AND NOT EXISTS (SELECT 1 FROM "llm_calls" lc WHERE lc."prompt_id" = "prompts"."id");
