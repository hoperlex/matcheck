-- Откат 0104: возврат к delivery_group_claims.
--
-- ДЕСТРУКТИВНО в двух местах:
--   1. operation_group_claim_events удаляется целиком — это аудит освобождений,
--      восстановить его неоткуда;
--   2. claims вида 'shipment' пропадают: в старой таблице для них нет места.
--
-- Откатывать имеет смысл только сразу после накатки, пока claims не появились.
-- Если группы уже принимались, безопаснее выключить фичу флагом и оставить
-- таблицы на месте — они не мешают старому коду.

-- Восстанавливаем исходную форму из 0096.
CREATE TABLE IF NOT EXISTS "delivery_group_claims" (
  "group_id" uuid PRIMARY KEY REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "delivery_id" uuid NOT NULL REFERENCES "deliveries"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "released_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "delivery_group_claims_delivery_idx"
  ON "delivery_group_claims" ("delivery_id");

-- Переносим то, что переносимо: приёмочные claims. Отгрузочные теряются —
-- в старой схеме их выразить нечем.
INSERT INTO "delivery_group_claims" ("group_id", "delivery_id", "created_at")
SELECT "group_id", "delivery_id", "created_at"
  FROM "operation_group_claims"
 WHERE "operation_kind" = 'delivery'
   AND "delivery_id" IS NOT NULL
ON CONFLICT ("group_id") DO NOTHING;

DROP TABLE IF EXISTS "operation_group_claim_events";
DROP TABLE IF EXISTS "operation_group_claims";
