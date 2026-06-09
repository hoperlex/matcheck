-- One-time backfill: бамп `source_documents.updated_at` у всех УПД,
-- которые сейчас привязаны к приёмке или отгрузке.
--
-- Зачем: после деплоя сервер начнёт автоматически бампать
-- `source_documents.updated_at` при любых INSERT/DELETE в
-- `delivery_sources` / `shipment_sources` (см. domain/sourceDocuments/touch.ts).
-- Это правит «зеркало» Inbox мобилы инспектора.
--
-- Но уже накопленные «фантомы» в локальных Room-кэшах мобильных клиентов
-- (УПД, которые висят как ожидаемые, потому что их привязка случилась до
-- bump-фикса) сами не очистятся — у этих УПД старый `updated_at`,
-- и /sync их не вернёт.
--
-- Этот UPDATE форсит бамп для всех привязанных УПД. На следующем /sync
-- (после выхода инспектора онлайн) мобила получит их в дельте, обновит
-- локальный junction-кэш и автоматически уберёт из Inbox.
--
-- Стоимость: одна UPDATE-операция. На реальном объёме (~10k УПД)
-- занимает <100ms.

UPDATE "source_documents"
SET "updated_at" = NOW()
WHERE EXISTS (
  SELECT 1 FROM "delivery_sources" ds
  WHERE ds."source_document_id" = "source_documents"."id"
) OR EXISTS (
  SELECT 1 FROM "shipment_sources" ss
  WHERE ss."source_document_id" = "source_documents"."id"
);
