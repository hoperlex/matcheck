-- Альтернативные названия контрагента для дедупликации при создании
-- «на лету» из combobox. При POST /counterparties сервер ищет существующего
-- по lower(name) ИЛИ lower(any(aliases)) ИЛИ по ИНН — если нашёл,
-- возвращает существующего без создания дубля.
--
-- Алиасы редактируются админом в разделе Справочники → Контрагенты
-- (например «ООО Лютик» = «Лютик ООО» = «Лютик»). LLM-распознавание
-- может добавлять алиасы автоматически в будущем — пока вручную.

ALTER TABLE "counterparties"
  ADD COLUMN IF NOT EXISTS "aliases" text[] NOT NULL DEFAULT '{}';

-- GIN-индекс для быстрого поиска по любому из алиасов в combobox.
CREATE INDEX IF NOT EXISTS "counterparties_aliases_gin"
  ON "counterparties" USING gin ("aliases");
