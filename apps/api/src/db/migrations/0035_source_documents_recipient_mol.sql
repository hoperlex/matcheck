-- При загрузке УПД (PDF/XML) диспетчер может указать получателя двумя
-- способами: контрагент-подрядчик (contractor_id, поле существует) или
-- материально-ответственное лицо (recipient_mol_id, добавляется здесь).
-- Поле опционально — допустимо загрузить УПД без указания получателя.
-- Затем, при создании приёмки из этой УПД, выбор подхватывается как
-- значение по умолчанию.
ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "recipient_mol_id" UUID
  REFERENCES "responsible_persons" ("id") ON DELETE SET NULL;
