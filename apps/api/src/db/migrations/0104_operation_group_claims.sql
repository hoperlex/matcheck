-- Claim группы: одна машина принимается (отгружается) один раз.
--
-- Зачем заменяем delivery_group_claims, заведённую в 0096.
--
-- 1. У неё group_id — PRIMARY KEY, поэтому хранить рядом освобождённые claims
--    (released_at + история) физически невозможно: вторая строка по той же
--    группе не вставится. А освобождение нужно журналировать — сценарий
--    «несколько рейсов по одному УПД» это осознанное действие менеджера, и
--    после него должно оставаться, кем и когда claim снят.
-- 2. Она защищает только приёмки. Групповой путь отгрузки в мобильном клиенте
--    уже реализован (DispatchUpdSelectViewModel/DispatchStage1FormViewModel
--    разворачивают машину так же, как приёмка), поэтому отдельная таблица для
--    отгрузок понадобилась бы сразу же. Зеркалить логику в двух местах этот
--    проект уже пробовал: link-source у отгрузок есть, unlink-source — нет.
--
-- БЕЗОПАСНО ДЛЯ ДАННЫХ: delivery_group_claims на бою пуста (0 строк, сверено
-- перед написанием миграции), кода, который бы в неё писал, никогда не было.
-- Тем не менее удаление идёт под гейтом — если строки вдруг появятся, миграция
-- упадёт, а не сотрёт их молча.

-- ── 1. Активные claims ──────────────────────────────────────────────────────
--
-- PRIMARY KEY (operation_kind, group_id) — тот же приём, что и в 0096: гонку
-- двух планшетов разрешает СУБД внутри транзакции создания, а не проверка в
-- коде, которая всегда успевает увидеть группу свободной.
--
-- Вид операции держим text + CHECK, а не enum: добавление значения в enum
-- нельзя использовать в той же транзакции (ошибка 55P04, из-за неё миграцию
-- 0015 пришлось разрезать надвое). Здесь значений ровно два и они не растут.
--
-- Два nullable FK вместо одного operation_id: полиморфная ссылка без FK не
-- дала бы каскадного удаления, и claim пережил бы свою приёмку, заблокировав
-- группу навсегда.
CREATE TABLE IF NOT EXISTS "operation_group_claims" (
  "operation_kind" text NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "delivery_id" uuid REFERENCES "deliveries"("id") ON DELETE CASCADE,
  "shipment_id" uuid REFERENCES "shipments"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  PRIMARY KEY ("operation_kind", "group_id"),
  CONSTRAINT "operation_group_claims_kind_check"
    CHECK ("operation_kind" IN ('delivery', 'shipment')),
  -- Ровно одна ссылка заполнена и она соответствует виду. Без этого claim вида
  -- 'delivery' мог бы указывать на отгрузку.
  CONSTRAINT "operation_group_claims_one_operation_check" CHECK (
    ("operation_kind" = 'delivery' AND "delivery_id" IS NOT NULL AND "shipment_id" IS NULL)
    OR
    ("operation_kind" = 'shipment' AND "shipment_id" IS NOT NULL AND "delivery_id" IS NULL)
  )
);

-- Одна операция держит не больше одной группы: иначе приёмка, собранная из
-- двух машин, заняла бы обе и ни одну нельзя было бы освободить отдельно.
CREATE UNIQUE INDEX IF NOT EXISTS "operation_group_claims_delivery_uniq"
  ON "operation_group_claims" ("delivery_id")
  WHERE "delivery_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "operation_group_claims_shipment_uniq"
  ON "operation_group_claims" ("shipment_id")
  WHERE "shipment_id" IS NOT NULL;

-- ── 2. Неизменяемая история ─────────────────────────────────────────────────
--
-- Отдельной таблицей, а не колонками в claim: активная строка удаляется при
-- освобождении, и аудит вместе с ней исчез бы.
--
-- FK на группу и операцию здесь НАМЕРЕННО НЕТ. История обязана пережить и
-- удаление пакета, и удаление приёмки — именно в этих случаях вопрос «кто снял
-- claim» задают чаще всего. Каскад от source_bundles стёр бы записи ровно тогда,
-- когда они нужны.
CREATE TABLE IF NOT EXISTS "operation_group_claim_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_kind" text NOT NULL,
  "group_id" uuid NOT NULL,
  "operation_id" uuid,
  "event" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "operation_group_claim_events_kind_check"
    CHECK ("operation_kind" IN ('delivery', 'shipment')),
  CONSTRAINT "operation_group_claim_events_event_check"
    CHECK ("event" IN ('create', 'release', 'reclaim'))
);

CREATE INDEX IF NOT EXISTS "operation_group_claim_events_group_idx"
  ON "operation_group_claim_events" ("group_id", "created_at");

-- ── 3. Снятие delivery_group_claims ─────────────────────────────────────────
--
-- Гейт: удаляем только заведомо пустую таблицу. Если строки появились (значит,
-- кто-то успел написать в неё код), миграция обязана упасть — потеря claim
-- означала бы разрешение принять ту же машину повторно.
DO $$
DECLARE
  rows_left bigint;
BEGIN
  IF to_regclass('public.delivery_group_claims') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM delivery_group_claims' INTO rows_left;

  IF rows_left > 0 THEN
    RAISE EXCEPTION
      'delivery_group_claims содержит % строк — перенесите их в operation_group_claims вручную перед этой миграцией',
      rows_left;
  END IF;

  DROP TABLE delivery_group_claims;
END $$;
