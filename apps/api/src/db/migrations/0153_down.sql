-- Откат 0153: сначала откатить портал и API (они читают и пишут is_manual).
-- Разметка теряется; повторное применение 0153 восстановит её по комментариям,
-- кроме ручных записей, созданных с портала (у них маркера в комментарии нет).
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "is_manual";
ALTER TABLE "shipments" DROP COLUMN IF EXISTS "is_manual";
