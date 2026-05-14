-- УПД: явный выбор подрядчика при загрузке + индекс для дедупликации.
--
-- 1) Добавляем колонку contractor_id (FK на counterparties.id) — пользователь
--    выбирает её в диалоге загрузки УПД (PDF/XML). Привязка не каскадная:
--    при удалении контрагента поле обнуляется, документ остаётся.
-- 2) Частичный индекс для быстрого поиска дублей УПД по тройке
--    (supplier_id, doc_number, doc_date). Не UNIQUE — нужен soft-warning
--    с возможностью «Заменить», а не жёсткий DB-конфликт.

ALTER TABLE "source_documents"
  ADD COLUMN "contractor_id" uuid REFERENCES "counterparties"("id") ON DELETE SET NULL;

CREATE INDEX "source_upd_dedup_idx"
  ON "source_documents" ("supplier_id", "doc_number", "doc_date")
  WHERE "kind" = 'upd'
    AND "supplier_id" IS NOT NULL
    AND "doc_number" IS NOT NULL
    AND "doc_date" IS NOT NULL;

CREATE INDEX "source_contractor_idx"
  ON "source_documents" ("contractor_id")
  WHERE "contractor_id" IS NOT NULL;
