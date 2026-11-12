-- След решения по дубликату: «копия оставлена как новая поставка».
--
-- Пишется ТОЛЬКО действием resolve-duplicate action='keep' (менеджер или
-- мониторинг). Отдельной колонкой, а не в parse_error_details: последние
-- перезаписывает пересчёт исхода при любой правке позиций (PATCH), и след
-- решения пропал бы при первой правке количества.
--
-- Формат: { action:'kept', existingId|null, siblings:[{id, operations:[...]}],
-- duplicateCheck, comment, userId, at }. В /sync не уходит.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS duplicate_resolution jsonb;
