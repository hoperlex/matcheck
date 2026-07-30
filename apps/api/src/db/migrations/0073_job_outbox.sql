-- Приём УПД из почты, этап 3 — transactional outbox для постановки задач в очередь.
--
-- Сегодня queue.add вызывается ПОСЛЕ коммита бизнес-транзакции (8 мест в
-- routes/worker). Падение Redis в этот момент оставляет пакет в статусе
-- 'queued' навсегда: повторная загрузка тех же файлов вернёт alreadyExists и
-- нового job не поставит. Строка в этой таблице пишется в ОДНОЙ транзакции с
-- пакетом, а consumer воркера доставляет её в BullMQ с ретраями.
--
-- dedupe_key — идентификатор ПОПЫТКИ диспетчеризации (bundle:<id>:parse:<gen>),
-- он же передаётся как jobId. Идентификатор сущности здесь не годится: BullMQ
-- держит завершённые jobs сутки (removeOnComplete), поэтому намеренный повтор
-- разбора в течение суток молча не запустился бы.
--
-- НЕДЕСТРУКТИВНО: новая таблица, на неё пока НИКТО не пишет — writers
-- переводятся отдельным этапом, уже после того как consumer проверен в проде.
-- CREATE TABLE и индексы по пустой таблице мгновенны (без длительных локов).

CREATE TABLE IF NOT EXISTS "job_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "queue" text NOT NULL,
  "job_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "dedupe_key" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "processing_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_outbox_dedupe_key_unique" ON "job_outbox" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outbox_ready_idx" ON "job_outbox" ("next_attempt_at") WHERE "processing_at" IS NULL;
