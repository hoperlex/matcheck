-- Волна 1D — transactional outbox для дочистки S3 при удалении приёмки/отгрузки.
--
-- Строки пишутся в ТОЙ ЖЕ транзакции, что и удаление операции, поэтому задание
-- на удаление S3-объектов не теряется при недоступности Redis/S3 в момент
-- удаления. Воркер обрабатывает строки батчем под FOR UPDATE SKIP LOCKED
-- (см. worker.ts), идемпотентно удаляет объект и убирает строку при успехе.
--
-- НЕДЕСТРУКТИВНО: новая таблица, существующие данные не затрагиваются. CREATE
-- TABLE и индекс по пустой таблице мгновенны (без длительных локов).

CREATE TABLE IF NOT EXISTS "s3_cleanup_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "s3_key" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "processing_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s3_cleanup_outbox_ready_idx" ON "s3_cleanup_outbox" ("next_attempt_at") WHERE "processing_at" IS NULL;
