-- Empty-draft Выезд («Создать отгрузку» на мобиле без выбранной УПД)
-- должен сохраняться даже если получатель ещё не указан — менеджер
-- дозaпoлнит на портале позже. Раньше CHECK shipments_kind_links_chk
-- для kind='contractor' требовал XOR: ровно один из
-- (receiver_counterparty_id, receiver_mol_id). Это блокировало любые
-- INSERT без получателя.
--
-- Ослабляем CHECK: для kind='contractor' допустимо
-- - оба NULL (empty-draft без получателя),
-- - один NOT NULL (обычный сценарий),
-- - оба NOT NULL — запрещено (двойное указание).
--
-- Все остальные kind ('return', 'transfer', 'writeoff') без изменений.
--
-- Сервер validateKindLinks по-прежнему требует получателя для picked-UPD
-- (sourceDocumentIds непустой) — это удерживает инвариант «накладная →
-- получатель явен». См. apps/api/src/routes/shipments.ts:validateKindLinks.

ALTER TABLE shipments DROP CONSTRAINT shipments_kind_links_chk;

ALTER TABLE shipments
  ADD CONSTRAINT shipments_kind_links_chk
  CHECK (
    (kind = 'contractor'
      AND NOT (receiver_counterparty_id IS NOT NULL AND receiver_mol_id IS NOT NULL)
      AND dest_site_id IS NULL)
    OR (kind = 'return'
      AND receiver_counterparty_id IS NOT NULL
      AND receiver_mol_id IS NULL
      AND dest_site_id IS NULL)
    OR (kind = 'transfer'
      AND dest_site_id IS NOT NULL
      AND dest_site_id <> site_id
      AND ((receiver_counterparty_id IS NOT NULL) <> (receiver_mol_id IS NOT NULL)))
    OR (kind = 'writeoff'
      AND receiver_counterparty_id IS NULL
      AND receiver_mol_id IS NULL
      AND dest_site_id IS NULL)
  );
