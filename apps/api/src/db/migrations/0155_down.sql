-- Откат 0155. Порядок: выключить объединение (MACHINE_MERGE_SITES пуст),
-- снять объединения скриптом apps/api/scripts/machine-merges-retire.ts — он
-- бампает документы, и планшеты узнают о смене состава, — затем откатить код.
-- Без скрипта DROP молча развалит объединённые машины, а планшеты об этом не
-- узнают: группа вычисляется на лету, строки документов не меняются.
DROP TABLE IF EXISTS "machine_merges";
-- События override теряются: прежнее ограничение их не допускает.
DELETE FROM "operation_group_claim_events" WHERE "event" = 'override';
ALTER TABLE "operation_group_claim_events"
  DROP CONSTRAINT IF EXISTS "operation_group_claim_events_event_check";
ALTER TABLE "operation_group_claim_events"
  ADD CONSTRAINT "operation_group_claim_events_event_check"
  CHECK ("event" IN ('create', 'release', 'reclaim'));
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "last_seen_capabilities";
